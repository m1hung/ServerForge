import fs from 'node:fs/promises';
import path from 'node:path';
import {
  badRequest,
  type ResourceLimits,
  type RuntimeCapabilities,
  type NodeCapacity,
} from '@serverforge/core';
import { prisma, type Prisma, type Node as ServerNode } from '@serverforge/db';
import { DockerRuntime } from '../runtime/docker.js';
import { localDataPath } from '../lib/storage-paths.js';

const runtime = new DockerRuntime();
import { storageSpace, STORAGE_RESERVE_BYTES as reserveBytes } from '../lib/storage-space.js';
export { requireFreeSpace } from '../lib/storage-space.js';

export function allocationCapacity(
  node: Pick<ServerNode, 'memoryMib' | 'cpuCores' | 'overheadPct'>,
  capabilities: RuntimeCapabilities,
  servers: Pick<ResourceLimits, 'memoryMib' | 'cpuCores'>[],
): NodeCapacity {
  const totalMib =
    node.memoryMib > 0 ? Math.min(node.memoryMib, capabilities.memoryMib) : capabilities.memoryMib;
  const headroomMib = Math.min(
    totalMib,
    Math.max(512, Math.ceil((totalMib * node.overheadPct) / 100)),
  );
  const usable = Math.max(0, totalMib - headroomMib);
  const reservedMib = servers.reduce((sum, server) => sum + (server.memoryMib || usable), 0);
  const totalCores =
    node.cpuCores > 0 ? Math.min(node.cpuCores, capabilities.cpuCores) : capabilities.cpuCores;
  const reservedCores = servers.reduce((sum, server) => sum + (server.cpuCores || totalCores), 0);
  const warnings: string[] = [];
  if (reservedMib > usable)
    warnings.push(
      'Saved memory allocations exceed this host’s capacity. Existing games are not stopped; reduce allocations before increasing them.',
    );
  if (reservedCores > totalCores)
    warnings.push('CPU is overcommitted. Servers may compete for processing time.');
  if (!capabilities.ioWeight)
    warnings.push('This host does not support I/O weighting; saved weights are inactive.');
  if (!capabilities.swapLimit) warnings.push('This host cannot enforce a swap allowance.');
  return {
    capabilities,
    memory: { totalMib, headroomMib, reservedMib, availableMib: Math.max(0, usable - reservedMib) },
    cpu: { totalCores, reservedCores, overcommitted: reservedCores > totalCores },
    disk: null,
    warnings,
  };
}

export async function nodeCapacity(node: ServerNode, excludingId?: string): Promise<NodeCapacity> {
  const [capabilities, servers] = await Promise.all([
    runtime.capabilities(),
    prisma.server.findMany({
      where: {
        nodeId: node.id,
        state: { not: 'deleting' },
        ...(excludingId ? { id: { not: excludingId } } : {}),
      },
      select: { memoryMib: true, cpuCores: true },
    }),
  ]);
  const result = allocationCapacity(node, capabilities, servers);
  result.disk = await storageSpace(localDataPath(node.dataRoot)).catch(() => null);
  if (!result.disk) result.warnings.push('Storage availability could not be measured.');
  else if (result.disk.freeBytes < reserveBytes)
    result.warnings.push(
      'Less than 1 GiB of free storage remains. New uploads and installations are blocked.',
    );
  return result;
}

/** The transaction owns the node lock through the associated allocation write. */
export async function validateAllocation(
  tx: Prisma.TransactionClient,
  node: ServerNode,
  limits: ResourceLimits,
  previous?: { id: string; memoryMib: number; cpuCores: number },
) {
  const capabilities = await runtime.capabilities();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(193609, hashtext(${node.id}))`;
  const others = await tx.server.findMany({
    where: {
      nodeId: node.id,
      state: { not: 'deleting' },
      ...(previous ? { id: { not: previous.id } } : {}),
    },
    select: { memoryMib: true, cpuCores: true },
  });
  const capacity = allocationCapacity(node, capabilities, others);
  const usable = capacity.memory.totalMib - capacity.memory.headroomMib;
  const requested = limits.memoryMib || usable;
  const old = previous ? previous.memoryMib || usable : 0;
  if ((!previous || requested > old) && requested > capacity.memory.availableMib)
    throw badRequest(
      `Only ${(capacity.memory.availableMib / 1024).toFixed(2)} GiB can be allocated after host headroom and other servers. Reduce memory allocations before increasing this server’s allocation.`,
    );
  if (
    (!previous || limits.cpuCores !== previous.cpuCores) &&
    limits.cpuCores > capacity.cpu.totalCores
  )
    throw badRequest(
      `This host has ${capacity.cpu.totalCores} CPU cores available to a single server.`,
    );
  if (limits.memoryMib > 0 && !capabilities.memoryLimit)
    throw badRequest('This host cannot enforce a memory limit.');
  if (limits.cpuCores > 0 && !capabilities.cpuLimit)
    throw badRequest('This host cannot enforce a CPU limit.');
  if (limits.swapMib != null && (limits.memoryMib <= 0 || !capabilities.swapLimit))
    throw badRequest(
      'A swap allowance requires an enforceable memory limit and host swap-limit support.',
    );
  return capacity;
}

// ponytail: one bounded cached directory walk per server; use a dedicated sampler
// if installations routinely exceed 500,000 files or ten-second scan times.
const diskCache = new Map<string, { at: number; bytes: number | null; pending: boolean }>();
export function measuredServerBytes(root: string): number | null {
  const existing = diskCache.get(root);
  if (existing?.pending || (existing && Date.now() - existing.at < 60000)) return existing.bytes;
  if (!existing && diskCache.size >= 1000) {
    const oldest = [...diskCache].find(([, entry]) => !entry.pending);
    if (!oldest) return null;
    diskCache.delete(oldest[0]);
  }
  const entry = { at: Date.now(), bytes: existing?.bytes ?? null, pending: true };
  diskCache.set(root, entry);
  void (async () => {
    let bytes = 0,
      count = 0;
    const paths = [root];
    while (paths.length) {
      const current = paths.pop()!;
      const stat = await fs.lstat(current);
      if (++count > 500000 || Date.now() - entry.at > 10000)
        throw new Error('Storage scan exceeded its work limit.');
      if (stat.isDirectory()) {
        for (const child of await fs.readdir(current)) paths.push(path.join(current, child));
      } else if (stat.isFile()) bytes += stat.size;
    }
    entry.bytes = bytes;
  })()
    .catch(() => {
      entry.bytes = null;
    })
    .finally(() => {
      entry.at = Date.now();
      entry.pending = false;
    });
  return entry.bytes;
}
