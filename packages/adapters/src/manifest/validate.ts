import type { SettingsSchema } from '@serverforge/core';
import { extractRefs, KNOWN_FILTERS } from './template.js';
import { MANIFEST_VERSION, type GameManifest, type ManifestArg } from './types.js';

/**
 * Manifest validation.
 *
 * These messages are the entire developer experience of the format — someone
 * adding a game has no types, no compiler and no debugger, just a JSON file
 * and whatever this says. So each one names the field, says what is wrong, and
 * where practical says what the valid options are.
 *
 * Everything is checked up front rather than at first use. A manifest with a
 * typo in a settings key should fail when it is loaded, not three minutes into
 * an install when the startup template resolves it to an empty string.
 */

export class ManifestError extends Error {
  constructor(
    readonly manifestId: string,
    readonly issues: string[],
  ) {
    super(
      `The game manifest "${manifestId}" cannot be loaded:\n${issues.map((i) => `  • ${i}`).join('\n')}`,
    );
    this.name = 'ManifestError';
  }
}

export function validateManifest(manifest: GameManifest): string[] {
  const issues: string[] = [];
  const need = (condition: boolean, message: string) => {
    if (!condition) issues.push(message);
  };

  // ── Shape ───────────────────────────────────────────────────────────────
  need(
    manifest.manifestVersion === MANIFEST_VERSION,
    `manifestVersion must be ${MANIFEST_VERSION}, not ${JSON.stringify(manifest.manifestVersion)}. This panel does not know how to read other versions.`,
  );
  need(/^[a-z0-9][a-z0-9-]*$/.test(manifest.id ?? ''), 'id must be a lowercase slug, e.g. "valheim".');
  need(Boolean(manifest.name?.trim()), 'name is required.');
  need(Boolean(manifest.summary?.trim()), 'summary is required — it is what the game picker shows.');
  need(Boolean(manifest.icon?.trim()), 'icon is required. Use a Lucide icon name, e.g. "Axe".');

  // ── Variants ────────────────────────────────────────────────────────────
  const variants = manifest.variants ?? [];
  need(variants.length > 0, 'at least one variant is required.');

  const variantIds = new Set<string>();
  for (const variant of variants) {
    if (variantIds.has(variant.id)) issues.push(`two variants share the id "${variant.id}".`);
    variantIds.add(variant.id);
    need(Boolean(variant.summary?.trim()), `variant "${variant.id}" needs a summary a beginner can choose on.`);
  }

  const recommended = variants.filter((v) => v.recommended);
  need(
    recommended.length <= 1,
    `only one variant may be "recommended"; ${recommended.length} are marked.`,
  );

  // ── Ports ───────────────────────────────────────────────────────────────
  const ports = manifest.ports ?? [];
  need(ports.length > 0, 'at least one port is required.');
  const purposes = new Set(ports.map((p) => p.purpose));
  need(purposes.size === ports.length, 'two ports share the same purpose; purposes must be unique.');

  // ── Settings ────────────────────────────────────────────────────────────
  const settings: SettingsSchema = manifest.settings ?? [];
  const settingKeys = new Set(settings.map((s) => s.key));
  if (settingKeys.size !== settings.length) {
    issues.push('two settings share the same key.');
  }
  for (const setting of settings) {
    if (setting.showWhen && !settingKeys.has(setting.showWhen.key)) {
      issues.push(
        `setting "${setting.key}" is shown when "${setting.showWhen.key}" has a value, but no setting has that key.`,
      );
    }
  }

  // ── Templates ───────────────────────────────────────────────────────────
  //
  // The important check in this file: a reference to a setting that does not
  // exist renders as empty, which starts the game with a missing flag rather
  // than reporting anything.
  const checkTemplate = (template: string, where: string) => {
    for (const { ref, filter } of extractRefs(template)) {
      if (filter && !KNOWN_FILTERS.includes(filter)) {
        issues.push(
          `${where} uses the unknown filter "|${filter}". Known filters: ${KNOWN_FILTERS.join(', ')}.`,
        );
      }
      checkRef(ref, where, settingKeys, purposes, issues);
    }
  };

  const runtime = manifest.runtime;
  if (!runtime) {
    issues.push('runtime is required — without it there is nothing to launch.');
  } else {
    need(Boolean(runtime.image?.trim()), 'runtime.image is required.');
    need(Boolean(runtime.workingDir?.trim()), 'runtime.workingDir is required.');
    need(
      typeof runtime.stopTimeoutSeconds === 'number' && runtime.stopTimeoutSeconds > 0,
      'runtime.stopTimeoutSeconds must be a positive number of seconds.',
    );

    for (const [index, arg] of (runtime.command ?? []).entries()) {
      checkArg(arg, `runtime.command[${index}]`, checkTemplate, settingKeys, purposes, issues);
    }

    for (const [key, value] of Object.entries(runtime.env ?? {})) {
      checkTemplate(value, `runtime.env.${key}`);
    }

    for (const port of runtime.ports ?? []) {
      if (!purposes.has(port.purpose)) {
        issues.push(
          `runtime.ports maps the purpose "${port.purpose}", which is not one of the ports this game reserves (${[...purposes].join(', ')}).`,
        );
      }
    }

    if (runtime.readyPattern) checkRegex(runtime.readyPattern, 'runtime.readyPattern', issues);
  }

  // ── Install ─────────────────────────────────────────────────────────────
  const install = manifest.install;
  if (!install) {
    issues.push('install is required.');
  } else if (install.kind === 'steam') {
    need(/^\d+$/.test(install.appId ?? ''), 'install.appId must be the numeric Steam app id of the dedicated server.');
  } else if (install.kind === 'download') {
    need(
      typeof install.url === 'string' && install.url.startsWith('https://'),
      'install.url must be an https URL.',
    );
    if (install.url) checkTemplate(install.url, 'install.url');
  } else {
    issues.push(`install.kind must be "steam" or "download".`);
  }

  for (const [index, step] of (manifest.postInstall ?? []).entries()) {
    for (const variantId of step.variants ?? []) {
      if (!variantIds.has(variantId)) {
        issues.push(`postInstall[${index}] names the variant "${variantId}", which this game does not have.`);
      }
    }
    if (!step.mkdir && !step.writeFile) {
      issues.push(`postInstall[${index}] does nothing — give it mkdir or writeFile.`);
    }
    if (step.writeFile) checkTemplate(step.writeFile.contents, `postInstall[${index}].writeFile.contents`);
  }

  // ── Log rules ───────────────────────────────────────────────────────────
  for (const [index, rule] of (manifest.logRules ?? []).entries()) {
    const compiled = checkRegex(rule.pattern, `logRules[${index}].pattern`, issues);

    // A rule claiming to report players must actually capture one. Without
    // this the panel shows a permanently empty player list, which reads as
    // "nobody is playing" rather than "this is broken".
    if (rule.playerEvent && compiled) {
      const groups = countGroups(rule.pattern);
      if (rule.playerEvent.nameGroup < 1 || rule.playerEvent.nameGroup > groups) {
        issues.push(
          `logRules[${index}] reads the player name from capture group ${rule.playerEvent.nameGroup}, but the pattern has ${groups}.`,
        );
      }
    }
  }

  return issues;
}

function checkArg(
  arg: ManifestArg,
  where: string,
  checkTemplate: (template: string, where: string) => void,
  settingKeys: Set<string>,
  purposes: Set<string>,
  issues: string[],
): void {
  if (typeof arg === 'string') {
    checkTemplate(arg, where);
    return;
  }

  if (!arg.when?.ref) {
    issues.push(`${where} is a conditional group with no "when.ref".`);
    return;
  }

  checkRef(arg.when.ref, `${where}.when.ref`, settingKeys, purposes, issues);
  for (const [index, inner] of (arg.args ?? []).entries()) {
    checkTemplate(inner, `${where}.args[${index}]`);
  }
}

const BARE_REFS = [
  'serverUid',
  'serverName',
  'version',
  'variantId',
  'memoryMib',
  'cpuCores',
  'dataPath',
];

function checkRef(
  ref: string,
  where: string,
  settingKeys: Set<string>,
  purposes: Set<string>,
  issues: string[],
): void {
  if (ref.startsWith('setting.')) {
    const key = ref.slice('setting.'.length);
    if (!settingKeys.has(key)) {
      issues.push(`${where} refers to the setting "${key}", which this manifest does not define.`);
    }
    return;
  }

  if (ref.startsWith('port.')) {
    const purpose = ref.slice('port.'.length);
    if (!purposes.has(purpose)) {
      issues.push(
        `${where} refers to the port "${purpose}", which this manifest does not reserve. Reserved: ${[...purposes].join(', ')}.`,
      );
    }
    return;
  }

  // Environment lookups are open-ended by design: the operator supplies them.
  if (ref.startsWith('env.')) return;

  if (!BARE_REFS.includes(ref)) {
    issues.push(`${where} refers to "${ref}", which is not a known value. Known: ${BARE_REFS.join(', ')}, setting.*, port.*, env.*.`);
  }
}

function checkRegex(pattern: string, where: string, issues: string[]): boolean {
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch (error) {
    issues.push(`${where} is not a valid regular expression: ${(error as Error).message}`);
    return false;
  }
}

/** Counts capturing groups, ignoring `(?:…)`, `(?<…>…)` lookarounds and escapes. */
function countGroups(pattern: string): number {
  let count = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char !== '(') continue;
    const next = pattern[i + 1];
    if (next !== '?') {
      count += 1;
      continue;
    }
    // `(?<name>` is a capturing group; `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!` are not.
    if (pattern[i + 2] === '<' && pattern[i + 3] !== '=' && pattern[i + 3] !== '!') count += 1;
  }
  return count;
}

/** Validates and throws, for load paths that cannot continue with a bad manifest. */
export function assertValidManifest(manifest: GameManifest): void {
  const issues = validateManifest(manifest);
  if (issues.length > 0) throw new ManifestError(manifest.id ?? '(no id)', issues);
}
