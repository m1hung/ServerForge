/**
 * Declarative settings schema.
 *
 * A game adapter describes its knobs once, here, and three things fall out
 * for free:
 *   1. The deploy wizard and the server settings page render themselves.
 *   2. The API validates writes without per-game code.
 *   3. Values are materialised into the game's own config format
 *      (server.properties, INI, JSON, env vars) by the adapter.
 *
 * The `tier` field is what makes the product beginner-friendly: `basic`
 * fields show up front, `advanced` fields live behind a disclosure, and
 * `expert` fields are only reachable from the raw editor.
 */

export type SettingTier = 'basic' | 'advanced' | 'expert';

/** Where a materialised value ends up inside the container. */
export type SettingTarget =
  /** A key in a `key=value` properties file, e.g. server.properties. */
  | { kind: 'properties'; file: string; key: string }
  /** A key inside an INI section, e.g. Palworld's PalWorldSettings.ini. */
  | { kind: 'ini'; file: string; section: string; key: string }
  /** A dotted path inside a JSON file. */
  | { kind: 'json'; file: string; path: string }
  /** An environment variable on the container. */
  | { kind: 'env'; name: string }
  /** Consumed by the adapter's own logic (startup command, install step). */
  | { kind: 'internal' };

interface SettingBase {
  /** Stable machine key. Never change it — it is the DB column value. */
  key: string;
  /** Short human label. Sentence case, no trailing colon. */
  label: string;
  /**
   * Plain-language explanation rendered as a tooltip / helper line.
   * Write it for someone who has never opened a server.properties file.
   */
  help: string;
  tier: SettingTier;
  /** Groups fields into cards in the UI. */
  group: string;
  /** Requires a server restart to take effect. Surfaces a badge in the UI. */
  restartRequired?: boolean;
  /** Only show/apply when another setting has one of these values. */
  showWhen?: { key: string; equals: (string | number | boolean)[] };
  target: SettingTarget;
}

export interface StringSetting extends SettingBase {
  type: 'string';
  default: string;
  minLength?: number;
  maxLength?: number;
  /** Serialised RegExp source, applied case-sensitively. */
  pattern?: string;
  placeholder?: string;
  /** Render as a textarea instead of a single-line input. */
  multiline?: boolean;
  /** Never echo the stored value back to the client. */
  secret?: boolean;
}

export interface NumberSetting extends SettingBase {
  type: 'number';
  default: number;
  min?: number;
  max?: number;
  step?: number;
  /** Appended to the input, e.g. "MiB", "ticks", "players". */
  unit?: string;
}

export interface BooleanSetting extends SettingBase {
  type: 'boolean';
  default: boolean;
}

export interface EnumSetting extends SettingBase {
  type: 'enum';
  default: string;
  options: { value: string; label: string; help?: string }[];
}

export type Setting = StringSetting | NumberSetting | BooleanSetting | EnumSetting;

export type SettingsSchema = Setting[];

export type SettingValue = string | number | boolean;
export type SettingValues = Record<string, SettingValue>;

export interface ValidationIssue {
  key: string;
  message: string;
}

/** Fills in every default, so callers always get a complete value map. */
export function defaultsFor(schema: SettingsSchema): SettingValues {
  const out: SettingValues = {};
  for (const setting of schema) out[setting.key] = setting.default;
  return out;
}

/**
 * True when a setting's `showWhen` guard is satisfied by the current values.
 * Hidden settings are neither validated nor materialised.
 */
export function isSettingActive(setting: Setting, values: SettingValues): boolean {
  if (!setting.showWhen) return true;
  const actual = values[setting.showWhen.key];
  return setting.showWhen.equals.includes(actual as SettingValue);
}

/**
 * Validates + coerces a partial patch against the schema.
 *
 * Coercion matters because HTML form posts and `.env`-style imports both
 * arrive as strings. Unknown keys are rejected rather than silently dropped,
 * so a typo in an automation script surfaces immediately.
 */
export function validateSettings(
  schema: SettingsSchema,
  input: Record<string, unknown>,
  { partial = false }: { partial?: boolean } = {},
): { ok: true; values: SettingValues } | { ok: false; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const byKey = new Map(schema.map((s) => [s.key, s]));

  for (const key of Object.keys(input)) {
    if (!byKey.has(key)) issues.push({ key, message: `Unknown setting "${key}".` });
  }

  const values: SettingValues = partial ? {} : defaultsFor(schema);

  for (const setting of schema) {
    const raw = input[setting.key];
    if (raw === undefined || raw === null) continue;

    const result = coerce(setting, raw);
    if ('error' in result) {
      issues.push({ key: setting.key, message: result.error });
      continue;
    }
    values[setting.key] = result.value;
  }

  // Guards are evaluated against the merged view so a patch that flips a
  // parent switch validates its newly-revealed children correctly.
  const merged: SettingValues = partial ? { ...defaultsFor(schema), ...values } : values;
  for (const setting of schema) {
    if (!isSettingActive(setting, merged)) delete values[setting.key];
  }

  // Defaults can be empty placeholders (e.g. "paste a Modrinth link"). A full
  // submit must still satisfy minLength — otherwise an untouched field slips
  // through and the install worker fails later with a worse error.
  if (!partial) {
    for (const setting of schema) {
      if (!isSettingActive(setting, merged)) continue;
      if (setting.type !== 'string') continue;
      if (setting.minLength === undefined) continue;
      const value = String(values[setting.key] ?? '');
      if (value.length < setting.minLength) {
        issues.push({
          key: setting.key,
          message:
            setting.minLength <= 1
              ? 'This field is required.'
              : `Must be at least ${setting.minLength} characters.`,
        });
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, values };
}

function coerce(setting: Setting, raw: unknown): { value: SettingValue } | { error: string } {
  switch (setting.type) {
    case 'string': {
      if (typeof raw !== 'string') return { error: 'Expected text.' };
      if (setting.minLength !== undefined && raw.length < setting.minLength)
        return { error: `Must be at least ${setting.minLength} characters.` };
      if (setting.maxLength !== undefined && raw.length > setting.maxLength)
        return { error: `Must be at most ${setting.maxLength} characters.` };
      if (setting.pattern && !new RegExp(setting.pattern).test(raw))
        return { error: 'Contains characters that are not allowed here.' };
      return { value: raw };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return { error: 'Expected a number.' };
      if (setting.min !== undefined && n < setting.min)
        return { error: `Must be ${setting.min} or higher.` };
      if (setting.max !== undefined && n > setting.max)
        return { error: `Must be ${setting.max} or lower.` };
      return { value: n };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw };
      const s = String(raw).toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(s)) return { value: true };
      if (['false', '0', 'no', 'off'].includes(s)) return { value: false };
      return { error: 'Expected yes or no.' };
    }
    case 'enum': {
      const s = String(raw);
      if (!setting.options.some((o) => o.value === s))
        return { error: `Must be one of: ${setting.options.map((o) => o.value).join(', ')}.` };
      return { value: s };
    }
  }
}

/** Groups a schema for rendering, preserving declaration order. */
export function groupSettings(
  schema: SettingsSchema,
  tiers: SettingTier[] = ['basic', 'advanced', 'expert'],
): { group: string; settings: Setting[] }[] {
  const groups: { group: string; settings: Setting[] }[] = [];
  for (const setting of schema) {
    if (!tiers.includes(setting.tier)) continue;
    let bucket = groups.find((g) => g.group === setting.group);
    if (!bucket) {
      bucket = { group: setting.group, settings: [] };
      groups.push(bucket);
    }
    bucket.settings.push(setting);
  }
  return groups;
}
