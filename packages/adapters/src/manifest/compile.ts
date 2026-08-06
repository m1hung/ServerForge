import type { SettingsSchema } from '@serverforge/core';
import type {
  ConsoleGlossary,
  GameAdapter,
  LogInsight,
  ServerContext,
  StartupPlan,
  VersionInfo,
} from '../types.js';
import { steamAppUpdate, steamBranchFrom, steamBranchSettings } from '../util/steamcmd.js';
import { applyMaterialisation, planMaterialisation, type DerivedValue } from './materialise.js';
import { evaluateCondition, renderArgs, renderEnv, renderTemplate } from './template.js';
import { assertValidManifest } from './validate.js';
import type { GameManifest, ManifestVariant } from './types.js';

/**
 * Turns a manifest into a `GameAdapter`.
 *
 * The point of compiling rather than interpreting at each call site is that
 * nothing downstream can tell the difference. The registry, the deploy wizard,
 * the install worker and the console all keep talking to `GameAdapter`, so a
 * manifest game and a coded game are the same thing to every one of them —
 * and a manifest that outgrows the format can be replaced by a coded adapter
 * with no other change.
 */
export function compileManifest(manifest: GameManifest): GameAdapter {
  assertValidManifest(manifest);

  const variantsById = new Map<string, ManifestVariant>(
    manifest.variants.map((variant) => [variant.id, variant]),
  );

  const steamBranch =
    manifest.install.kind === 'steam' && manifest.install.branchSettings !== false;

  // Cached per variant. Both because building it repeatedly is wasted work,
  // and because a fresh array on every call hands React a new identity each
  // render, which it reads as "the settings changed".
  const schemaCache = new Map<string, SettingsSchema>();
  const schemaFor = (variantId: string): SettingsSchema => {
    const cached = schemaCache.get(variantId);
    if (cached) return cached;

    const built: SettingsSchema = [
      ...(variantsById.get(variantId)?.settings ?? []),
      ...manifest.settings,
      ...(steamBranch ? steamBranchSettings() : []),
    ];
    schemaCache.set(variantId, built);
    return built;
  };

  /** Config values computed per server — ports, mostly. See ManifestConfigValue. */
  const derivedFor = (ctx: ServerContext): DerivedValue[] =>
    (manifest.configValues ?? []).map((entry) => ({
      target: entry.target,
      value: renderTemplate(entry.value, ctx),
    }));

  const versionLabel = manifest.versionLabel ?? 'Latest (kept up to date from Steam)';
  const onlyVersion: VersionInfo = { id: 'latest', label: versionLabel, stable: true };

  const adapter: GameAdapter = {
    id: manifest.id,
    name: manifest.name,
    summary: manifest.summary,
    icon: manifest.icon,
    variants: manifest.variants.map(stripManifestOnlyFields),

    defaultLimits(variantId) {
      return variantsById.get(variantId)?.limits ?? manifest.limits;
    },

    requiredPorts() {
      return manifest.ports.map((port) => ({ purpose: port.purpose, protocol: port.protocol }));
    },

    settingsSchema(variantId) {
      return schemaFor(variantId);
    },

    ...(manifest.eula ? { eula: () => manifest.eula ?? null } : {}),

    async listVersions() {
      return [onlyVersion];
    },

    async resolveVersion() {
      return onlyVersion;
    },

    async install(ctx, tools, report) {
      await report.phase('preparing', 'Creating the server folder…', 5);
      await tools.mkdir('.');

      if (manifest.install.kind === 'steam') {
        await report.phase(
          'downloading',
          manifest.install.message ??
            `Downloading ${manifest.name} from Steam — this can take a while…`,
          15,
        );
        await steamAppUpdate(tools, {
          appId: manifest.install.appId,
          validate: true,
          ...steamBranchFrom(ctx.settings),
          report: (message) => report.log(message),
        });
      } else {
        const url = renderTemplate(manifest.install.url, ctx);
        await report.phase(
          'downloading',
          manifest.install.message ?? `Downloading ${manifest.name}…`,
          15,
        );
        await tools.download(url, '.download.zip');
        await report.phase('extracting', 'Unpacking…', 60);
        await tools.unzip('.download.zip', manifest.install.dest ?? '.', {
          strip: manifest.install.strip,
        });
        await tools.remove('.download.zip');
      }

      for (const step of manifest.postInstall ?? []) {
        if (step.variants && !step.variants.includes(ctx.variantId)) continue;
        if (step.when && !evaluateCondition(step.when, ctx)) continue;

        if (step.message) await report.phase('extracting', step.message, 85);
        if (step.mkdir) await tools.mkdir(step.mkdir);
        if (step.copyFile) {
          const { from, to, ifMissing = true } = step.copyFile;
          // Not overwriting by default: a reinstall must not throw away the
          // edits someone made in the file manager.
          if (!ifMissing || !(await tools.exists(to))) {
            const contents = await tools.readFile(from);
            if (contents !== null) await tools.writeFile(to, contents);
          }
        }
        if (step.writeFile) {
          await tools.writeFile(step.writeFile.path, renderTemplate(step.writeFile.contents, ctx));
        }
      }

      await report.phase('configuring', 'Writing your settings…', 92);
      await adapter.applySettings(ctx, tools);

      await report.phase('finalizing', 'Ready to start.', 100);
    },

    async applySettings(ctx, tools) {
      await applyMaterialisation(
        planMaterialisation(schemaFor(ctx.variantId), ctx, derivedFor(ctx)),
        tools,
      );
    },

    startup(ctx): StartupPlan {
      // Settings targeting `env` are applied here rather than in
      // applySettings: they are not files, and startup() is the only place
      // that can put them on the container.
      const fromSettings = planMaterialisation(schemaFor(ctx.variantId), ctx, derivedFor(ctx)).env;

      return {
        image: manifest.runtime.image,
        command: renderArgs(manifest.runtime.command, ctx),
        workingDir: manifest.runtime.workingDir,
        env: {
          ...renderEnv(manifest.runtime.env, ctx),
          ...fromSettings,
          // The server's own environment wins: an operator overriding a value
          // by hand is being deliberate, and should not be silently reverted.
          ...ctx.environment,
        },
        ports: manifest.runtime.ports.map((port) => ({
          containerPort: port.containerPort,
          purpose: port.purpose,
          protocol: port.protocol,
          ...(port.fixed ? { fixed: true } : {}),
        })),
        ...(manifest.runtime.stopCommand ? { stopCommand: manifest.runtime.stopCommand } : {}),
        stopTimeoutSeconds: manifest.runtime.stopTimeoutSeconds,
        ...(manifest.runtime.readyPattern ? { readyPattern: manifest.runtime.readyPattern } : {}),
      };
    },

    ...compileLogInspection(manifest),

    modDirectory(variantId) {
      return variantsById.get(variantId)?.modDirectory ?? null;
    },

    ...(manifest.console
      ? { consoleGlossary: (): ConsoleGlossary => manifest.console as ConsoleGlossary }
      : {}),
  };

  return adapter;
}

/**
 * Builds `inspectLog` and the `reportsPlayers` claim from the rule list.
 *
 * The two are derived together on purpose: `reportsPlayers` is what stops the
 * panel showing an empty player list for a game that never reports names, and
 * deriving it from whether any rule actually produces a `playerEvent` is the
 * only way the claim cannot drift from the behaviour.
 */
function compileLogInspection(
  manifest: GameManifest,
): Pick<GameAdapter, 'inspectLog' | 'reportsPlayers'> {
  const rules = manifest.logRules ?? [];
  if (rules.length === 0) return {};

  const compiled = rules.map((rule) => ({ rule, regex: new RegExp(rule.pattern, 'i') }));
  const reportsPlayers = rules.some((rule) => rule.playerEvent);

  return {
    reportsPlayers,
    inspectLog(line: string): LogInsight | null {
      for (const { rule, regex } of compiled) {
        const match = regex.exec(line);
        if (!match) continue;

        const insight: LogInsight = { level: rule.level };
        if (rule.hint) insight.hint = rule.hint;
        if (rule.ready) insight.ready = true;

        if (rule.playerEvent) {
          const name = match[rule.playerEvent.nameGroup]?.trim();
          // A rule that matched but captured nothing must not report a
          // nameless player — skip to the next rule instead, which is how a
          // near-miss on a join line still gets classified as ordinary output.
          if (!name) continue;
          insight.playerEvent = { type: rule.playerEvent.type, name };
        }

        return insight;
      }
      return null;
    },
  };
}

/**
 * Drops the manifest-only fields so the variant matches `GameVariant`.
 *
 * Not cosmetic: `variants` is serialised into the catalogue the deploy wizard
 * fetches, so anything left here is shipped to every browser. A whole settings
 * schema riding along would be both wasted bytes and a leak of internals the
 * client has its own endpoint for.
 */
function stripManifestOnlyFields(variant: ManifestVariant) {
  const {
    limits: _limits,
    modDirectory: _modDirectory,
    settings: _settings,
    ...rest
  } = variant;
  return rest;
}

export type { GameManifest };
