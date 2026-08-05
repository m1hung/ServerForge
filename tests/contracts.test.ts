import { describe, expect, it } from 'vitest';
import {
  createServerSchema,
  resourceLimitsSchema,
  serverNameSchema,
  updateServerSchema,
} from '../packages/core/src/contracts.js';

/**
 * Round-trip safety.
 *
 * Regression: the API returns `swapMib: null` for a server with no swap
 * override, but `resourceLimitsSchema` marked that field `optional()` rather
 * than nullable — so a client that read a server and wrote it straight back
 * got a 422. Every edit form does exactly that, so the write schema must
 * accept the read schema's own output.
 */
describe('resourceLimitsSchema', () => {
  it('accepts the shape the API actually returns', () => {
    const fromApi = {
      memoryMib: 4096,
      cpuCores: 2,
      diskMib: 10240,
      swapMib: null,
      ioWeight: 500,
    };
    expect(resourceLimitsSchema.safeParse(fromApi).success).toBe(true);
  });

  it('accepts limits with the optional fields absent', () => {
    expect(
      resourceLimitsSchema.safeParse({ memoryMib: 4096, cpuCores: 2, diskMib: 10240 }).success,
    ).toBe(true);
  });

  it('still rejects genuinely wrong values', () => {
    expect(resourceLimitsSchema.safeParse({ memoryMib: -1, cpuCores: 2, diskMib: 1 }).success).toBe(
      false,
    );
    expect(
      resourceLimitsSchema.safeParse({ memoryMib: 'lots', cpuCores: 2, diskMib: 1 }).success,
    ).toBe(false);
  });
});

describe('updateServerSchema', () => {
  it('accepts a full edit-form submission', () => {
    const result = updateServerSchema.safeParse({
      name: 'Friday night survival',
      description: 'For the group',
      limits: { memoryMib: 4096, cpuCores: 2, diskMib: 10240 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts clearing the description', () => {
    expect(updateServerSchema.safeParse({ description: null }).success).toBe(true);
  });

  it('accepts a partial edit', () => {
    expect(updateServerSchema.safeParse({ name: 'Just a rename' }).success).toBe(true);
  });

  it('round-trips a limits object straight from the API', () => {
    const result = updateServerSchema.safeParse({
      name: 'Test',
      limits: { memoryMib: 4096, cpuCores: 2, diskMib: 10240, swapMib: null, ioWeight: 500 },
    });
    expect(result.success).toBe(true);
  });
});

describe('serverNameSchema', () => {
  it.each([
    'Friday night survival',
    "Alex's world",
    'test-server-2',
    'SMP 1.21',
  ])('accepts %s', (name) => {
    expect(serverNameSchema.safeParse(name).success).toBe(true);
  });

  it.each([
    ['a', 'too short'],
    ['', 'empty'],
    ['x'.repeat(49), 'too long'],
    ['!!!', 'no leading word character'],
  ])('rejects %s (%s)', (name) => {
    expect(serverNameSchema.safeParse(name).success).toBe(false);
  });

  it('trims surrounding whitespace rather than rejecting it', () => {
    // Pasting a name with a stray space should just work.
    const result = serverNameSchema.safeParse('  Friday night  ');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe('Friday night');
  });

  it('explains the rule rather than saying "invalid"', () => {
    const result = serverNameSchema.safeParse('!!!');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/letters|characters/i);
    }
  });
});

describe('createServerSchema', () => {
  it('defaults version to latest and starts the server', () => {
    const result = createServerSchema.safeParse({
      name: 'New server',
      gameId: 'minecraft-java',
      variantId: 'paper',
      limits: { memoryMib: 4096, cpuCores: 2, diskMib: 10240 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe('latest');
      expect(result.data.startOnCreate).toBe(true);
      expect(result.data.settings).toEqual({});
    }
  });

  it('rejects a port outside the unprivileged range', () => {
    const base = {
      name: 'New server',
      gameId: 'minecraft-java',
      variantId: 'paper',
      limits: { memoryMib: 4096, cpuCores: 2, diskMib: 10240 },
    };
    expect(createServerSchema.safeParse({ ...base, port: 80 }).success).toBe(false);
    expect(createServerSchema.safeParse({ ...base, port: 25565 }).success).toBe(true);
  });
});
