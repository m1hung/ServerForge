import { describe, expect, it } from 'vitest';
import { minecraftAdapter } from '../packages/adapters/src/minecraft/index.js';
import { palworldAdapter } from '../packages/adapters/src/palworld/index.js';
import { valheimAdapter } from '../packages/adapters/src/valheim/index.js';
import { buildCatalogue, getAdapter, getVariant, listAdapters } from '../packages/adapters/src/registry.js';
import { buildJavaFlags, heapForMemoryLimit, isCalendarVersion, javaImageFor, javaMajorFor, tokenizeFlags } from '../packages/adapters/src/minecraft/java.js';
import { mergeProperties, parseProperties } from '../packages/adapters/src/util/properties.js';
import { parseIni, parseTuple, stringifyTuple } from '../packages/adapters/src/util/ini.js';
import {
  STEAM_BRANCH_KEY,
  STEAM_BRANCH_PASSWORD_KEY,
  isValidSteamBranch,
  steamBranchArgs,
  steamBranchFrom,
  steamAppUpdate,
} from '../packages/adapters/src/util/steamcmd.js';
import { compareMinecraftVersions } from '../packages/adapters/src/minecraft/versions.js';
import { normalizeModrinthProject, parseModrinthRef } from '../packages/adapters/src/minecraft/modpacks.js';
import { defaultsFor } from '../packages/core/src/settings-schema.js';
import type { ServerContext } from '../packages/adapters/src/types.js';

function contextFor(adapter: typeof minecraftAdapter, variantId: string): ServerContext {
  return {
    serverUid: 'test123',
    name: 'Test',
    dataPath: '/srv/test123',
    version: '1.21.4',
    build: null,
    variantId,
    settings: defaultsFor(adapter.settingsSchema(variantId)),
    memoryMib: 4096,
    cpuCores: 2,
    allocations: [
      { ip: '0.0.0.0', port: 25565, purpose: 'game', primary: true },
      { ip: '0.0.0.0', port: 25575, purpose: 'rcon', primary: false },
    ],
    environment: {},
    javaFlagsPreset: 'balanced',
    customJavaFlags: null,
  };
}

describe('registry', () => {
  it('exposes every registered game', () => {
    expect(listAdapters().map((a) => a.id)).toEqual(['minecraft-java', 'palworld', 'valheim']);
  });

  it('throws a 404-shaped error for an unknown game', () => {
    expect(() => getAdapter('half-life')).toThrowError(/was not found/);
  });

  it('throws for an unknown variant', () => {
    expect(() => getVariant('minecraft-java', 'bedrock')).toThrowError(/was not found/);
  });

  it('builds a JSON-serialisable catalogue for the deploy wizard', () => {
    const catalogue = buildCatalogue();
    const json = JSON.parse(JSON.stringify(catalogue));
    expect(json).toEqual(catalogue);

    const minecraft = catalogue.find((g) => g.id === 'minecraft-java')!;
    expect(minecraft.variants.map((v) => v.id)).toContain('paper');
    // Variants must arrive pre-sorted so the UI does not re-sort them.
    expect(minecraft.variants.map((v) => v.order)).toEqual(
      [...minecraft.variants.map((v) => v.order)].sort((a, b) => a - b),
    );
  });

  it('marks exactly one recommended variant per game', () => {
    for (const adapter of listAdapters()) {
      const recommended = adapter.variants.filter((v) => v.recommended);
      expect(recommended).toHaveLength(1);
    }
  });

  it('gives every variant a beginner-readable summary', () => {
    for (const adapter of listAdapters()) {
      for (const variant of adapter.variants) {
        expect(variant.summary.length).toBeGreaterThan(10);
        expect(variant.summary).not.toMatch(/JVM|argv|stdin/);
      }
    }
  });

  /**
   * `reportsPlayers` is what makes the panel say "this game does not tell us
   * who is connected" instead of showing an empty list that reads as "nobody
   * is playing". A game that parses join lines but forgets the flag would show
   * a permanently empty list; one that sets the flag without parsing anything
   * would claim a server is empty forever. Both are silent wrongness, so the
   * claim is checked against the behaviour.
   */
  it('only claims to report players when inspectLog actually does', () => {
    const samples: Record<string, string[]> = {
      'minecraft-java': [
        '[12:00:00] [Server thread/INFO]: Notch joined the game',
        '[12:00:00] [Server thread/INFO]: Notch left the game',
      ],
      valheim: [
        '03/13/2021 20:35:57: Got character ZDOID from Erik : 1234567890:1',
        '03/13/2021 20:40:00: Closing connection to Erik',
      ],
      palworld: ['[S_API FAIL] SteamAPI_Init() failed'],
    };

    for (const adapter of listAdapters()) {
      const lines = samples[adapter.id] ?? [];
      const emits = lines.some((line) => adapter.inspectLog?.(line)?.playerEvent);
      expect(
        Boolean(adapter.reportsPlayers),
        `${adapter.id}: reportsPlayers is ${Boolean(adapter.reportsPlayers)} but inspectLog ${emits ? 'does' : 'does not'} return player events`,
      ).toBe(emits);
    }
  });

  it('exposes a console command glossary for every game', () => {
    for (const adapter of listAdapters()) {
      const glossary = adapter.consoleGlossary?.(adapter.variants[0]!.id);
      expect(glossary).toBeDefined();
      expect(glossary!.commands.length).toBeGreaterThan(0);
      for (const entry of glossary!.commands) {
        expect(entry.command.trim().length).toBeGreaterThan(0);
        expect(entry.summary.length).toBeGreaterThan(10);
        expect(entry.category.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe('minecraft adapter', () => {
  it('requests a game port and an rcon port', () => {
    expect(minecraftAdapter.requiredPorts('paper')).toEqual([
      { purpose: 'game', protocol: 'tcp' },
      { purpose: 'rcon', protocol: 'tcp' },
    ]);
  });

  it('gives modded variants more memory than plugin variants', () => {
    const paper = minecraftAdapter.defaultLimits('paper');
    const forge = minecraftAdapter.defaultLimits('forge');
    expect(forge.memoryMib).toBeGreaterThan(paper.memoryMib);
  });

  it('builds a startup plan with no shell string', () => {
    const plan = minecraftAdapter.startup(contextFor(minecraftAdapter, 'paper'));
    expect(Array.isArray(plan.command)).toBe(true);
    expect(plan.command[0]).toBe('java');
    expect(plan.command).toContain('nogui');
    // A shell string would be an injection surface; argv never is.
    expect(plan.command.join(' ')).not.toContain('&&');
  });

  it('stops Minecraft with the in-band command so the world is flushed', () => {
    const plan = minecraftAdapter.startup(contextFor(minecraftAdapter, 'paper'));
    expect(plan.stopCommand).toBe('stop\n');
    expect(plan.stopTimeoutSeconds).toBeGreaterThanOrEqual(60);
  });

  it('picks a Java version appropriate to the Minecraft version', () => {
    expect(javaMajorFor('1.16.5')).toBe(8);
    expect(javaMajorFor('1.17.1')).toBe(16);
    expect(javaMajorFor('1.19.4')).toBe(17);
    expect(javaMajorFor('1.21.4')).toBe(21);
  });

  it('exposes the plugins folder for Paper and mods for Fabric', () => {
    expect(minecraftAdapter.modDirectory?.('paper')).toBe('plugins');
    expect(minecraftAdapter.modDirectory?.('fabric')).toBe('mods');
    expect(minecraftAdapter.modDirectory?.('vanilla')).toBeNull();
  });

  it('requires EULA acceptance', () => {
    const eula = minecraftAdapter.eula?.('paper');
    expect(eula?.file).toBe('eula.txt');
    expect(eula?.contents).toContain('eula=true');
  });

  describe('log inspection', () => {
    it('detects readiness', () => {
      const insight = minecraftAdapter.inspectLog?.(
        '[12:00:00] [Server thread/INFO]: Done (12.345s)! For help, type "help"',
      );
      expect(insight?.ready).toBe(true);
      expect(insight?.level).toBe('success');
    });

    it('explains an out-of-memory crash in plain language', () => {
      const insight = minecraftAdapter.inspectLog?.('java.lang.OutOfMemoryError: Java heap space');
      expect(insight?.level).toBe('error');
      expect(insight?.hint).toMatch(/memory/i);
    });

    it('explains a port conflict', () => {
      const insight = minecraftAdapter.inspectLog?.('**** FAILED TO BIND TO PORT!');
      expect(insight?.hint).toMatch(/port/i);
    });

    it('tracks player joins and leaves', () => {
      const join = minecraftAdapter.inspectLog?.('[12:00:00] [Server thread/INFO]: Notch joined the game');
      expect(join?.playerEvent).toEqual({ type: 'join', name: 'Notch' });

      const leave = minecraftAdapter.inspectLog?.('[12:00:00] [Server thread/INFO]: Notch left the game');
      expect(leave?.playerEvent).toEqual({ type: 'leave', name: 'Notch' });
    });

    it('returns null for ordinary lines', () => {
      expect(minecraftAdapter.inspectLog?.('[12:00:00] [Server thread/INFO]: Preparing spawn area')).toBeNull();
    });
  });
});

describe('valheim adapter', () => {
  it('asks for udp game and query ports', () => {
    expect(valheimAdapter.requiredPorts('valheim-vanilla')).toEqual([
      { purpose: 'game', protocol: 'udp' },
      { purpose: 'query', protocol: 'udp' },
    ]);
  });

  it('defaults to enough memory for a small group', () => {
    expect(valheimAdapter.defaultLimits('valheim-vanilla').memoryMib).toBeGreaterThanOrEqual(4096);
  });

  /**
   * Regression: the guard was case-insensitive and the extraction was not, so
   * a real line ("Got character…", capitalised) entered the branch and then
   * matched nothing — joins were never detected at all. The capture group also
   * pointed at the literal "ZDOID" token rather than at the name after "from".
   */
  describe('player join detection', () => {
    it('reads the name after "from", not the ZDOID token', () => {
      const insight = valheimAdapter.inspectLog?.(
        '03/13/2021 20:35:57: Got character ZDOID from Erik : 1234567890:1',
      );
      expect(insight?.playerEvent).toEqual({ type: 'join', name: 'Erik' });
    });

    it('handles a name with spaces in it', () => {
      const insight = valheimAdapter.inspectLog?.(
        '03/13/2021 20:35:57: Got character ZDOID from Erik the Red : 42:1',
      );
      expect(insight?.playerEvent).toEqual({ type: 'join', name: 'Erik the Red' });
    });

    it('still reads a line with no trailing id', () => {
      const insight = valheimAdapter.inspectLog?.(
        '03/13/2021 20:35:57: Got character ZDOID from Erik',
      );
      expect(insight?.playerEvent).toEqual({ type: 'join', name: 'Erik' });
    });

    it('reports a leave by name', () => {
      const insight = valheimAdapter.inspectLog?.(
        '03/13/2021 20:40:00: Closing connection to Erik',
      );
      expect(insight?.playerEvent).toEqual({ type: 'leave', name: 'Erik' });
    });
  });

  it('passes the allocated port and settings to the launcher', () => {
    const ctx: ServerContext = {
      ...contextFor(minecraftAdapter, 'paper'),
      variantId: 'valheim-vanilla',
      settings: {
        ...defaultsFor(valheimAdapter.settingsSchema('valheim-vanilla')),
        ServerName: 'My Viking Realm',
        WorldName: 'Midgard',
        Password: 'secret',
        Public: false,
      },
      allocations: [
        { ip: '0.0.0.0', port: 2456, purpose: 'game', primary: true },
        { ip: '0.0.0.0', port: 2457, purpose: 'query', primary: false },
      ],
    };
    const plan = valheimAdapter.startup(ctx);
    expect(plan.command[0]).toBe('./start_server.sh');
    expect(plan.command).toContain('-port');
    expect(plan.command).toContain('2456');
    expect(plan.command).toContain('My Viking Realm');
    expect(plan.command).toContain('Midgard');
    expect(plan.command).toContain('-password');
    expect(plan.command).toContain('secret');
    expect(plan.command).toContain('0');
  });

  it('only offers a mods directory on the BepInEx variant', () => {
    expect(valheimAdapter.modDirectory?.('valheim-vanilla')).toBeNull();
    expect(valheimAdapter.modDirectory?.('valheim-bepinex')).toBe('BepInEx/plugins');
  });

  it('explains a port conflict in plain language', () => {
    const insight = valheimAdapter.inspectLog?.('Address already in use');
    expect(insight?.hint).toMatch(/port/i);
  });
});

describe('palworld adapter', () => {
  it('asks for udp game and query ports plus a tcp rest port', () => {
    expect(palworldAdapter.requiredPorts('palworld-vanilla')).toEqual([
      { purpose: 'game', protocol: 'udp' },
      { purpose: 'query', protocol: 'udp' },
      { purpose: 'rest', protocol: 'tcp' },
    ]);
  });

  it('defaults to enough memory that the server will not immediately die', () => {
    expect(palworldAdapter.defaultLimits('palworld-vanilla').memoryMib).toBeGreaterThanOrEqual(8192);
  });

  it('passes the allocated ports to the launcher', () => {
    const ctx: ServerContext = {
      ...contextFor(minecraftAdapter, 'paper'),
      variantId: 'palworld-vanilla',
      settings: defaultsFor(palworldAdapter.settingsSchema('palworld-vanilla')),
      allocations: [
        { ip: '0.0.0.0', port: 8211, purpose: 'game', primary: true },
        { ip: '0.0.0.0', port: 27015, purpose: 'query', primary: false },
      ],
    };
    const plan = palworldAdapter.startup(ctx);
    expect(plan.command).toContain('-port=8211');
    expect(plan.command).toContain('-queryport=27015');
    expect(plan.command[0]).toBe('./PalServer.sh');
  });

  it('omits the threading flags when the user turns them off', () => {
    const ctx = {
      ...contextFor(minecraftAdapter, 'paper'),
      variantId: 'palworld-vanilla',
      settings: { ...defaultsFor(palworldAdapter.settingsSchema('palworld-vanilla')), sf_use_perf_threads: false },
    } as ServerContext;
    expect(palworldAdapter.startup(ctx).command).not.toContain('-useperfthreads');
  });

  it('only offers a mods directory on the modded variant', () => {
    expect(palworldAdapter.modDirectory?.('palworld-vanilla')).toBeNull();
    expect(palworldAdapter.modDirectory?.('palworld-modded')).toContain('~mods');
  });
});

describe('java flags', () => {
  it('leaves headroom below the container limit for non-heap memory', () => {
    // A heap equal to the container limit is the classic silent OOM-kill.
    expect(heapForMemoryLimit(4096)).toBeLessThan(4096);
    expect(heapForMemoryLimit(4096)).toBeGreaterThan(3000);
  });

  it('never returns a heap below the JVM minimum', () => {
    expect(heapForMemoryLimit(256)).toBeGreaterThanOrEqual(512);
  });

  it('emits Aikar flags on request', () => {
    const flags = buildJavaFlags({ preset: 'aikar', memoryMib: 8192 });
    expect(flags).toContain('-XX:+UseG1GC');
    expect(flags.some((f) => f.startsWith('-Xmx'))).toBe(true);
    expect(flags).toContain('-XX:+AlwaysPreTouch');
  });

  it('scales the G1 region size with heap', () => {
    expect(buildJavaFlags({ preset: 'aikar', memoryMib: 4096 })).toContain('-XX:G1HeapRegionSize=8M');
    expect(buildJavaFlags({ preset: 'aikar', memoryMib: 16384 })).toContain('-XX:G1HeapRegionSize=16M');
  });

  it('minimal gives only memory flags', () => {
    expect(buildJavaFlags({ preset: 'minimal', memoryMib: 2048 })).toHaveLength(2);
  });

  it('appends custom flags after the memory flags', () => {
    const flags = buildJavaFlags({ preset: 'custom', memoryMib: 2048, custom: '-XX:+UseZGC -Dfoo=bar' });
    expect(flags).toContain('-XX:+UseZGC');
    expect(flags).toContain('-Dfoo=bar');
  });

  it('tokenises flag strings on whitespace', () => {
    expect(tokenizeFlags('-XX:+UseZGC   -Dfoo=bar')).toEqual(['-XX:+UseZGC', '-Dfoo=bar']);
  });

  it('keeps a quoted value together as one token', () => {
    expect(tokenizeFlags('-Dmotd="hello world" -Dx=1')).toEqual(['-Dmotd=hello world', '-Dx=1']);
  });

  it('ignores empty input', () => {
    expect(tokenizeFlags('   ')).toEqual([]);
  });
});

describe('server.properties round-trip', () => {
  it('parses key=value pairs, ignoring comments', () => {
    const parsed = parseProperties('#comment\nmotd=Hello\nmax-players=20\n\n');
    expect(parsed).toEqual({ motd: 'Hello', 'max-players': '20' });
  });

  it('preserves comments and hand edits when merging', () => {
    const original = '# Minecraft server properties\n# Do not delete\nmotd=Old\ncustom-key=keepme\n';
    const merged = mergeProperties(original, { motd: 'New' });

    expect(merged).toContain('# Do not delete');
    expect(merged).toContain('motd=New');
    // A key we do not model must survive our rewrite.
    expect(merged).toContain('custom-key=keepme');
  });

  it('appends keys that were not already present', () => {
    const merged = mergeProperties('motd=Hi\n', { 'server-port': '25565' });
    expect(merged).toContain('server-port=25565');
  });

  it('escapes newlines so a multi-line value cannot inject a key', () => {
    const merged = mergeProperties('motd=Hi\n', { motd: 'evil\nrcon.password=hunter2' });
    expect(merged).not.toContain('\nrcon.password=hunter2');
    expect(merged).toContain('\\n');
  });
});

describe('unreal ini handling', () => {
  it('parses Palworld option tuples', () => {
    const options = parseTuple('(Difficulty=None,ServerName="My server, with comma",ExpRate=1.500000)');
    expect(options.Difficulty).toBe('None');
    expect(options.ServerName).toBe('My server, with comma');
    expect(options.ExpRate).toBe('1.500000');
  });

  it('round-trips unknown keys so a game update does not lose settings', () => {
    const original = '(Difficulty=None,FutureSetting=42)';
    const parsed = parseTuple(original);
    parsed.Difficulty = 'Hard';
    const rebuilt = stringifyTuple(parsed);
    expect(rebuilt).toContain('FutureSetting=42');
    expect(rebuilt).toContain('Difficulty=Hard');
  });

  it('handles nested tuples without splitting them', () => {
    const parsed = parseTuple('(A=1,B=(C=2,D=3),E=4)');
    expect(parsed.B).toBe('(C=2,D=3)');
    expect(parsed.E).toBe('4');
  });

  it('parses sections', () => {
    const ini = parseIni('[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(A=1)\n');
    expect(ini['/Script/Pal.PalGameWorldSettings']?.['OptionSettings']).toBe('(A=1)');
  });
});

describe('version comparison', () => {
  it('orders Minecraft versions numerically, not lexically', () => {
    // "1.9" must sort above "1.10" lexically but below it numerically.
    expect(compareMinecraftVersions('1.21.4', '1.9')).toBeGreaterThan(0);
    expect(compareMinecraftVersions('1.20', '1.20.1')).toBeLessThan(0);
    expect(compareMinecraftVersions('1.21', '1.21')).toBe(0);
  });
});

describe('modrinth input normalisation', () => {
  it.each([
    ['https://modrinth.com/modpack/cobblemon-fabric', 'cobblemon-fabric'],
    ['https://modrinth.com/modpack/cobblemon-fabric?version=1', 'cobblemon-fabric'],
    ['https://modrinth.com/modpack/better-adventures++/version/e18PwvTU', 'better-adventures++'],
    ['cobblemon-fabric', 'cobblemon-fabric'],
    ['  cobblemon-fabric  ', 'cobblemon-fabric'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeModrinthProject(input)).toBe(expected);
  });

  it('extracts a version id from a Modrinth version URL', () => {
    expect(parseModrinthRef('https://modrinth.com/modpack/better-adventures++/version/e18PwvTU')).toEqual({
      project: 'better-adventures++',
      versionId: 'e18PwvTU',
    });
  });
});

/**
 * Java runtime selection.
 *
 * Regression: a Minecraft 26.2 server was started on `eclipse-temurin:21`,
 * and the game refused to boot with "requires running the server with Java 25
 * or above". The heuristic topped out at 21 and had no notion of the calendar
 * versioning introduced in 2026, and the authoritative value Mojang publishes
 * was fetched by a helper that nothing called.
 */
describe('java runtime selection', () => {
  it('recognises calendar versions as newer than every 1.x release', () => {
    expect(isCalendarVersion('26.2')).toBe(true);
    expect(isCalendarVersion('26.1')).toBe(true);
    expect(isCalendarVersion('1.21.4')).toBe(false);
    expect(isCalendarVersion('1.8.9')).toBe(false);
  });

  it('requires Java 25 for calendar versions', () => {
    expect(javaMajorFor('26.1')).toBe(25);
    expect(javaMajorFor('26.2')).toBe(25);
  });

  it('keeps the historical mapping for 1.x', () => {
    expect(javaMajorFor('1.16.5')).toBe(8);
    expect(javaMajorFor('1.17.1')).toBe(16);
    expect(javaMajorFor('1.19.4')).toBe(17);
    expect(javaMajorFor('1.21.4')).toBe(21);
  });

  it('has a runnable image for every Java major it can return', () => {
    for (const version of ['1.8.9', '1.16.5', '1.17.1', '1.19.4', '1.21.4', '26.2']) {
      const image = javaImageFor(javaMajorFor(version));
      expect(image).toMatch(/^eclipse-temurin:(8|11|17|21|25)-jre-jammy$/);
    }
  });

  it('rounds up to a newer JRE rather than down to an older one', () => {
    // Running on a newer JVM is normally fine; running on an older one never is.
    expect(javaImageFor(25)).toContain('25-');
    expect(javaImageFor(22)).toContain('25-');
    expect(javaImageFor(12)).toContain('17-');
    expect(javaImageFor(99)).toContain('25-');
  });

  it('prefers the recorded runtime over the heuristic', () => {
    const ctx = contextFor(minecraftAdapter, 'paper');
    const guessed = minecraftAdapter.startup({ ...ctx, version: '26.2' });
    expect(guessed.image).toContain('25-jre');

    // A server installed when Mojang said 25, even on a 1.x-looking version.
    const recorded = minecraftAdapter.startup({ ...ctx, version: '1.21.4', runtimeMajor: 25 });
    expect(recorded.image).toContain('25-jre');
  });

  it('explains the "needs a newer Java" crash in plain language', () => {
    const insight = minecraftAdapter.inspectLog?.(
      'Minecraft 26.1 and newer requires running the server with Java 25 or above.',
    );
    expect(insight?.level).toBe('error');
    expect(insight?.hint).toContain('Java 25');
    expect(insight?.hint).toMatch(/reinstall/i);
  });
});

describe('steam branches', () => {
  it('passes nothing for the default branch', () => {
    // Both spellings mean "the released build", and SteamCMD is happiest
    // being given no -beta at all for it.
    expect(steamBranchArgs({ branch: '' })).toEqual([]);
    expect(steamBranchArgs({ branch: '   ' })).toEqual([]);
    expect(steamBranchArgs({ branch: 'public' })).toEqual([]);
    expect(steamBranchArgs({ branch: null })).toEqual([]);
    expect(steamBranchArgs({})).toEqual([]);
  });

  it('builds the -beta flag for a named branch', () => {
    expect(steamBranchArgs({ branch: 'public-test' })).toEqual(['-beta', 'public-test']);
    expect(steamBranchArgs({ branch: 'public-test', branchPassword: 'hunter2' })).toEqual([
      '-beta',
      'public-test',
      '-betapassword',
      'hunter2',
    ]);
  });

  it('ignores a password with no branch to attach it to', () => {
    expect(steamBranchArgs({ branch: '', branchPassword: 'hunter2' })).toEqual([]);
  });

  it('refuses a branch name that would read as a SteamCMD flag', () => {
    // The value becomes its own argv entry, so there is no shell to escape —
    // the risk is a "branch" that SteamCMD parses as an option instead.
    expect(() => steamBranchArgs({ branch: '-validate' })).toThrow(/not a valid Steam branch/i);
    expect(() => steamBranchArgs({ branch: '+app_update' })).toThrow(/not a valid Steam branch/i);
    expect(() => steamBranchArgs({ branch: 'a b' })).toThrow(/not a valid Steam branch/i);
    expect(() => steamBranchArgs({ branch: 'Beta' })).toThrow(/not a valid Steam branch/i);
    expect(() => steamBranchArgs({ branch: 'x'.repeat(65) })).toThrow(/not a valid Steam branch/i);
  });

  it('accepts the shapes Steam actually uses', () => {
    for (const branch of ['public', 'public-test', 'beta_1', 'v1.2.3', 'legacy-0']) {
      expect(isValidSteamBranch(branch)).toBe(true);
    }
  });

  it('reads the branch out of a settings map, defaulting to empty', () => {
    expect(steamBranchFrom({})).toEqual({ branch: '', branchPassword: '' });
    expect(
      steamBranchFrom({ [STEAM_BRANCH_KEY]: 'public-test', [STEAM_BRANCH_PASSWORD_KEY]: 'pw' }),
    ).toEqual({ branch: 'public-test', branchPassword: 'pw' });
  });

  it('gives every SteamCMD game the branch fields, defaulted off', () => {
    for (const adapter of [palworldAdapter, valheimAdapter]) {
      for (const variant of adapter.variants) {
        const defaults = defaultsFor(adapter.settingsSchema(variant.id));
        expect(defaults[STEAM_BRANCH_KEY]).toBe('');
        expect(defaults[STEAM_BRANCH_PASSWORD_KEY]).toBe('');

        // Defaults must produce a plain install — a game that silently
        // installed a beta build would be very hard to diagnose.
        expect(steamBranchArgs(steamBranchFrom(defaults))).toEqual([]);
      }
    }
  });
});

describe('steam install resilience', () => {
  /** Records every container run and answers each from a scripted queue. */
  function fakeTools(outcomes: { exitCode: number; output: string }[]) {
    const runs: string[][] = [];
    const queue = [...outcomes];
    return {
      runs,
      tools: {
        runInContainer: async ({ command }: { command: string[] }) => {
          runs.push(command);
          return queue.shift() ?? { exitCode: 0, output: '' };
        },
      } as unknown as Parameters<typeof steamAppUpdate>[0],
    };
  }

  const ok = { exitCode: 0, output: 'Success! App fully installed.' };
  const missingConfig = {
    exitCode: 8,
    output: "Waiting for user info...OK\nERROR! Failed to install app '2394010' (Missing configuration)\n",
  };

  it('lets SteamCMD bootstrap before asking it to install', async () => {
    // Measured on a fresh server directory: one success in three without this
    // first run, three in three with it.
    const { runs, tools } = fakeTools([ok, ok]);
    await steamAppUpdate(tools, { appId: '2394010' });

    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual(['+login', 'anonymous', '+quit']);
    expect(runs[1]).toContain('+app_update');
  });

  it('retries once when Steam reports the race and then succeeds', async () => {
    const { runs, tools } = fakeTools([ok, missingConfig, ok]);
    await expect(steamAppUpdate(tools, { appId: '2394010' })).resolves.toBeUndefined();

    // bootstrap, failed install, retried install
    expect(runs).toHaveLength(3);
  });

  it('does not retry a request that is simply wrong', async () => {
    // A bad app id or branch fails identically twice; retrying only delays
    // the report and makes it look like a flake.
    const invalid = { exitCode: 1, output: "ERROR! Failed to install app '999' (Invalid platform)" };
    const { runs, tools } = fakeTools([ok, invalid]);

    await expect(steamAppUpdate(tools, { appId: '999' })).rejects.toThrow(/Invalid platform/);
    expect(runs).toHaveLength(2);
  });

  it('leads with the error Steam actually printed', async () => {
    // The old message buried it under 4 KB of progress lines and blamed a
    // Steam outage, which sent people to wait out something else entirely.
    const { tools } = fakeTools([ok, missingConfig, missingConfig]);

    const error = await steamAppUpdate(tools, { appId: '2394010' }).catch((e: unknown) => e);
    const message = (error as Error).message;

    expect(message.split('\n')[0]).toMatch(/ERROR! Failed to install app/);
    expect(message).toMatch(/usually temporary/);
  });

  it('blames the branch when one is set and the failure is not the race', async () => {
    const denied = { exitCode: 1, output: 'ERROR! Failed to install app (App not available)' };
    const { tools } = fakeTools([ok, denied]);

    const error = await steamAppUpdate(tools, {
      appId: '2394010',
      branch: 'public-test',
      branchPassword: 'pw',
    }).catch((e: unknown) => e);

    expect((error as Error).message).toMatch(/branch "public-test"/);
    expect((error as Error).message).toMatch(/password is right/);
  });
});
