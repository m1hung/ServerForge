import type { Prisma } from '@serverforge/db';
import { describe, expect, it, vi } from 'vitest';
import { allocateServerPorts, choosePortBlock } from '../apps/api/src/services/port-allocation.js';
const rows = [25500, 25502, 25503, 25504, 25506].map((port) => ({
  id: String(port),
  ip: '0.0.0.0',
  port,
}));
describe('contiguous game port allocation', () => {
  it('skips holes so game and discovery ports stay adjacent', () => {
    expect(choosePortBlock(rows, 3)?.map((row) => row.port)).toEqual([25502, 25503, 25504]);
  });
  it('does not stitch ports from different interfaces together', () => {
    expect(
      choosePortBlock(
        [
          { ...rows[0]!, port: 25500 },
          { ...rows[1]!, ip: '192.168.1.20', port: 25501 },
        ],
        2,
      ),
    ).toBeNull();
  });
  it('honors an explicit game port only when the whole block is available', () => {
    expect(choosePortBlock(rows, 2, 25502)?.map((row) => row.port)).toEqual([25502, 25503]);
    expect(choosePortBlock(rows, 2, 25500)).toBeNull();
  });
  it('reports a concurrent claim so the caller transaction can roll back all allocations', async () => {
    const tx = {
      allocation: {
        findMany: vi.fn().mockResolvedValue(rows),
        updateMany: vi
          .fn()
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
      },
    };
    await expect(
      allocateServerPorts(
        tx as unknown as Prisma.TransactionClient,
        'node',
        'server',
        [{ purpose: 'game' }, { purpose: 'query' }],
        25502,
      ),
    ).rejects.toThrow('Another server claimed');
  });
});
