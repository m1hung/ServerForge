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
import { palworldManifest } from '../packages/adapters/src/manifest/games/palworld.js';
import { palworldAdapter } from '../packages/adapters/src/palworld/index.js';
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

/**
 * Compares startup plans while setting `entrypoint` aside.
 *
 * The manifests clear the SteamCMD image's entrypoint and the hand-written
 * adapters never did — which is why no Steam game could actually run: the
 * command arrived as arguments to steamcmd. The difference is the fix, and it
 * is asserted on its own below rather than smuggled through here.
 */
function samePlan(a: StartupPlan, b: StartupPlan) {
  const strip = ({ entrypoint: _entrypoint, ...rest }: StartupPlan) => rest;
  expect(strip(a)).toEqual(strip(b));
}

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
      samePlan(compiled.startup(ctx), valheimAdapter.startup(ctx));
    }
  });

  it('produces the same startup plan with a password and a private server', () => {
    const ctx = contextFor('valheim-vanilla');
    const custom = {
      ...ctx,
      settings: { ...ctx.settings, Password: 'hunter2', Public: false, ServerName: 'Midgard' },
    };
    samePlan(compiled.startup(custom), valheimAdapter.startup(custom));
  });

  it('produces the same startup plan on a non-default port', () => {
    const ctx = contextFor('valheim-vanilla', {
      allocations: [
        { ip: '0.0.0.0', port: 27015, purpose: 'game', primary: true },
        { ip: '0.0.0.0', port: 27016, purpose: 'query', primary: false },
      ],
    });
    samePlan(compiled.startup(ctx), valheimAdapter.startup(ctx));
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
   * The divergence `samePlan` sets aside, asserted on its own.
   *
   * The SteamCMD image is used for its runtime libraries, but its entrypoint
   * is steamcmd. The hand-written adapter left that in place, so the command
   * became arguments to steamcmd and the game never started — a Steam server
   * would install and then sit there running an idle SteamCMD prompt. The
   * manifests clear it.
   */
  it('clears the SteamCMD entrypoint, which the hand-written adapter did not', () => {
    const ctx = contextFor('valheim-vanilla');
    expect(compiled.startup(ctx).entrypoint).toEqual([]);
    expect(valheimAdapter.startup(ctx).entrypoint).toBeUndefined();
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

// ──────────────────────────────────────────────────── palworld equivalence ──

/**
 * Palworld exercises the parts of the format Valheim did not: Unreal tuples,
 * config values derived from allocations, a seeded default config, and a
 * setting that only one variant has. The hand-written adapter is again the
 * reference the port has to reproduce.
 */
describe('palworld manifest matches the hand-written adapter', () => {
  const compiled = compileManifest(palworldManifest);
  const variants = ['palworld-vanilla', 'palworld-modded'];

  function pwContext(variantId: string, overrides: Partial<ServerContext> = {}): ServerContext {
    return {
      serverUid: 'pw123',
      name: 'Pals',
      dataPath: '/srv/pw123',
      version: 'latest',
      build: null,
      variantId,
      settings: defaultsFor(compiled.settingsSchema(variantId)),
      memoryMib: 16384,
      cpuCores: 4,
      allocations: [
        { ip: '0.0.0.0', port: 8211, purpose: 'game', primary: true },
        { ip: '0.0.0.0', port: 27015, purpose: 'query', primary: false },
        { ip: '0.0.0.0', port: 8212, purpose: 'rest', primary: false },
      ],
      environment: {},
      javaFlagsPreset: 'balanced',
      customJavaFlags: null,
      ...overrides,
    };
  }

  it('exposes the same identity, variants, ports and limits', () => {
    expect(compiled.id).toBe(palworldAdapter.id);
    expect(compiled.name).toBe(palworldAdapter.name);
    expect(compiled.summary).toBe(palworldAdapter.summary);
    expect(compiled.icon).toBe(palworldAdapter.icon);
    expect(compiled.variants).toEqual(palworldAdapter.variants);

    for (const variantId of variants) {
      expect(compiled.requiredPorts(variantId)).toEqual(palworldAdapter.requiredPorts(variantId));
      expect(compiled.defaultLimits(variantId)).toEqual(palworldAdapter.defaultLimits(variantId));
    }
  });

  /**
   * Everything a user sees or is validated against has to match exactly.
   *
   * `target` deliberately does not: the hand-written adapter knew in code that
   * these settings live inside the `OptionSettings` tuple, and the manifest
   * says so in the target instead. That relocation is the port. It is asserted
   * separately below rather than waved through.
   */
  it('produces the same settings schema per variant, including the mods toggle', () => {
    for (const variantId of variants) {
      const withoutTargets = (schema: SettingsSchema) =>
        schema.map(({ target: _target, ...rest }) => rest);

      expect(withoutTargets(compiled.settingsSchema(variantId))).toEqual(
        withoutTargets(palworldAdapter.settingsSchema(variantId)),
      );
    }

    // The variant-only setting must be absent from vanilla, not merely hidden.
    const vanillaKeys = compiled.settingsSchema('palworld-vanilla').map((s) => s.key);
    expect(vanillaKeys).not.toContain('sf_enable_ue4ss');
    expect(compiled.settingsSchema('palworld-modded').map((s) => s.key)).toContain(
      'sf_enable_ue4ss',
    );
  });

  it('points every game setting at the OptionSettings tuple', () => {
    // The relocation the previous test excludes. Getting this wrong writes
    // each setting onto its own INI line, which Palworld ignores entirely —
    // the server would start and quietly use defaults for everything.
    const schema = compiled.settingsSchema('palworld-vanilla');
    const iniTargets = schema.filter((s) => s.target.kind === 'ini');

    expect(iniTargets.length).toBeGreaterThan(15);
    for (const setting of iniTargets) {
      expect(setting.target, setting.key).toMatchObject({
        kind: 'ini',
        file: 'Pal/Saved/Config/LinuxServer/PalWorldSettings.ini',
        section: '/Script/Pal.PalGameWorldSettings',
        tuple: 'OptionSettings',
      });
    }

    // The two that are not config at all stay internal.
    const internal = schema.filter((s) => s.target.kind === 'internal').map((s) => s.key);
    expect(internal).toContain('sf_use_perf_threads');
  });

  it('does not leak manifest-only fields into the catalogue', () => {
    // `variants` is serialised to every browser that opens the deploy wizard.
    for (const variant of compiled.variants) {
      expect(variant).not.toHaveProperty('settings');
      expect(variant).not.toHaveProperty('limits');
      expect(variant).not.toHaveProperty('modDirectory');
    }
  });

  it('returns the same array identity for repeated schema reads', () => {
    // A fresh array each call reads to React as "the settings changed".
    expect(compiled.settingsSchema('palworld-vanilla')).toBe(
      compiled.settingsSchema('palworld-vanilla'),
    );
  });

  it('produces the same startup plan on defaults and with perf threads off', () => {
    for (const variantId of variants) {
      const ctx = pwContext(variantId);
      samePlan(compiled.startup(ctx), palworldAdapter.startup(ctx));

      const off = { ...ctx, settings: { ...ctx.settings, sf_use_perf_threads: false } };
      samePlan(compiled.startup(off), palworldAdapter.startup(off));
      expect(compiled.startup(off).command).not.toContain('-useperfthreads');
    }
  });

  it('produces the same startup plan on non-default ports and player counts', () => {
    const ctx = pwContext('palworld-vanilla', {
      allocations: [
        { ip: '0.0.0.0', port: 25600, purpose: 'game', primary: true },
        { ip: '0.0.0.0', port: 25601, purpose: 'query', primary: false },
        { ip: '0.0.0.0', port: 25602, purpose: 'rest', primary: false },
      ],
    });
    const custom = { ...ctx, settings: { ...ctx.settings, ServerPlayerMaxNum: 24 } };

    samePlan(compiled.startup(custom), palworldAdapter.startup(custom));
    expect(compiled.startup(custom).command).toContain('-port=25600');
    expect(compiled.startup(custom).command).toContain('-players=24');
  });

  it('classifies the same log lines the same way', () => {
    const lines = [
      'Running Palworld dedicated server',
      'Setting breakpad minidump AppID = 2394010',
      'Failed to bind to 0.0.0.0:8211',
      'the system is out of memory',
      'LogPal: Save complete',
      'Error: something broke',
      'Warning: something is odd',
      'nothing interesting here',
    ];

    for (const line of lines) {
      expect(compiled.inspectLog?.(line) ?? null, line).toEqual(
        palworldAdapter.inspectLog?.(line) ?? null,
      );
    }
  });

  it('agrees on player reporting and mod directories', () => {
    expect(Boolean(compiled.reportsPlayers)).toBe(Boolean(palworldAdapter.reportsPlayers));
    for (const variantId of variants) {
      expect(compiled.modDirectory?.(variantId)).toBe(palworldAdapter.modDirectory?.(variantId));
    }
  });

  it('offers the same console glossary', () => {
    expect(compiled.consoleGlossary?.('palworld-vanilla')).toEqual(
      palworldAdapter.consoleGlossary?.('palworld-vanilla'),
    );
  });

  it('clears the SteamCMD entrypoint, which the hand-written adapter did not', () => {
    const ctx = pwContext('palworld-vanilla');
    expect(compiled.startup(ctx).entrypoint).toEqual([]);
    expect(palworldAdapter.startup(ctx).entrypoint).toBeUndefined();
  });
});

// ───────────────────────────────────────────── palworld config materialising ──

/**
 * The part of the Palworld port that actually touches a config file.
 *
 * Both adapters are run against the same in-memory filesystem and the results
 * compared. Everything above compares descriptions of behaviour; this compares
 * the bytes, which is what the game reads.
 */
describe('palworld writes the same config as the hand-written adapter', () => {
  const compiled = compileManifest(palworldManifest);
  const CONFIG = 'Pal/Saved/Config/LinuxServer/PalWorldSettings.ini';

  /** Minimal InstallTools over a Map. Only the file operations are reachable. */
  function memoryTools(seed: Record<string, string> = {}) {
    const files = new Map(Object.entries(seed));
    const unsupported = () => {
      throw new Error('not reachable from applySettings');
    };

    return {
      files,
      tools: {
        readFile: async (p: string) => files.get(p) ?? null,
        writeFile: async (p: string, c: string) => void files.set(p, c),
        exists: async (p: string) => files.has(p),
        mkdir: async () => undefined,
        remove: async (p: string) => void files.delete(p),
        listDir: async () => [...files.keys()],
        download: unsupported,
        unzip: unsupported,
        runInContainer: unsupported,
      } as unknown as Parameters<typeof compiled.applySettings>[1],
    };
  }

  function pwContext(overrides: Partial<ServerContext> = {}): ServerContext {
    return {
      serverUid: 'pw123',
      name: 'Pals',
      dataPath: '/srv/pw123',
      version: 'latest',
      build: null,
      variantId: 'palworld-vanilla',
      settings: defaultsFor(compiled.settingsSchema('palworld-vanilla')),
      memoryMib: 16384,
      cpuCores: 4,
      allocations: [
        { ip: '0.0.0.0', port: 25600, purpose: 'game', primary: true },
        { ip: '0.0.0.0', port: 25601, purpose: 'query', primary: false },
        { ip: '0.0.0.0', port: 25602, purpose: 'rest', primary: false },
      ],
      environment: {},
      javaFlagsPreset: 'balanced',
      customJavaFlags: null,
      ...overrides,
    };
  }

  async function writeWith(
    adapter: { applySettings: (c: ServerContext, t: never) => Promise<void> },
    ctx: ServerContext,
    seed: Record<string, string> = {},
  ): Promise<string> {
    const { files, tools } = memoryTools(seed);
    await adapter.applySettings(ctx, tools as never);
    return files.get(CONFIG) ?? '';
  }

  /** PvP on, so no setting is hidden and the two must agree exactly. */
  function allVisible(overrides: Record<string, string | number | boolean> = {}) {
    const ctx = pwContext();
    return {
      ...ctx,
      settings: { ...ctx.settings, bEnablePlayerToPlayerDamage: true, ...overrides },
    };
  }

  it('produces an identical config file when every setting is visible', async () => {
    const ctx = allVisible();
    expect(await writeWith(compiled, ctx)).toBe(await writeWith(palworldAdapter, ctx));
  });

  it('produces an identical config file from customised settings', async () => {
    const custom = allVisible({
      ServerName: 'Test "quoted" server',
      ServerPassword: 'hunter2',
      ExpRate: 2.5,
      ServerPlayerMaxNum: 24,
      bEnableFriendlyFire: true,
      Difficulty: 'Hard',
    });
    expect(await writeWith(compiled, custom)).toBe(await writeWith(palworldAdapter, custom));
  });

  /**
   * A divergence, and a deliberate one: the port fixes a bug.
   *
   * `bEnableFriendlyFire` is hidden until player-versus-player damage is on,
   * and the schema contract says hidden settings are neither validated nor
   * materialised — the reason being that writing one leaves a disabled option
   * silently in force in the game's config. The hand-written adapter looped
   * over every ini setting and wrote it regardless.
   *
   * No practical difference here, because the value it wrote matches
   * Palworld's own default for the field. It is asserted so the change is on
   * the record rather than discovered later as a regression.
   */
  it('omits a hidden setting that the hand-written adapter wrote anyway', async () => {
    const ctx = pwContext(); // PvP off by default, so friendly fire is hidden.
    expect(ctx.settings.bEnablePlayerToPlayerDamage).toBe(false);

    expect(await writeWith(compiled, ctx)).not.toMatch(/bEnableFriendlyFire=/);
    expect(await writeWith(palworldAdapter, ctx)).toMatch(/bEnableFriendlyFire=False/);

    // Turning the parent on brings it back for both.
    expect(await writeWith(compiled, allVisible())).toMatch(/bEnableFriendlyFire=/);
  });

  it('formats each type the way Unreal expects', async () => {
    const written = await writeWith(compiled, pwContext());

    // Floats to six places, integers bare, booleans capitalised, strings quoted.
    expect(written).toMatch(/ExpRate=1\.000000/);
    expect(written).toMatch(/ServerPlayerMaxNum=16(,|\))/);
    expect(written).toMatch(/bIsMultiplay=False/);
    expect(written).toMatch(/ServerName="A ServerForge Palworld server"/);
    expect(written).toMatch(/Difficulty=None/);
  });

  it('writes the allocated ports, not the defaults', async () => {
    // A config still naming 8211 while the panel published 25600 gives a
    // server that looks online and refuses every connection.
    const written = await writeWith(compiled, pwContext());
    expect(written).toMatch(/PublicPort=25600/);
    expect(written).toMatch(/RESTAPIPort=25602/);
  });

  it('keeps tuple fields a game update added that the schema does not model', async () => {
    const seed = {
      [CONFIG]:
        '[/Script/Pal.PalGameWorldSettings]\n' +
        'OptionSettings=(Difficulty=None,SomeBrandNewSetting=42,ServerName="old")\n',
    };

    const written = await writeWith(compiled, allVisible(), seed);
    expect(written).toMatch(/SomeBrandNewSetting=42/);
    expect(written).toMatch(/ServerName="A ServerForge Palworld server"/);

    // And the hand-written adapter agreed, which is why this is the behaviour.
    expect(written).toBe(await writeWith(palworldAdapter, allVisible(), seed));
  });
});
