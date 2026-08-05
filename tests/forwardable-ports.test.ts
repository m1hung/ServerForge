import { describe, expect, it } from 'vitest';
import { forwardablePorts, mapPorts } from '../apps/api/src/services/ports.js';
import { minecraftAdapter } from '../packages/adapters/src/minecraft/index.js';
import { palworldAdapter } from '../packages/adapters/src/palworld/index.js';
import { defaultsFor } from '../packages/core/src/settings-schema.js';
import type { ServerContext } from '../packages/adapters/src/types.js';

/**
 * Guards the one rule in automatic port forwarding that has teeth.
 *
 * UPnP hands the router a request to expose a port to the entire internet.
 * Adapters declare several ports per server on adjacent numbers — game, rcon,
 * query — and only the first is meant for players. rcon in particular is a
 * remote console: exposing it offers the internet a command channel into the
 * server, and the allocator will happily hand it 25501 when the game port is
 * 25500, so "forward the range" is exactly the wrong instinct.
 *
 * These assertions are deliberately phrased as "rcon is absent" rather than
 * "the list equals X", so a newly declared port type has to be consciously
 * added rather than silently inheriting exposure.
 */
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

describe('forwardablePorts', () => {
  it('forwards the game port and nothing else', () => {
    const declared = [
      { containerPort: 25565, purpose: 'game', protocol: 'tcp' as const },
      { containerPort: 25575, purpose: 'rcon', protocol: 'tcp' as const },
      { containerPort: 25565, purpose: 'query', protocol: 'udp' as const },
    ];
    const allocations = [
      { ip: '0.0.0.0', port: 25500, purpose: 'game' },
      { ip: '0.0.0.0', port: 25501, purpose: 'rcon' },
      { ip: '0.0.0.0', port: 25502, purpose: 'query' },
    ];

    const forwardable = forwardablePorts(declared, allocations);

    expect(forwardable).toHaveLength(1);
    expect(forwardable[0]?.hostPort).toBe(25500);
    // The whole point: these were adjacent in the allocation pool.
    expect(forwardable.map((b) => b.hostPort)).not.toContain(25501);
    expect(forwardable.map((b) => b.hostPort)).not.toContain(25502);
  });

  it('never widens what mapPorts already published', () => {
    const declared = [
      { containerPort: 25565, purpose: 'game', protocol: 'tcp' as const },
      { containerPort: 25575, purpose: 'rcon', protocol: 'tcp' as const },
    ];
    const allocations = [
      { ip: '0.0.0.0', port: 25500, purpose: 'game' },
      { ip: '0.0.0.0', port: 25501, purpose: 'rcon' },
    ];

    const published = mapPorts(declared, allocations).map((b) => b.hostPort);
    const forwarded = forwardablePorts(declared, allocations).map((b) => b.hostPort);

    expect(forwarded.every((port) => published.includes(port))).toBe(true);
    expect(forwarded.length).toBeLessThan(published.length);
  });

  it('minecraft: exposes the play port, keeps rcon private', () => {
    const allocations = [
      { ip: '0.0.0.0', port: 25500, purpose: 'game', primary: true },
      { ip: '0.0.0.0', port: 25501, purpose: 'rcon', primary: false },
    ];
    const plan = minecraftAdapter.startup(contextWith('paper', allocations, minecraftAdapter));
    const forwardable = forwardablePorts(plan.ports, allocations);

    expect(forwardable.map((b) => b.hostPort)).toEqual([25500]);
  });

  it('palworld: forwards the udp game port, not query or rest', () => {
    const allocations = [
      { ip: '0.0.0.0', port: 25600, purpose: 'game', primary: true },
      { ip: '0.0.0.0', port: 25601, purpose: 'query', primary: false },
      { ip: '0.0.0.0', port: 25602, purpose: 'rest', primary: false },
    ];
    const plan = palworldAdapter.startup(
      contextWith('palworld-vanilla', allocations, palworldAdapter as typeof minecraftAdapter),
    );
    const forwardable = forwardablePorts(plan.ports, allocations);

    expect(forwardable).toHaveLength(1);
    expect(forwardable[0]?.hostPort).toBe(25600);
    // Palworld is UDP; a TCP-only forward would look correct and work for
    // nobody, so the protocol has to survive the filter.
    expect(forwardable[0]?.protocol).toBe('udp');
  });

  it('returns nothing when no game allocation exists', () => {
    const forwardable = forwardablePorts(
      [{ containerPort: 25575, purpose: 'rcon', protocol: 'tcp' }],
      [{ ip: '0.0.0.0', port: 25501, purpose: 'rcon' }],
    );
    expect(forwardable).toEqual([]);
  });
});
