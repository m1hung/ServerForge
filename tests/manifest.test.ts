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
import { planMaterialisation, setDeep } from '../packages/adapters/src/manifest/materialise.js';
import { BEPINEX_LAUNCH } from '../packages/adapters/src/valheim/mod-loader.js';
import { getAdapter } from '../packages/adapters/src/registry.js';
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
      {
        when: { ref: 'setting.Password', isSet: true },
        args: ['-password', '{{setting.Password}}'],
      },
    ];

    expect(renderArgs(args, ctx)).toEqual(['run']);
    expect(
      renderArgs(
        args,
        contextFor('valheim-vanilla', { settings: { ...ctx.settings, Password: 'pw' } }),
      ),
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

    const on = planMaterialisation(
      guarded,
      contextFor('valheim-vanilla', {
        settings: { ...defaultsFor(guarded), Pvp: true },
      }),
    );
    expect(on.properties.get('server.properties')).toHaveProperty('pvp-damage');

    const off = planMaterialisation(
      guarded,
      contextFor('valheim-vanilla', {
        settings: { ...defaultsFor(guarded), Pvp: false },
      }),
    );
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
    expect(validateManifest(manifest)).toEqual([
      expect.stringContaining('unknown filter "|yesno"'),
    ]);
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
    expect(validateManifest(manifest)).toEqual([
      expect.stringContaining('no setting has that key'),
    ]);
  });

  it('rejects a manifest version it cannot read', () => {
    const manifest = base();
    manifest.manifestVersion = 99;
    expect(validateManifest(manifest)).toEqual([
      expect.stringContaining('manifestVersion must be 1'),
    ]);
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

describe('registered Valheim manifest', () => {
  const compiled = getAdapter('valheim');
  const variants = ['valheim-vanilla', 'valheim-bepinex'];

  it('launches vanilla and BepInEx with the default settings', () => {
    for (const variantId of variants) {
      const ctx = contextFor(variantId);
      expect(compiled.startup(ctx)).toMatchObject({
        entrypoint: [],
        command: [
          ...(variantId === 'valheim-bepinex' ? BEPINEX_LAUNCH : []),
          './valheim_server.x86_64',
          '-nographics',
          '-batchmode',
          '-name',
          'A ServerForge Valheim server',
          '-port',
          '2456',
          '-world',
          'Dedicated',
          '-public',
          '1',
        ],
        stopSignal: 'SIGINT',
        stopTimeoutSeconds: 60,
      });
    }
  });

  it('launches on the allocated port', () => {
    const ctx = contextFor('valheim-vanilla', {
      allocations: [
        { ip: '0.0.0.0', port: 27015, purpose: 'game', primary: true },
        { ip: '0.0.0.0', port: 27016, purpose: 'query', primary: false },
      ],
    });
    const command = compiled.startup(ctx).command;
    expect(command[command.indexOf('-port') + 1]).toBe('27015');
  });

  it.each([
    ['Game server connected', { level: 'success', ready: true }],
    ['Failed to bind to port 2456', { level: 'error' }],
    ['bind() failed', { level: 'error' }],
    ['The system ran out of memory', { level: 'error' }],
    ['Error: something went wrong', { level: 'error' }],
    ['Warning: something is odd', { level: 'warn' }],
  ] as const)('classifies %s', (line, expected) => {
    expect(compiled.inspectLog?.(line)).toMatchObject(expected);
  });

  it('ignores ordinary chatter', () => {
    expect(compiled.inspectLog?.('ordinary chatter with nothing special in it')).toBeNull();
  });

  it('clears the SteamCMD entrypoint so the game executable runs', () => {
    const ctx = contextFor('valheim-vanilla');
    expect(compiled.startup(ctx).entrypoint).toEqual([]);
  });

  it('lets the operator override runtime environment defaults', () => {
    const ctx = contextFor('valheim-vanilla', {
      environment: { LD_LIBRARY_PATH: '/custom/lib', TZ: 'Europe/London' },
    });

    expect(compiled.startup(ctx).env.LD_LIBRARY_PATH).toBe('/custom/lib');

    expect(compiled.startup(ctx).env.TZ).toBe('Europe/London');
  });
});

describe('registered Palworld manifest', () => {
  const compiled = getAdapter('palworld');
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

  it('does not offer a Windows loader on Linux', () => {
    // The Linux editions must not advertise UE4SS support.
    const vanillaKeys = compiled.settingsSchema('palworld-vanilla').map((s) => s.key);
    expect(vanillaKeys).not.toContain('sf_enable_ue4ss');
    expect(compiled.settingsSchema('palworld-modded').map((s) => s.key)).not.toContain(
      'sf_enable_ue4ss',
    );
  });

  it('points every game setting at the OptionSettings tuple', () => {
    // Palworld reads the OptionSettings tuple, not individual INI keys.
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

    // Launch-only settings stay internal.
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

  it('enables performance flags by default and omits them when disabled', () => {
    for (const variantId of variants) {
      const ctx = pwContext(variantId);
      expect(compiled.startup(ctx).command).toContain('-useperfthreads');

      const off = { ...ctx, settings: { ...ctx.settings, sf_use_perf_threads: false } };
      expect(compiled.startup(off).command).not.toContain('-useperfthreads');
    }
  });

  it('uses the allocated ports and configured player count', () => {
    const ctx = pwContext('palworld-vanilla', {
      allocations: [
        { ip: '0.0.0.0', port: 25600, purpose: 'game', primary: true },
        { ip: '0.0.0.0', port: 25601, purpose: 'query', primary: false },
        { ip: '0.0.0.0', port: 25602, purpose: 'rest', primary: false },
      ],
    });
    const custom = { ...ctx, settings: { ...ctx.settings, ServerPlayerMaxNum: 24 } };

    expect(compiled.startup(custom).command).toContain('-queryport=25601');
    expect(compiled.startup(custom).command).toContain('-port=25600');
    expect(compiled.startup(custom).command).toContain('-players=24');
  });

  it.each([
    ['Running Palworld dedicated server', { level: 'success', ready: true }],
    ['Setting breakpad minidump AppID = 2394010', { level: 'info', ready: true }],
    ['Failed to bind to 0.0.0.0:8211', { level: 'error' }],
    ['the system is out of memory', { level: 'error' }],
    ['LogPal: Save complete', { level: 'info' }],
    ['Error: something broke', { level: 'error' }],
    ['Warning: something is odd', { level: 'warn' }],
  ] as const)('classifies %s', (line, expected) => {
    expect(compiled.inspectLog?.(line)).toMatchObject(expected);
  });

  it('ignores ordinary chatter', () => {
    expect(compiled.inspectLog?.('nothing interesting here')).toBeNull();
  });

  it('clears the SteamCMD entrypoint so the game executable runs', () => {
    const ctx = pwContext('palworld-vanilla');
    expect(compiled.startup(ctx).entrypoint).toEqual([]);
  });
});

describe('Palworld configuration files', () => {
  const compiled = getAdapter('palworld');
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

  async function writeConfig(
    ctx: ServerContext,
    seed: Record<string, string> = {},
  ): Promise<string> {
    const { files, tools } = memoryTools(seed);
    await compiled.applySettings(ctx, tools);
    return files.get(CONFIG) ?? '';
  }

  it('preserves quoted publisher URLs before later REST settings across repeated edits', async () => {
    const original =
      '[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(BanListURL="https://api.example.test/banlist.txt",FutureString="with, comma",RESTAPIEnabled=False)\n';
    const ctx = pwContext();
    const once = await writeConfig(ctx, { [CONFIG]: original });
    const twice = await writeConfig(ctx, { [CONFIG]: once });
    expect(twice).toContain('BanListURL="https://api.example.test/banlist.txt"');
    expect(twice).toContain('FutureString="with, comma"');
    expect(twice).toContain('RESTAPIEnabled=True');
    expect(twice).toContain('RESTAPIPort=25602');
  });

  /** Enable PvP to exercise dependent friendly-fire settings. */
  function allVisible(overrides: Record<string, string | number | boolean> = {}) {
    const ctx = pwContext();
    return {
      ...ctx,
      settings: { ...ctx.settings, bEnablePlayerToPlayerDamage: true, ...overrides },
    };
  }

  it('writes customised settings in the game config', async () => {
    const custom = allVisible({
      ServerName: 'Test "quoted" server',
      ServerPassword: 'hunter2',
      ExpRate: 2.5,
      ServerPlayerMaxNum: 24,
      bEnableFriendlyFire: true,
      Difficulty: 'Hard',
    });
    const written = await writeConfig(custom);
    expect(written).toContain(`ServerName=${JSON.stringify('Test "quoted" server')}`);
    expect(written).toContain('ServerPassword="hunter2"');
    expect(written).toContain('ExpRate=2.500000');
    expect(written).toContain('ServerPlayerMaxNum=24');
    expect(written).toContain('bEnableFriendlyFire=True');
    expect(written).toContain('Difficulty=Hard');
  });

  it('omits friendly fire until PvP is enabled', async () => {
    const ctx = pwContext(); // PvP off by default, so friendly fire is hidden.
    expect(ctx.settings.bEnablePlayerToPlayerDamage).toBe(false);

    expect(await writeConfig(ctx)).not.toMatch(/bEnableFriendlyFire=/);

    // Turning the parent on brings it back.
    expect(await writeConfig(allVisible())).toMatch(/bEnableFriendlyFire=/);
  });

  it('formats each type the way Unreal expects', async () => {
    const written = await writeConfig(pwContext());

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
    const written = await writeConfig(pwContext());
    expect(written).toMatch(/PublicPort=25600/);
    expect(written).toMatch(/RESTAPIPort=25602/);
  });

  it('keeps tuple fields a game update added that the schema does not model', async () => {
    const seed = {
      [CONFIG]:
        '[/Script/Pal.PalGameWorldSettings]\n' +
        'OptionSettings=(Difficulty=None,SomeBrandNewSetting=42,ServerName="old")\n',
    };

    const written = await writeConfig(allVisible(), seed);
    expect(written).toMatch(/SomeBrandNewSetting=42/);
    expect(written).toMatch(/ServerName="A ServerForge Palworld server"/);
  });
});
