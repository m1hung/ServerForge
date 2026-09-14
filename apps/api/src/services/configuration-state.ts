import { createHash } from 'node:crypto';
import type { Server } from '@serverforge/db';

/** Hash only the configuration that is materialized on the next game start. */
export function configurationFingerprint(server: Server): string {
  const sorted = (value: unknown) => Object.fromEntries(Object.entries((value || {}) as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify({
    game: server.gameId, variant: server.variantId, version: server.version,
    build: server.build, java: server.javaMajor,
    settings: sorted(server.settings), environment: sorted(server.environment),
    startup: server.startupOverride, flags: server.javaFlagsPreset, custom: server.customJavaFlags,
    memory: server.memoryMib, cpu: server.cpuCores, swap: server.swapMib, io: server.ioWeight,
  })).digest('hex');
}
