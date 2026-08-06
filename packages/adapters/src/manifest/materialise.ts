import { isSettingActive, type Setting, type SettingValue, type SettingsSchema } from '@serverforge/core';
import type { InstallTools, ServerContext } from '../types.js';
import {
  parseIni,
  parseTuple,
  quoteUnreal,
  stringifyIni,
  stringifyTuple,
  unrealBool,
  unrealFloat,
} from '../util/ini.js';
import { mergeProperties } from '../util/properties.js';

/**
 * Writes settings into a game's own config files, driven by the schema.
 *
 * Every setting already declares *where* its value belongs — that is what
 * `SettingTarget` is for — so a per-game `applySettings` is mostly a
 * hand-written interpreter of data the schema already carries. This is that
 * interpreter, written once.
 *
 * The rule throughout is round-trip safety: read what is on disk, overwrite
 * only the keys the schema models, write it back. Anything a game update adds
 * to its own config survives, which is the difference between a panel that
 * manages a config file and one that periodically destroys it.
 */

/** Formats a value the way config files expect it. */
function format(value: SettingValue): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

export interface MaterialisePlan {
  /** Relative path -> the keys to set in it. */
  properties: Map<string, Record<string, string>>;
  ini: Map<string, Map<string, Record<string, string>>>;
  /** file -> section -> outer key -> fields inside the parenthesised value. */
  tuples: Map<string, Map<string, Map<string, Record<string, string>>>>;
  json: Map<string, Map<string, SettingValue>>;
  /** Settings targeting the container environment rather than a file. */
  env: Record<string, string>;
}

/**
 * A value written to a config file that is not a user setting.
 *
 * The common case is a port: the game's own config has to name the port the
 * allocator handed out, or the server comes up listening somewhere nothing is
 * published to and looks online while refusing every connection.
 */
export interface DerivedValue {
  target: Setting['target'];
  /** Already rendered — the compiler resolves templates before calling. */
  value: string;
}

/**
 * Groups the active settings by the file they land in.
 *
 * Split out from the writing so it can be tested without a filesystem, and so
 * the compiler can hand the env portion to `startup()` — which is synchronous
 * and cannot read anything.
 */
export function planMaterialisation(
  schema: SettingsSchema,
  ctx: ServerContext,
  derived: DerivedValue[] = [],
): MaterialisePlan {
  const plan: MaterialisePlan = {
    properties: new Map(),
    ini: new Map(),
    tuples: new Map(),
    json: new Map(),
    env: {},
  };

  for (const setting of schema) {
    // A setting hidden by its own `showWhen` guard is not merely invisible —
    // it must not be written, or turning an option off would leave its
    // children silently in force in the game's config.
    if (!isSettingActive(setting, ctx.settings)) continue;

    const value = ctx.settings[setting.key];
    if (value === undefined) continue;

    writeInto(plan, setting.target, formatFor(setting, value), value);
  }

  // Derived values last, so a computed port beats a stale one a user typed.
  for (const { target, value } of derived) writeInto(plan, target, value, coerceJson(value));

  return plan;
}

/**
 * Renders a value the way its destination expects.
 *
 * Unreal is the reason this depends on the setting rather than the value:
 * inside a tuple it wants strings quoted, booleans as `True`/`False`, and
 * floats to six decimal places, while an integer field written as `1.000000`
 * is rejected. `step` is what distinguishes a rate from a count in the schema.
 */
function formatFor(setting: Setting, value: SettingValue): string {
  const inTuple = setting.target.kind === 'ini' && Boolean(setting.target.tuple);
  if (!inTuple) return format(value);

  switch (setting.type) {
    case 'boolean':
      return unrealBool(Boolean(value));
    case 'number':
      return setting.step ? unrealFloat(Number(value)) : String(Math.round(Number(value)));
    case 'string':
      return quoteUnreal(String(value));
    case 'enum':
      return String(value);
  }
}

/**
 * A derived value arrives as text, but JSON config is typed — writing a port
 * as `"25565"` where the game expects a number is a real difference.
 */
function coerceJson(value: string): SettingValue {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return value;
}

function writeInto(
  plan: MaterialisePlan,
  target: Setting['target'],
  value: string,
  raw: SettingValue,
): void {
  switch (target.kind) {
    case 'properties': {
      const file = plan.properties.get(target.file) ?? {};
      file[target.key] = value;
      plan.properties.set(target.file, file);
      return;
    }

    case 'ini': {
      if (target.tuple) {
        const file =
          plan.tuples.get(target.file) ?? new Map<string, Map<string, Record<string, string>>>();
        const section = file.get(target.section) ?? new Map<string, Record<string, string>>();
        const tuple = section.get(target.tuple) ?? {};
        tuple[target.key] = value;
        section.set(target.tuple, tuple);
        file.set(target.section, section);
        plan.tuples.set(target.file, file);
        return;
      }

      const file = plan.ini.get(target.file) ?? new Map<string, Record<string, string>>();
      const section = file.get(target.section) ?? {};
      section[target.key] = value;
      file.set(target.section, section);
      plan.ini.set(target.file, file);
      return;
    }

    case 'json': {
      // The raw value, not the formatted text: JSON is typed, and a boolean
      // written as the string "true" is a different thing to the game.
      const file = plan.json.get(target.file) ?? new Map<string, SettingValue>();
      file.set(target.path, raw);
      plan.json.set(target.file, file);
      return;
    }

    case 'env': {
      plan.env[target.name] = value;
      return;
    }

    case 'internal':
      // Consumed by the startup template or an install step, not written out.
      return;
  }
}

/** Applies a plan to disk, preserving everything it does not model. */
export async function applyMaterialisation(
  plan: MaterialisePlan,
  tools: InstallTools,
): Promise<void> {
  for (const [file, updates] of plan.properties) {
    const existing = (await tools.readFile(file)) ?? '';
    // mergeProperties keeps comments, blank lines and key order, and appends
    // anything new — so it is right for both an existing file and a fresh one.
    await tools.writeFile(file, mergeProperties(existing, updates));
  }

  for (const [file, sections] of plan.ini) {
    const existing = (await tools.readFile(file)) ?? '';
    const parsed = parseIni(existing);
    for (const [section, updates] of sections) {
      parsed[section] = { ...(parsed[section] ?? {}), ...updates };
    }
    await tools.writeFile(file, stringifyIni(parsed));
  }

  // Unreal tuples. Read the existing parenthesised value, overwrite only the
  // fields the schema models, write it back — so a field added by a game
  // update survives, which is the whole reason not to rebuild it from scratch.
  for (const [file, sections] of plan.tuples) {
    const existing = (await tools.readFile(file)) ?? '';
    const parsed = parseIni(existing);

    for (const [section, tuples] of sections) {
      const current = parsed[section] ?? {};
      for (const [outerKey, fields] of tuples) {
        const existingTuple = current[outerKey];
        const merged = { ...(existingTuple ? parseTuple(existingTuple) : {}), ...fields };
        current[outerKey] = stringifyTuple(merged);
      }
      parsed[section] = current;
    }

    await tools.writeFile(file, stringifyIni(parsed));
  }

  for (const [file, paths] of plan.json) {
    const existing = (await tools.readFile(file)) ?? '';
    let root: Record<string, unknown> = {};
    if (existing.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(existing);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          root = parsed as Record<string, unknown>;
        }
      } catch {
        // A config the game itself wrote as invalid JSON, or a half-written
        // file from a crash. Starting from {} loses their edits, so refuse
        // instead — the operator can look at the file and decide.
        throw new Error(
          `${file} is not valid JSON, so your settings were not written. Fix or delete the file in the Files tab and save again.`,
        );
      }
    }

    for (const [dotted, value] of paths) setDeep(root, dotted, value);
    await tools.writeFile(file, `${JSON.stringify(root, null, 2)}\n`);
  }
}

/** Sets `a.b.c` on a nested object, creating the objects along the way. */
export function setDeep(root: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.').filter((part) => part !== '');
  if (parts.length === 0) return;

  let node = root;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      node[part] = {};
    }
    node = node[part] as Record<string, unknown>;
  }

  node[parts.at(-1)!] = value;
}
