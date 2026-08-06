import { describe, expect, it } from 'vitest';
import { defaultsFor } from '../packages/core/src/settings-schema.js';
import { compileManifest } from '../packages/adapters/src/manifest/compile.js';
import { valheimManifest } from '../packages/adapters/src/manifest/games/valheim.js';
import { validateManifest } from '../packages/adapters/src/manifest/validate.js';
import {
  evaluateCondition,
  renderArgs,
  renderTemplate,
} from '../packages/adapters/src/manifest/template.js';
import {
  planMaterialisation,
  setDeep,
} from '../packages/adapters/src/manifest/materialise.js';
import { valheimAdapter } from '../packages/adapters/src/valheim/index.js';
import type { GameManifest } from '../packages/adapters/src/manifest/types.js';
import type { ServerContext } from '../packages/adapters/src/types.js';
import type { SettingsSchema } from '../packages/core/src/settings-schema.js';

function contextFor(variantId: string, overrides: Partial<ServerContext> = {}): ServerContext {
  const schema = compileManifest(valheimManifest).settingsSchema(variantId);
  return {
    serverUid: 'test123',
    name: 'Test server',
    dataPath: '/srv/test123',
    version: 'latest',
    build: null,
    variantId,
    settings: defaultsFor(schema),
    memoryMib: 4096,
    cpuCores: 2,
    allocations: [
      { ip: '0.0.0.0', port: 2456, purpose: 'game', primary: true },
      { ip: '0.0.0.0', port: 2457, purpose: 'query', primary: false },
    ],
    environment: {},
    javaFlagsPreset: 'balanced',
    customJavaFlags: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────── templates ──

describe('manifest templates', () => {
  const ctx = contextFor('valheim-vanilla');

  it('resolves settings, ports and server facts', () => {
    expect(renderTemplate('{{setting.WorldName}}', ctx)).toBe('Dedicated');
    expect(renderTemplate('{{port.game}}', ctx)).toBe('2456');
    expect(renderTemplate('{{port.query}}', ctx)).toBe('2457');
    expect(renderTemplate('{{memoryMib}}', ctx)).toBe('4096');
    expect(renderTemplate('{{serverUid}}', ctx)).toBe('test123');
  });

  it('renders booleans as 1/0 with the number filter', () => {
    expect(renderTemplate('{{setting.Public}}', ctx)).toBe('true');
    expect(renderTemplate('{{setting.Public|number}}', ctx)).toBe('1');

    const off = contextFor('valheim-vanilla', {
      settings: { ...ctx.settings, Public: false },
    });
    expect(renderTemplate('{{setting.Public|number}}', off)).toBe('0');
  });

  it('renders an unknown reference as empty rather than throwing', () => {
    // Validation rejects these up front; a server mid-install must not crash
    // on one that slipped through.
    expect(renderTemplate('a{{setting.Nope}}b', ctx)).toBe('ab');
  });

  it('treats empty strings and false as unset', () => {
    expect(evaluateCondition({ ref: 'setting.Password', isSet: true }, ctx)).toBe(false);

    const withPassword = contextFor('valheim-vanilla', {
      settings: { ...ctx.settings, Password: 'hunter2' },
    });
    expect(evaluateCondition({ ref: 'setting.Password', isSet: true }, withPassword)).toBe(true);

    // A false checkbox means "not asked for", not "set to false".
    expect(evaluateCondition({ ref: 'setting.Public', isSet: true }, ctx)).toBe(true);
    const off = contextFor('valheim-vanilla', { settings: { ...ctx.settings, Public: false } });
    expect(evaluateCondition({ ref: 'setting.Public', isSet: true }, off)).toBe(false);
  });

  it('drops a conditional argument group whose condition fails', () => {
    const args = [
      'run',
      { when: { ref: 'setting.Password', isSet: true }, args: ['-password', '{{setting.Password}}'] },
    ];

    expect(renderArgs(args, ctx)).toEqual(['run']);
    expect(
      renderArgs(args, contextFor('valheim-vanilla', { settings: { ...ctx.settings, Password: 'pw' } })),
    ).toEqual(['run', '-password', 'pw']);
  });
});

// ──────────────────────────────────────────────────────────── materialising ──

describe('settings materialisation', () => {
  const schema: SettingsSchema = [
    {
      key: 'MaxPlayers',
      type: 'number',
      label: 'Max players',
      help: 'x',
      tier: 'basic',
      group: 'g',
      default: 10,
      target: { kind: 'properties', file: 'server.properties', key: 'max-players' },
    },
    {
      key: 'Pvp',
      type: 'boolean',
      label: 'PvP',
      help: 'x',
      tier: 'basic',
      group: 'g',
      default: true,
      target: { kind: 'ini', file: 'Game.ini', section: 'Server', key: 'bPvp' },
    },
    {
      key: 'Motd',
      type: 'string',
      label: 'MOTD',
      help: 'x',
      tier: 'basic',
      group: 'g',
      default: 'hello',
      target: { kind: 'json', file: 'config.json', path: 'server.motd' },
    },
    {
      key: 'Timezone',
      type: 'string',
      label: 'TZ',
      help: 'x',
      tier: 'basic',
      group: 'g',
      default: 'UTC',
      target: { kind: 'env', name: 'TZ' },
    },
  ];

  const ctx = contextFor('valheim-vanilla', { settings: defaultsFor(schema) });

  it('routes each setting to the file its target names', () => {
    const plan = planMaterialisation(schema, ctx);

    expect(plan.properties.get('server.properties')).toEqual({ 'max-players': '10' });
    expect(plan.ini.get('Game.ini')?.get('Server')).toEqual({ bPvp: 'true' });
    expect(plan.json.get('config.json')?.get('server.motd')).toBe('hello');
    expect(plan.env).toEqual({ TZ: 'UTC' });
  });

  it('skips a setting hidden by its own showWhen guard', () => {
    // A hidden setting that still got written would leave a disabled option
    // silently in force in the game's own config.
    const guarded: SettingsSchema = [
      ...schema,
      {
        key: 'PvpDamage',
        type: 'number',
        label: 'PvP damage',
        help: 'x',
        tier: 'advanced',
        group: 'g',
        default: 5,
        showWhen: { key: 'Pvp', equals: [true] },
        target: { kind: 'properties', file: 'server.properties', key: 'pvp-damage' },
      },
    ];

    const on = planMaterialisation(guarded, contextFor('valheim-vanilla', {
      settings: { ...defaultsFor(guarded), Pvp: true },
    }));
    expect(on.properties.get('server.properties')).toHaveProperty('pvp-damage');

    const off = planMaterialisation(guarded, contextFor('valheim-vanilla', {
      settings: { ...defaultsFor(guarded), Pvp: false },
    }));
    expect(off.properties.get('server.properties')).not.toHaveProperty('pvp-damage');
  });

  it('sets nested json paths without dropping siblings', () => {
    const root: Record<string, unknown> = { server: { port: 25565 }, other: true };
    setDeep(root, 'server.motd', 'hi');
    expect(root).toEqual({ server: { port: 25565, motd: 'hi' }, other: true });
  });

  it('replaces a non-object standing in the way of a nested path', () => {
    const root: Record<string, unknown> = { server: 'not-an-object' };
    setDeep(root, 'server.motd', 'hi');
    expect(root).toEqual({ server: { motd: 'hi' } });
  });
});

// ─────────────────────────────────────────────────────────────── validation ──

describe('manifest validation', () => {
  const base = (): GameManifest => JSON.parse(JSON.stringify(valheimManifest)) as GameManifest;

  it('accepts the built-in manifest', () => {
    expect(validateManifest(valheimManifest)).toEqual([]);
  });

  it('rejects a template referring to a setting that does not exist', () => {
    // The whole reason validation exists: this renders as an empty string and
    // starts the game with a missing flag rather than reporting anything.
    const manifest = base();
    manifest.runtime.command = ['./run', '{{setting.NotAThing}}'];

    expect(validateManifest(manifest)).toEqual([
      expect.stringContaining('refers to the setting "NotAThing"'),
    ]);
  });

  it('rejects a template referring to a port the game does not reserve', () => {
    const manifest = base();
    manifest.runtime.command = ['./run', '-port', '{{port.rcon}}'];
    expect(validateManifest(manifest)).toEqual([expect.stringContaining('port "rcon"')]);
  });

  it('rejects an unknown filter', () => {
    const manifest = base();
    manifest.runtime.command = ['./run', '{{setting.Public|yesno}}'];
    expect(validateManifest(manifest)).toEqual([expect.stringContaining('unknown filter "|yesno"')]);
  });

  it('rejects a player rule whose capture group does not exist', () => {
    // Without this the panel shows a permanently empty player list, which
    // reads as "nobody is playing" rather than "this manifest is wrong".
    const manifest = base();
    manifest.logRules = [
      { pattern: 'joined the game', level: 'info', playerEvent: { type: 'join', nameGroup: 1 } },
    ];
    expect(validateManifest(manifest)).toEqual([
      expect.stringContaining('capture group 1, but the pattern has 0'),
    ]);
  });

  it('does not count non-capturing groups towards the capture count', () => {
    const manifest = base();
    manifest.logRules = [
      {
        pattern: '(?:player )?(\\w+) joined',
        level: 'info',
        playerEvent: { type: 'join', nameGroup: 1 },
      },
    ];
    expect(validateManifest(manifest)).toEqual([]);
  });

  it('rejects an invalid regular expression', () => {
    const manifest = base();
    manifest.logRules = [{ pattern: '(unclosed', level: 'warn' }];
    expect(validateManifest(manifest)).toEqual([
      expect.stringContaining('not a valid regular expression'),
    ]);
  });

  it('rejects a showWhen pointing at a missing setting', () => {
    const manifest = base();
    manifest.settings[0]!.showWhen = { key: 'Ghost', equals: [true] };
    expect(validateManifest(manifest)).toEqual([expect.stringContaining('no setting has that key')]);
  });

  it('rejects a manifest version it cannot read', () => {
    const manifest = base();
    manifest.manifestVersion = 99;
    expect(validateManifest(manifest)).toEqual([expect.stringContaining('manifestVersion must be 1')]);
  });

  it('rejects two variants claiming to be recommended', () => {
    const manifest = base();
    manifest.variants[1]!.recommended = true;
    expect(validateManifest(manifest)).toEqual([expect.stringContaining('only one variant')]);
  });

  it('names the manifest and every problem when compiling an invalid one', () => {
    const manifest = base();
    manifest.runtime.command = ['{{setting.Nope}}'];
    expect(() => compileManifest(manifest)).toThrow(/valheim/);
    expect(() => compileManifest(manifest)).toThrow(/Nope/);
  });
});

// ────────────────────────────────────────────── equivalence with the oracle ──

/**
 * The hand-written Valheim adapter is the reference implementation the
 * manifest has to reproduce. Comparing against it is what makes this port
 * verifiable without downloading several gigabytes of game.
 */
describe('valheim manifest matches the hand-written adapter', () => {
  const compiled = compileManifest(valheimManifest);
  const variants = ['valheim-vanilla', 'valheim-bepinex'];

  it('exposes the same identity and variants', () => {
    expect(compiled.id).toBe(valheimAdapter.id);
    expect(compiled.name).toBe(valheimAdapter.name);
    expect(compiled.summary).toBe(valheimAdapter.summary);
    expect(compiled.icon).toBe(valheimAdapter.icon);
    expect(compiled.variants).toEqual(valheimAdapter.variants);
  });

  it('reserves the same ports and limits', () => {
    for (const variantId of variants) {
      expect(compiled.requiredPorts(variantId)).toEqual(valheimAdapter.requiredPorts(variantId));
      expect(compiled.defaultLimits(variantId)).toEqual(valheimAdapter.defaultLimits(variantId));
    }
  });

  it('produces the same settings schema, Steam branch fields included', () => {
    for (const variantId of variants) {
      expect(compiled.settingsSchema(variantId)).toEqual(valheimAdapter.settingsSchema(variantId));
    }
  });

  it('produces the same startup plan on defaults', () => {
    for (const variantId of variants) {
      const ctx = contextFor(variantId);
      expect(compiled.startup(ctx)).toEqual(valheimAdapter.startup(ctx));
    }
  });

  it('produces the same startup plan with a password and a private server', () => {
    const ctx = contextFor('valheim-vanilla');
    const custom = {
      ...ctx,
      settings: { ...ctx.settings, Password: 'hunter2', Public: false, ServerName: 'Midgard' },
    };
    expect(compiled.startup(custom)).toEqual(valheimAdapter.startup(custom));
  });

  it('produces the same startup plan on a non-default port', () => {
    const ctx = contextFor('valheim-vanilla', {
      allocations: [
        { ip: '0.0.0.0', port: 27015, purpose: 'game', primary: true },
        { ip: '0.0.0.0', port: 27016, purpose: 'query', primary: false },
      ],
    });
    expect(compiled.startup(ctx)).toEqual(valheimAdapter.startup(ctx));
  });

  it('classifies the same log lines the same way', () => {
    const lines = [
      'Game server connected',
      'Failed to bind to port 2456',
      'bind() failed',
      'The system ran out of memory',
      '03/13/2021 20:35:57: Got character ZDOID from Erik : 1234567890:1',
      '03/13/2021 20:40:00: Closing connection to Erik',
      'Error: something went wrong',
      'Warning: something is odd',
      'ordinary chatter with nothing special in it',
    ];

    for (const line of lines) {
      expect(compiled.inspectLog?.(line) ?? null, line).toEqual(
        valheimAdapter.inspectLog?.(line) ?? null,
      );
    }
  });

  it('makes the same claim about reporting players', () => {
    expect(compiled.reportsPlayers).toBe(valheimAdapter.reportsPlayers);
  });

  /**
   * The one place the port deliberately differs.
   *
   * The hand-written adapter pins LD_LIBRARY_PATH over anything the operator
   * set; the compiler lets the server's own environment win, because someone
   * who has typed a value into the environment editor is being deliberate and
   * should not be silently overruled. Asserted rather than left implied, so
   * the difference is a decision on the record and not a regression nobody
   * noticed.
   */
  it('lets the operator override a runtime env value, where the hand-written adapter did not', () => {
    const ctx = contextFor('valheim-vanilla', {
      environment: { LD_LIBRARY_PATH: '/custom/lib', TZ: 'Europe/London' },
    });

    expect(compiled.startup(ctx).env.LD_LIBRARY_PATH).toBe('/custom/lib');
    expect(valheimAdapter.startup(ctx).env.LD_LIBRARY_PATH).toBe(
      '/home/container/linux64:/home/container/steamclient',
    );

    // TZ behaves identically: the manifest default is a default, not a pin.
    expect(compiled.startup(ctx).env.TZ).toBe('Europe/London');
    expect(valheimAdapter.startup(ctx).env.TZ).toBe('Europe/London');
  });

  it('points mods at the same directory per variant', () => {
    for (const variantId of variants) {
      expect(compiled.modDirectory?.(variantId)).toBe(valheimAdapter.modDirectory?.(variantId));
    }
  });

  it('offers the same console glossary', () => {
    expect(compiled.consoleGlossary?.('valheim-vanilla')).toEqual(
      valheimAdapter.consoleGlossary?.('valheim-vanilla'),
    );
  });
});
