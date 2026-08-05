import { conflict } from '@serverforge/core';
import { prisma } from '@serverforge/db';
import type { Prisma } from '@serverforge/db';

/**
 * Port allocation.
 *
 * Ports are pre-materialised rows, so claiming one is a single conditional
 * UPDATE. That is what makes concurrent deploys safe without a lock table:
 * two requests racing for the last free port produce one winner and one
 * clean "no ports available" error, never a double-bind at container start.
 */

export interface AllocationRequest {
  purpose: string;
  protocol: 'tcp' | 'udp';
}

export async function claimAllocations(
  tx: Prisma.TransactionClient,
  input: {
    nodeId: string;
    serverId: string;
    requests: AllocationRequest[];
    /** Preferred host port for the primary allocation. */
    preferredPort?: number;
  },
): Promise<{ id: string; ip: string; port: number; purpose: string; primary: boolean }[]> {
  const claimed: { id: string; ip: string; port: number; purpose: string; primary: boolean }[] = [];

  for (const [index, request] of input.requests.entries()) {
    const isPrimary = index === 0;
    const preferred = isPrimary ? input.preferredPort : undefined;

    const allocation = await claimOne(tx, {
      nodeId: input.nodeId,
      serverId: input.serverId,
      purpose: request.purpose,
      primary: isPrimary,
      preferredPort: preferred,
    });

    claimed.push(allocation);
  }

  return claimed;
}

async function claimOne(
  tx: Prisma.TransactionClient,
  input: {
    nodeId: string;
    serverId: string;
    purpose: string;
    primary: boolean;
    preferredPort?: number;
  },
) {
  if (input.preferredPort !== undefined) {
    const specific = await tx.allocation.findFirst({
      where: { nodeId: input.nodeId, port: input.preferredPort, serverId: null },
    });
    if (!specific) {
      throw conflict(
        `Port ${input.preferredPort} is already taken on this machine.`,
        'Pick a different port, or leave it blank and we will choose a free one.',
      );
    }
    return assign(tx, specific.id, input);
  }

  const free = await tx.allocation.findFirst({
    where: { nodeId: input.nodeId, serverId: null },
    orderBy: { port: 'asc' },
  });

  if (!free) {
    throw conflict(
      'This machine has no free ports left.',
      'Widen the port range in Settings → Nodes, or delete a server you no longer use.',
    );
  }

  return assign(tx, free.id, input);
}

async function assign(
  tx: Prisma.TransactionClient,
  allocationId: string,
  input: { serverId: string; purpose: string; primary: boolean },
) {
  // The `serverId: null` guard in the where clause is the actual lock: if a
  // concurrent transaction claimed it first, this updates zero rows.
  const result = await tx.allocation.updateMany({
    where: { id: allocationId, serverId: null },
    data: { serverId: input.serverId, purpose: input.purpose, primary: input.primary },
  });

  if (result.count === 0) {
    throw conflict('That port was taken while we were setting up. Try again.');
  }

  const allocation = await tx.allocation.findUniqueOrThrow({ where: { id: allocationId } });
  return {
    id: allocation.id,
    ip: allocation.ip,
    port: allocation.port,
    purpose: allocation.purpose,
    primary: allocation.primary,
  };
}

/** Frees every port a server holds. Called on delete. */
export async function releaseAllocations(serverId: string): Promise<void> {
  await prisma.allocation.updateMany({
    where: { serverId },
    data: { serverId: null, primary: false, purpose: 'game' },
  });
}

/** Moves a server's primary allocation to a new port. */
export async function changePrimaryPort(serverId: string, port: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await tx.allocation.findFirst({ where: { serverId, primary: true } });
    if (!current) throw conflict('This server has no primary port assigned.');
    if (current.port === port) return;

    const target = await tx.allocation.findFirst({
      where: { nodeId: current.nodeId, port, serverId: null },
    });
    if (!target) {
      throw conflict(
        `Port ${port} is not available on this machine.`,
        'It is either in use by another server or outside the allowed range.',
      );
    }

    await tx.allocation.update({
      where: { id: current.id },
      data: { serverId: null, primary: false, purpose: 'game' },
    });
    await tx.allocation.update({
      where: { id: target.id },
      data: { serverId, primary: true, purpose: current.purpose },
    });
  });
}

/** Free port count, shown on the node card in admin. */
export async function countFreePorts(nodeId: string): Promise<number> {
  return prisma.allocation.count({ where: { nodeId, serverId: null } });
}
