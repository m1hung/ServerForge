import { describe, expect, it } from 'vitest';
import {
  defaultsFor,
  groupSettings,
  isSettingActive,
  validateSettings,
  type SettingsSchema,
} from '../packages/core/src/settings-schema.js';

const schema: SettingsSchema = [
  {
    key: 'motd',
    type: 'string',
    label: 'Message',
    help: 'h',
    tier: 'basic',
    group: 'Basics',
    default: 'hello',
    maxLength: 10,
    target: { kind: 'properties', file: 'server.properties', key: 'motd' },
  },
  {
    key: 'max-players',
    type: 'number',
    label: 'Max players',
    help: 'h',
    tier: 'basic',
    group: 'Basics',
    default: 10,
    min: 1,
    max: 100,
    target: { kind: 'properties', file: 'server.properties', key: 'max-players' },
  },
  {
    key: 'whitelist',
    type: 'boolean',
    label: 'Allowlist',
    help: 'h',
    tier: 'basic',
    group: 'Access',
    default: false,
    target: { kind: 'properties', file: 'server.properties', key: 'white-list' },
  },
  {
    key: 'enforce',
    type: 'boolean',
    label: 'Enforce',
    help: 'h',
    tier: 'advanced',
    group: 'Access',
    default: true,
    showWhen: { key: 'whitelist', equals: [true] },
    target: { kind: 'properties', file: 'server.properties', key: 'enforce-whitelist' },
  },
  {
    key: 'difficulty',
    type: 'enum',
    label: 'Difficulty',
    help: 'h',
    tier: 'basic',
    group: 'Basics',
    default: 'normal',
    options: [
      { value: 'peaceful', label: 'Peaceful' },
      { value: 'normal', label: 'Normal' },
    ],
    target: { kind: 'properties', file: 'server.properties', key: 'difficulty' },
  },
];

describe('defaultsFor', () => {
  it('returns a complete value map', () => {
    expect(defaultsFor(schema)).toEqual({
      motd: 'hello',
      'max-players': 10,
      whitelist: false,
      enforce: true,
      difficulty: 'normal',
    });
  });
});

describe('validateSettings', () => {
  it('accepts valid input and fills defaults for omitted keys', () => {
    const result = validateSettings(schema, { motd: 'hi' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.motd).toBe('hi');
      expect(result.values['max-players']).toBe(10);
    }
  });

  it('coerces string input from form posts', () => {
    // HTML forms and .env imports both deliver everything as strings.
    const result = validateSettings(schema, {
      'max-players': '42',
      whitelist: 'true',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values['max-players']).toBe(42);
      expect(result.values.whitelist).toBe(true);
    }
  });

  it.each([
    ['yes', true],
    ['on', true],
    ['1', true],
    ['no', false],
    ['off', false],
    ['0', false],
  ])('accepts %s as a boolean', (input, expected) => {
    const result = validateSettings(schema, { whitelist: input });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.whitelist).toBe(expected);
  });

  it('rejects out-of-range numbers with an actionable message', () => {
    const result = validateSettings(schema, { 'max-players': 500 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.key).toBe('max-players');
      expect(result.issues[0]?.message).toContain('100');
    }
  });

  it('rejects values that are not in an enum', () => {
    const result = validateSettings(schema, { difficulty: 'nightmare' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain('peaceful');
  });

  it('rejects strings over the length limit', () => {
    const result = validateSettings(schema, { motd: 'x'.repeat(11) });
    expect(result.ok).toBe(false);
  });

  it('rejects empty defaults that declare minLength on a full submit', () => {
    const requiredSchema: SettingsSchema = [
      {
        key: 'modpack_project',
        type: 'string',
        label: 'Modpack',
        help: 'h',
        tier: 'basic',
        group: 'Modpack',
        default: '',
        minLength: 1,
        target: { kind: 'internal' },
      },
    ];
    const result = validateSettings(requiredSchema, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain('required');
  });

  it('rejects unknown keys instead of dropping them silently', () => {
    const result = validateSettings(schema, { totally_made_up: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain('Unknown setting');
  });

  it('reports every problem at once, not just the first', () => {
    const result = validateSettings(schema, { 'max-players': 0, difficulty: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toHaveLength(2);
  });

  it('drops settings whose showWhen guard is not satisfied', () => {
    // `enforce` only applies when the allowlist is on.
    const result = validateSettings(schema, { whitelist: false, enforce: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.enforce).toBeUndefined();
  });

  it('keeps guarded settings when the parent is enabled', () => {
    const result = validateSettings(schema, { whitelist: true, enforce: false });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.enforce).toBe(false);
  });
});

describe('isSettingActive', () => {
  it('is true for unguarded settings', () => {
    expect(isSettingActive(schema[0]!, {})).toBe(true);
  });

  it('follows the guard', () => {
    const enforce = schema.find((s) => s.key === 'enforce')!;
    expect(isSettingActive(enforce, { whitelist: true })).toBe(true);
    expect(isSettingActive(enforce, { whitelist: false })).toBe(false);
  });
});

describe('groupSettings', () => {
  it('preserves declaration order and groups by card', () => {
    const groups = groupSettings(schema);
    expect(groups.map((g) => g.group)).toEqual(['Basics', 'Access']);
    expect(groups[0]?.settings.map((s) => s.key)).toEqual(['motd', 'max-players', 'difficulty']);
  });

  it('filters by tier so the beginner view hides advanced fields', () => {
    const basic = groupSettings(schema, ['basic']);
    const access = basic.find((g) => g.group === 'Access');
    expect(access?.settings.map((s) => s.key)).toEqual(['whitelist']);
  });
});
