import { conflict } from '@serverforge/core';
import type { Prisma } from '@serverforge/db';

type Available = { id: string; ip: string; port: number };
/** One contiguous block on one interface also satisfies Valheim's base + 1 discovery port. */
export function choosePortBlock(
  rows: Available[],
  count: number,
  preferredPort?: number,
): Available[] | null {
  if (!count) return [];
  const byAddress = new Map(rows.map((row) => [`${row.ip}:${row.port}`, row]));
  for (const first of rows) {
    if (preferredPort !== undefined && first.port !== preferredPort) continue;
    const block = Array.from({ length: count }, (_, index) =>
      byAddress.get(`${first.ip}:${first.port + index}`),
    );
    if (block.every((row): row is Available => !!row)) return block;
  }
  return null;
}
export async function allocateServerPorts(
  tx: Prisma.TransactionClient,
  nodeId: string,
  serverId: string,
  purposes: { purpose: string }[],
  preferredPort?: number,
) {
  const rows = await tx.allocation.findMany({
    where: { nodeId, OR: [{ serverId: null }, { serverId }] },
    orderBy: [{ port: 'asc' }, { ip: 'asc' }],
  });
  const block = choosePortBlock(rows, purposes.length, preferredPort);
  if (!block)
    throw conflict(
      preferredPort
        ? 'That port and its required adjacent ports are not available in this machine’s allocation pool.'
        : 'This machine has no available block of game ports. Add allocations or free an unused server’s ports.',
    );
  await tx.allocation.updateMany({
    where: { nodeId, serverId },
    data: { serverId: null, primary: false, purpose: 'game' },
  });
  for (const [index, row] of block.entries()) {
    const result = await tx.allocation.updateMany({
      where: { id: row.id, serverId: null },
      data: { serverId, purpose: purposes[index]!.purpose, primary: index === 0 },
    });
    if (result.count !== 1) throw conflict('Another server claimed these ports. Try another port.');
  }
  return block;
}
