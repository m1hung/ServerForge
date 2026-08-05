import { describe, expect, it } from 'vitest';
import { mapPorts } from '../apps/api/src/services/ports.js';
import { minecraftAdapter } from '../packages/adapters/src/minecraft/index.js';
import { palworldAdapter } from '../packages/adapters/src/palworld/index.js';
import { defaultsFor } from '../packages/core/src/settings-schema.js';
import type { ServerContext } from '../packages/adapters/src/types.js';

/**
 * Regression tests for the port mapping.
 *
 * The original bug: the container port was taken from the adapter's declared
 * default (25565) while the game was configured to listen on the *allocated*
 * port (25500). Docker happily published host 25500 -> container 25565, where
 * nothing was listening. The server reported "online", the console worked
 * (it goes over stdin, not TCP), and players got only
 * "connection refused: getsockopt".
 *
 * Loopback made it worse: docker-proxy accepts the connection before failing
 * to forward, so a naive `telnet localhost 25500` looked fine.
 */
describe('mapPorts', () => {
  const allocations = [
    { ip: '0.0.0.0', port: 25500, purpose: 'game' },
    { ip: '0.0.0.0', port: 25501, purpose: 'rcon' },
  ];

  it('publishes the container port that the game actually listens on', () => {
    const bindings = mapPorts(
      [{ containerPort: 25565, purpose: 'game', protocol: 'tcp' }],
      allocations,
    );

    expect(bindings).toEqual([
      { hostIp: '0.0.0.0', hostPort: 25500, containerPort: 25500, protocol: 'tcp' },
    ]);
  });

  it('matches allocations to declarations by purpose, not by order', () => {
    const bindings = mapPorts(
      [
        { containerPort: 25575, purpose: 'rcon', protocol: 'tcp' },
        { containerPort: 25565, purpose: 'game', protocol: 'tcp' },
      ],
      allocations,
    );

    expect(bindings.map((b) => b.hostPort)).toEqual([25501, 25500]);
    expect(bindings.every((b) => b.hostPort === b.containerPort)).toBe(true);
  });

  it('keeps a fixed container port for games that cannot be reconfigured', () => {
    const bindings = mapPorts(
      [{ containerPort: 27015, purpose: 'game', protocol: 'udp', fixed: true }],
      [{ ip: '0.0.0.0', port: 25500, purpose: 'game' }],
    );

    expect(bindings[0]).toEqual({
      hostIp: '0.0.0.0',
      hostPort: 25500,
      containerPort: 27015,
      protocol: 'udp',
    });
  });

  it('skips declarations with no matching allocation rather than guessing', () => {
    const bindings = mapPorts(
      [
        { containerPort: 25565, purpose: 'game', protocol: 'tcp' },
        { containerPort: 8080, purpose: 'metrics', protocol: 'tcp' },
      ],
      [{ ip: '0.0.0.0', port: 25500, purpose: 'game' }],
    );

    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.purpose).toBeUndefined();
    expect(bindings[0]?.hostPort).toBe(25500);
  });

  it('preserves the bind address from the allocation', () => {
    const bindings = mapPorts(
      [{ containerPort: 25565, purpose: 'game', protocol: 'tcp' }],
      [{ ip: '127.0.0.1', port: 25500, purpose: 'game' }],
    );
    expect(bindings[0]?.hostIp).toBe('127.0.0.1');
  });
});

/**
 * The end-to-end invariant: whatever port the adapter writes into the game's
 * configuration must be the port we publish. These assertions tie the two
 * halves together per game, which is the coupling that actually broke.
 */
describe('published port matches the configured listen port', () => {
  function contextWith(
    variantId: string,
    allocations: ServerContext['allocations'],
    adapter: typeof minecraftAdapter,
  ): ServerContext {
    return {
      serverUid: 'test',
      name: 'Test',
      dataPath: '/srv/test',
      version: '1.21.4',
      build: null,
      variantId,
      settings: defaultsFor(adapter.settingsSchema(variantId)),
      memoryMib: 4096,
      cpuCores: 2,
      allocations,
      environment: {},
      javaFlagsPreset: 'balanced',
      customJavaFlags: null,
    };
  }

  it('minecraft: every published port equals its host allocation', () => {
    const allocations = [
      { ip: '0.0.0.0', port: 25500, purpose: 'game', primary: true },
      { ip: '0.0.0.0', port: 25501, purpose: 'rcon', primary: false },
    ];
    const plan = minecraftAdapter.startup(contextWith('paper', allocations, minecraftAdapter));
    const bindings = mapPorts(plan.ports, allocations);

    expect(bindings).toHaveLength(2);
    for (const binding of bindings) {
      expect(binding.containerPort).toBe(binding.hostPort);
    }
  });

  it('palworld: the -port argument matches the published container port', () => {
    const allocations = [
      { ip: '0.0.0.0', port: 25600, purpose: 'game', primary: true },
      { ip: '0.0.0.0', port: 25601, purpose: 'query', primary: false },
      { ip: '0.0.0.0', port: 25602, purpose: 'rest', primary: false },
    ];
    const plan = palworldAdapter.startup(
      contextWith('palworld-vanilla', allocations, palworldAdapter as typeof minecraftAdapter),
    );
    const bindings = mapPorts(plan.ports, allocations);

    // The launcher is told -port=25600, so 25600 is what must be published.
    expect(plan.command).toContain('-port=25600');
    const game = bindings.find((b) => b.hostPort === 25600);
    expect(game?.containerPort).toBe(25600);

    expect(plan.command).toContain('-queryport=25601');
    const query = bindings.find((b) => b.hostPort === 25601);
    expect(query?.containerPort).toBe(25601);
  });
});
