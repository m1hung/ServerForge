import { describe, expect, it } from 'vitest';
import { minecraftAdapter } from '../packages/adapters/src/minecraft/index.js';
import { palworldAdapter } from '../packages/adapters/src/palworld/index.js';
import { valheimAdapter } from '../packages/adapters/src/valheim/index.js';
import { buildCatalogue, getAdapter, getVariant, listAdapters } from '../packages/adapters/src/registry.js';
import { buildJavaFlags, heapForMemoryLimit, isCalendarVersion, javaImageFor, javaMajorFor, tokenizeFlags } from '../packages/adapters/src/minecraft/java.js';
import { mergeProperties, parseProperties } from '../packages/adapters/src/util/properties.js';
import { parseIni, parseTuple, stringifyTuple } from '../packages/adapters/src/util/ini.js';
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
