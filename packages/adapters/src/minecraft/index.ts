import type { SettingValues } from '@serverforge/core';
import type {
  EulaRequirement,
  GameAdapter,
  GameVariant,
  InstallTools,
  LogInsight,
  ServerContext,
  StartupPlan,
  VersionInfo,
} from '../types.js';
import { mergeProperties, stringifyProperties } from '../util/properties.js';
import { minecraftConsoleGlossary } from './console-commands.js';
import { minecraftSettingsSchema } from './settings.js';
import { buildJavaFlags, javaImageFor, javaMajorFor, type JavaFlagsPreset } from './java.js';
import {
  listFabricVersions,
  listForgeVersions,
  listNeoForgeVersions,
  listPaperVersions,
  listPurpurVersions,
  listVanillaVersions,
  resolveFabricDownload,
  resolveForgeDownload,
  resolveNeoForgeDownload,
  resolvePaperDownload,
  resolvePurpurDownload,
  requiredJavaMajor,
  resolveVanillaDownload,
  type ResolvedDownload,
} from './versions.js';
import { SERVER_STARTER_JAR_URL, installCustomPack, installModrinthPack } from './modpacks.js';

const VARIANTS: GameVariant[] = [
  {
    id: 'paper',
    name: 'Paper',
    summary: 'Vanilla gameplay, much better performance, supports plugins.',
    detail:
      'Paper is what most public servers run. It behaves like vanilla Minecraft for players, but handles many more people on the same hardware and accepts plugins for things like permissions, land claims and anti-grief.',
    order: 1,
    recommended: true,
    tags: ['Most popular', 'Plugins'],
    supportsMods: true,
    modLoader: 'paper',
  },
  {
    id: 'vanilla',
    name: 'Vanilla',
    summary: "Mojang's official server. Exactly the game as shipped.",
    detail:
      'Choose this if you want the pure, unmodified game and do not plan to add plugins or mods. It is the slowest option under load.',
    order: 2,
    supportsMods: false,
    modLoader: 'none',
  },
  {
    id: 'purpur',
    name: 'Purpur',
    summary: 'Paper plus hundreds of optional gameplay tweaks.',
    detail:
      'Purpur is built on Paper, so every Paper plugin works. It adds configuration for things vanilla does not let you change — ridable mobs, custom mechanics, per-world rules.',
    order: 3,
    tags: ['Customisable'],
    supportsMods: true,
    modLoader: 'paper',
  },
  {
    id: 'fabric',
    name: 'Fabric',
    summary: 'Lightweight mod loader. Updates to new Minecraft versions fast.',
    detail:
      'Fabric is the modern choice for mods. Every player also needs Fabric and the same mods installed on their own game.',
    order: 4,
    tags: ['Mods'],
    supportsMods: true,
    modLoader: 'fabric',
  },
  {
    id: 'neoforge',
    name: 'NeoForge',
    summary: 'The actively developed successor to Forge, for modern versions.',
    detail:
      'NeoForge forked from Forge in 2023 and is where most large modpacks for 1.20.2 and newer have moved. Players need NeoForge and the same mods installed.',
    order: 5,
    tags: ['Mods'],
    supportsMods: true,
    modLoader: 'neoforge',
  },
  {
    id: 'forge',
    name: 'Forge',
    summary: 'The long-established mod loader. Best for older modpacks.',
    detail:
      'Pick Forge when a modpack specifically asks for it, which is common for packs built on 1.20.1 and earlier.',
    order: 6,
    tags: ['Mods'],
    supportsMods: true,
    modLoader: 'forge',
  },
  {
    id: 'modrinth-modpack',
    name: 'Modrinth modpack',
    summary: 'Paste a Modrinth pack and we install the whole thing for you.',
    detail:
      'We download the pack, install the right loader and Minecraft version automatically, and place every server-side mod. You do not need to know which loader it uses.',
    order: 7,
    tags: ['One click', 'Modpack'],
    supportsMods: true,
    modLoader: 'fabric',
  },
  {
    id: 'custom-modpack',
    name: 'Modpack from a .zip',
    summary: 'Upload a CurseForge-style server pack and we set it up.',
    detail:
      'Works with the "server pack" download that most CurseForge modpacks provide. You choose the .zip (or a download link) before the server is created.',
    order: 8,
    tags: ['Modpack', 'Manual'],
    supportsMods: true,
    modLoader: 'forge',
  },
];

const EULA: EulaRequirement = {
  key: 'minecraft-eula',
  label: 'I accept the Minecraft End User Licence Agreement',
  url: 'https://aka.ms/MinecraftEULA',
  file: 'eula.txt',
  contents: '# Accepted through ServerForge\neula=true\n',
};

export const minecraftAdapter: GameAdapter = {
  id: 'minecraft-java',
  name: 'Minecraft: Java Edition',
  summary: 'The PC version of Minecraft. Plugins, mods and modpacks supported.',
  icon: 'Box',
  variants: VARIANTS,

  defaultLimits(variantId) {
    // Modded servers need materially more memory than plugin servers, and
    // guessing low here is how people end up with a crash loop on day one.
    const modded = ['forge', 'neoforge', 'fabric', 'modrinth-modpack', 'custom-modpack'];
    if (modded.includes(variantId)) return { memoryMib: 6144, cpuCores: 2, diskMib: 20480 };
    return { memoryMib: 4096, cpuCores: 2, diskMib: 10240 };
  },

  requiredPorts() {
    return [
      { purpose: 'game', protocol: 'tcp' },
      { purpose: 'rcon', protocol: 'tcp' },
    ];
  },

  settingsSchema(variantId) {
    return minecraftSettingsSchema(variantId);
  },

  eula() {
    return EULA;
  },

  async listVersions(variantId): Promise<VersionInfo[]> {
    switch (variantId) {
      case 'paper':
        return listPaperVersions('paper');
      case 'purpur':
        return listPurpurVersions();
      case 'fabric':
        return listFabricVersions();
      case 'neoforge':
        return listNeoForgeVersions();
      case 'forge':
        return listForgeVersions();
      case 'modrinth-modpack':
      case 'custom-modpack':
        // The pack itself pins the Minecraft version.
        return [{ id: 'from-pack', label: 'Decided by the modpack', stable: true }];
      case 'vanilla':
      default:
        return listVanillaVersions();
    }
  },

  async resolveVersion(variantId, version): Promise<VersionInfo> {
    if (variantId === 'modrinth-modpack' || variantId === 'custom-modpack') {
      return { id: version === 'latest' ? 'from-pack' : version, label: 'From modpack', stable: true };
    }

    const versions = await this.listVersions(variantId);
    if (version === 'latest') {
      const stable = versions.find((v) => v.stable) ?? versions[0];
      if (!stable) throw new Error(`No versions available for ${variantId}`);
      return stable;
    }
    const exact = versions.find((v) => v.id === version);
    if (!exact) throw new Error(`Version ${version} is not available for ${variantId}`);
    return exact;
  },

  async install(ctx, tools, report) {
    await report.phase('preparing', 'Creating the server folder…', 5);
    await tools.mkdir('.');

    // The EULA is accepted in the deploy wizard; writing it here means the
    // first start does not fail with the notorious "You need to agree" line.
    await tools.writeFile(EULA.file, EULA.contents);

    if (ctx.variantId === 'modrinth-modpack') {
      await installModrinthPack(ctx, tools, report);
    } else if (ctx.variantId === 'custom-modpack') {
      await installCustomPack(ctx, tools, report);
    } else {
      await report.phase('resolving_version', `Looking up ${ctx.variantId} ${ctx.version}…`, 10);
      const download = await resolveDownload(ctx.variantId, ctx.version, ctx.build ?? undefined);

      await report.phase('downloading', `Downloading ${download.fileName}…`, 25);
      // Whichever digest the upstream publishes is verified; Mojang gives
      // SHA-1, PaperMC gives SHA-256, Modrinth gives SHA-512.
      await tools.download(download.url, download.fileName, {
        ...(download.sha1 ? { sha1: download.sha1 } : {}),
        ...(download.sha256 ? { sha256: download.sha256 } : {}),
        ...(download.sha512 ? { sha512: download.sha512 } : {}),
      });

      if (download.installer) {
        await report.phase(
          'extracting',
          'Running the loader installer — this takes a couple of minutes…',
          55,
        );
        await runLoaderInstaller(ctx, tools, download.fileName);
      }
    }

    await report.phase('configuring', 'Writing your settings…', 85);
    await this.applySettings(ctx, tools);

    await report.phase('finalizing', 'Ready to start.', 100);
  },

  async applySettings(ctx, tools) {
    const schema = minecraftSettingsSchema(ctx.variantId);
    const props: Record<string, string> = {};

    for (const setting of schema) {
      if (setting.target.kind !== 'properties') continue;
      const value = ctx.settings[setting.key];
      if (value === undefined) continue;
      props[setting.target.key] = String(value);
    }

    // The panel owns the port: users change it through the allocation UI,
    // never by hand-editing the file, so it is always overwritten.
    const game = ctx.allocations.find((a) => a.purpose === 'game') ?? ctx.allocations[0];
    if (game) props['server-port'] = String(game.port);
    const rcon = ctx.allocations.find((a) => a.purpose === 'rcon');
    if (rcon) props['rcon.port'] = String(rcon.port);
    props['server-ip'] = '';

    const existing = await tools.readFile('server.properties');
    const contents = existing
      ? mergeProperties(existing, props)
      : stringifyProperties(props, 'Managed by ServerForge. Hand edits are preserved.');

    await tools.writeFile('server.properties', contents);
    await tools.writeFile(EULA.file, EULA.contents);
  },

  /**
   * Mojang publishes the required Java major per version, and it is the only
   * source that stays correct as the game moves (1.20.5 needed 21, 26.1 needs
   * 25). Guessing from the version string is a fallback, not the plan.
   */
  async detectRuntime(_variantId, version) {
    if (version === 'from-pack' || version === 'latest') return null;
    try {
      return await requiredJavaMajor(version);
    } catch {
      // Upstream is unreachable — the heuristic in `startup()` takes over
      // rather than blocking an install that is otherwise fine.
      return null;
    }
  },

  startup(ctx): StartupPlan {
    const loader = ctx.variantId;
    // The recorded value wins; the heuristic only covers servers installed
    // before detection existed, or a version Mojang did not describe.
    const javaMajor =
      ctx.runtimeMajor ?? javaMajorFor(ctx.version === 'from-pack' ? '1.21' : ctx.version, loader);
    const flags = buildJavaFlags({
      preset: (ctx.javaFlagsPreset as JavaFlagsPreset) ?? 'balanced',
      memoryMib: ctx.memoryMib,
      custom: ctx.customJavaFlags ?? null,
    });

    const game = ctx.allocations.find((a) => a.purpose === 'game') ?? ctx.allocations[0];

    return {
      image: javaImageFor(javaMajor),
      command: [
        'java',
        ...flags,
        // Headless avoids the JVM trying to open the (nonexistent) server GUI.
        '-Djava.awt.headless=true',
        '-Dlog4j2.formatMsgNoLookups=true',
        '-jar',
        SERVER_JAR,
        'nogui',
      ],
      workingDir: '/home/container',
      env: {
        ...ctx.environment,
        SERVER_PORT: String(game?.port ?? 25565),
        // Minecraft logs are line-buffered already; this keeps timestamps sane.
        TZ: ctx.environment.TZ ?? 'UTC',
      },
      ports: [
        { containerPort: 25565, purpose: 'game', protocol: 'tcp' },
        { containerPort: 25575, purpose: 'rcon', protocol: 'tcp' },
      ],
      /**
       * Minecraft reads stdin perfectly well, so RCON is an upgrade rather
       * than a requirement: it hands back what the command printed, which
       * stdin cannot. `list` in the panel console then shows the player list
       * as a reply instead of relying on the server also logging it.
       *
       * Gated on the user's own settings, so this changes nothing until they
       * turn RCON on and set a password — at which point commands start
       * answering.
       */
      console: {
        transport: 'rcon',
        portPurpose: 'rcon',
        enabledSetting: 'enable-rcon',
        passwordSetting: 'rcon.password',
      },
      // Minecraft flushes chunks on `stop`; killing it instead risks
      // corrupting the region files the player just built in.
      stopCommand: 'stop\n',
      stopTimeoutSeconds: 120,
      readyPattern: 'Done \\([0-9.]+s\\)! For help, type "help"',
    };
  },

  reportsPlayers: true,

  inspectLog(line): LogInsight | null {
    if (/Done \([0-9.]+s\)! For help/.test(line)) {
      return { level: 'success', ready: true, hint: 'Server is accepting players.' };
    }
    if (/You need to agree to the EULA/i.test(line)) {
      return {
        level: 'error',
        hint: 'Minecraft needs the EULA accepted. Open Settings and toggle "Accept the Minecraft EULA", then start again.',
      };
    }
    if (/java\.lang\.OutOfMemoryError/.test(line)) {
      return {
        level: 'error',
        hint: 'The server ran out of memory. Raise the memory limit in Settings, or lower view distance.',
      };
    }
    // Modern Minecraft refuses to boot on an old JVM with this exact line.
    const javaTooOld = /requires running the server with Java (\d+)/i.exec(line);
    if (javaTooOld) {
      return {
        level: 'error',
        hint: `This version needs Java ${javaTooOld[1]} but the server started on an older one. Reinstall the server and it will pick up the right Java version.`,
      };
    }
    if (/UnsupportedClassVersionError/.test(line)) {
      return {
        level: 'error',
        hint: 'This Minecraft version needs a different Java version than the one running. Reinstalling the server fixes this.',
      };
    }
    if (/FAILED TO BIND TO PORT/i.test(line)) {
      return {
        level: 'error',
        hint: 'Another program is already using this port. Change the port under Network.',
      };
    }
    if (/Can't keep up!.*Running ([0-9]+)ms/.test(line)) {
      return {
        level: 'warn',
        hint: 'The server is falling behind. Lower view distance or simulation distance, or give it more CPU.',
      };
    }
    const join = /^.*: ([A-Za-z0-9_]{3,16}) joined the game/.exec(line);
    if (join?.[1]) return { level: 'info', playerEvent: { type: 'join', name: join[1] } };
    const leave = /^.*: ([A-Za-z0-9_]{3,16}) left the game/.exec(line);
    if (leave?.[1]) return { level: 'info', playerEvent: { type: 'leave', name: leave[1] } };

    if (/\[ERROR\]|Exception in thread/.test(line)) return { level: 'error' };
    if (/\[WARN\]/.test(line)) return { level: 'warn' };
    return null;
  },

  modDirectory(variantId) {
    if (variantId === 'paper' || variantId === 'purpur') return 'plugins';
    if (['fabric', 'forge', 'neoforge', 'modrinth-modpack', 'custom-modpack'].includes(variantId)) {
      return 'mods';
    }
    return null;
  },

  consoleGlossary() {
    return minecraftConsoleGlossary();
  },
};

async function resolveDownload(
  variantId: string,
  version: string,
  build?: string,
): Promise<ResolvedDownload> {
  switch (variantId) {
    case 'paper':
      return resolvePaperDownload(version, build);
    case 'purpur':
      return resolvePurpurDownload(version, build);
    case 'fabric':
      return resolveFabricDownload(version, build);
    case 'neoforge':
      return resolveNeoForgeDownload(version, build);
    case 'forge':
      return resolveForgeDownload(version, build);
    case 'vanilla':
    default:
      return resolveVanillaDownload(version);
  }
}

/**
 * Forge and NeoForge ship an installer jar that generates the real launch
 * files. It has to run with a JVM, so we borrow a throwaway container.
 */
async function runLoaderInstaller(
  ctx: ServerContext,
  tools: InstallTools,
  installerJar: string,
): Promise<void> {
  const javaMajor = javaMajorFor(ctx.version, ctx.variantId);
  const result = await tools.runInContainer({
    image: javaImageFor(javaMajor),
    command: ['java', '-jar', installerJar, '--installServer'],
    timeoutMs: 10 * 60 * 1000,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `The ${ctx.variantId} installer failed (exit ${result.exitCode}).\n${result.output.slice(-4000)}`,
    );
  }

  await tools.remove(installerJar);
  await tools.remove(`${installerJar}.log`);

  await normaliseLoaderEntryPoint(ctx, tools);
}

/**
 * Gives both loader layouts the single `server.jar` the startup command names.
 *
 * This used to be a comment above the two `remove` calls claiming the work was
 * done, and nothing did it. What the installer leaves depends on the Minecraft
 * version, and neither shape is `server.jar`:
 *
 *   ≤ 1.16   a launchable `forge-<mc>-<ver>.jar` next to the world data
 *   ≥ 1.17   `run.sh` plus `libraries/…/unix_args.txt`, and no fat jar at all
 *
 * The old layout only needs renaming. The new one cannot be renamed into
 * shape — the server jar under `libraries/` is not self-contained, and the
 * real entry point is an argument file. NeoForge's ServerStarterJar exists for
 * exactly this: it is a real jar whose first act is to run `run.sh`, so
 * dropping it in as `server.jar` makes the uniform command work again.
 */
export async function normaliseLoaderEntryPoint(ctx: ServerContext, tools: InstallTools): Promise<void> {
  if (await tools.exists('server.jar')) return;

  const root = await tools.listDir('.');
  const fatJar = root.find(
    (name) => /^(forge|neoforge)-.*\.jar$/i.test(name) && !/-(installer|sources|javadoc)\.jar$/i.test(name),
  );

  if (fatJar) {
    await tools.rename(fatJar, 'server.jar');
    return;
  }

  if (await tools.exists('run.sh')) {
    await tools.download(SERVER_STARTER_JAR_URL, 'server.jar');
    return;
  }

  // Neither shape appeared. Saying so here names the installer as the culprit;
  // the alternative is a container exiting with "Unable to access jarfile
  // server.jar", which points at nothing.
  throw new Error(
    `The ${ctx.variantId} installer finished but left nothing to launch — no loader jar and no run.sh.\n\n` +
      `The server folder contains: ${root.slice(0, 20).join(', ')}`,
  );
}

/**
 * Which jar the container launches — the same one for every variant.
 *
 * Vanilla and the Paper family download it under this name already, and
 * `normaliseLoaderEntryPoint` gives the Forge/NeoForge layouts the same shape
 * after their installer runs. That is what lets `startup()` stay a pure
 * function of the context: it never has to look at the disk to find out what
 * it is launching.
 */
const SERVER_JAR = 'server.jar';

export { minecraftSettingsSchema };
export type { SettingValues };
