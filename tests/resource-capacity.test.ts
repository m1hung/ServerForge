import { describe, expect, it, vi } from 'vitest';
import type { RuntimeCapabilities } from '@serverforge/core';
vi.mock('../apps/api/src/runtime/docker.js', () => ({ DockerRuntime: class {} }));
vi.mock('../apps/api/src/lib/storage-paths.js', () => ({ localDataPath: (p: string) => p }));
import { allocationCapacity } from '../apps/api/src/services/resources.js';
const capabilities: RuntimeCapabilities = {
  dockerVersion: 'test',
  os: 'linux',
  architecture: 'amd64',
  memoryMib: 8192,
  cpuCores: 4,
  memoryLimit: true,
  cpuLimit: true,
  swapLimit: true,
  pidsLimit: true,
  ioWeight: false,
  cgroupVersion: '2',
};
describe('host allocation budgets', () => {
  it('reserves headroom and counts saved allocations even when games are offline', () => {
    const result = allocationCapacity(
      { memoryMib: 4096, cpuCores: 0, overheadPct: 10 },
      capabilities,
      [{ memoryMib: 1024, cpuCores: 3 }],
    );
    expect(result.memory).toEqual({
      totalMib: 4096,
      headroomMib: 512,
      reservedMib: 1024,
      availableMib: 2560,
    });
    expect(result.warnings).toContain(
      'This host does not support I/O weighting; saved weights are inactive.',
    );
  });
  it('treats unlimited allocations as consuming the available budget and reports CPU contention', () => {
    const result = allocationCapacity(
      { memoryMib: 0, cpuCores: 0, overheadPct: 10 },
      capabilities,
      [
        { memoryMib: 0, cpuCores: 0 },
        { memoryMib: 1024, cpuCores: 2 },
      ],
    );
    expect(result.memory.availableMib).toBe(0);
    expect(result.cpu.overcommitted).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('exceed'))).toBe(true);
  });
});
