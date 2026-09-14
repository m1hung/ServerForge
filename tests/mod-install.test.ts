import { describe, expect, it, vi } from 'vitest';
import { defaultsFor } from '../packages/core/src/settings-schema.js';
import { getAdapter } from '../packages/adapters/src/registry.js';
import type { InstallTools, ServerContext } from '../packages/adapters/src/types.js';

describe('shipped modded editions', () => {
  it('installs the pinned Valheim loader and launches it with the selected world and port', async () => {
    const adapter = getAdapter('valheim');
    const ctx: ServerContext = {
      serverUid: 'test',
      name: 'Test',
      dataPath: '/test',
      version: 'latest',
      variantId: 'valheim-bepinex',
      settings: {
        ...defaultsFor(adapter.settingsSchema('valheim-bepinex')),
        WorldName: 'My World',
        Password: 'secret',
      },
      memoryMib: 4096,
      cpuCores: 2,
      allocations: [{ ip: '0.0.0.0', port: 26000, purpose: 'game', primary: true }],
      environment: {},
      javaFlagsPreset: 'balanced',
    };
    const tools: InstallTools = {
      mkdir: vi.fn(),
      download: vi.fn(),
      unzip: vi.fn(),
      remove: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn(async () => null),
      exists: vi.fn(async () => false),
      listDir: vi.fn(async () => []),
      rename: vi.fn(),
      runInContainer: vi.fn(async () => ({ exitCode: 0, output: 'Success! App fully installed.' })),
    };
    await adapter.install(ctx, tools, { phase: vi.fn(), log: vi.fn() });
    expect(tools.download).toHaveBeenCalledWith(
      expect.stringContaining('5.4.2350.zip'),
      '.serverforge/loader.zip',
      { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    );
    expect(tools.unzip).toHaveBeenCalledWith('.serverforge/loader.zip', '.', { strip: 1 });
    const plan = adapter.startup(ctx);
    expect(plan.entrypoint).toEqual([]);
    expect(plan.command).toContain('LD_PRELOAD=/home/container/doorstop_libs/libdoorstop_x64.so');
    expect(plan.command).toContain('DOORSTOP_ENABLED=1');
    expect(plan.command).toContain('./valheim_server.x86_64');
    expect(plan.command).toContain('My World');
    expect(plan.command).toContain('26000');
    expect(adapter.startup({ ...ctx, variantId: 'valheim-vanilla' }).command).not.toContain(
      'DOORSTOP_ENABLED=1',
    );
  });

  it('gives every shipped game a usable mod directory and describes the Palworld Linux limit', () => {
    for (const [game, variant, directory] of [
      ['minecraft-java', 'paper', 'plugins'],
      ['minecraft-java', 'fabric', 'mods'],
      ['minecraft-java', 'forge', 'mods'],
      ['minecraft-java', 'neoforge', 'mods'],
      ['minecraft-java', 'custom-modpack', 'mods'],
      ['minecraft-java', 'modrinth-modpack', 'mods'],
      ['valheim', 'valheim-bepinex', 'BepInEx/plugins'],
      ['palworld', 'palworld-modded', 'Pal/Content/Paks/~mods'],
    ])
      expect(getAdapter(game!).modDirectory?.(variant!)).toBe(directory);
    const palworld = getAdapter('palworld');
    expect(palworld.variants.find((v) => v.id === 'palworld-modded')?.detail).toMatch(
      /require Windows/,
    );
    expect(palworld.settingsSchema('palworld-modded').map((s) => s.key)).not.toContain(
      'sf_enable_ue4ss',
    );
  });
});
