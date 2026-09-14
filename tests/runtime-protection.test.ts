import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  info: vi.fn(),
  create: vi.fn(),
  inspect: vi.fn(),
  pull: vi.fn(),
}));
vi.mock('dockerode', () => ({
  default: class {
    info = state.info;
    createContainer = state.create;
    getImage() {
      return { inspect: state.inspect };
    }
    pull = state.pull;
  },
}));
vi.mock('../apps/api/src/lib/config.js', () => ({ config: { dockerSocket: '/none' } }));
vi.mock('../apps/api/src/lib/storage-paths.js', () => ({ hostDataPath: (p: string) => p }));
import { DockerRuntime } from '../apps/api/src/runtime/docker.js';
import type { ContainerSpec } from '../apps/api/src/runtime/types.js';
const spec: ContainerSpec = {
  name: 'test',
  image: 'test-image',
  command: ['sleep', '1'],
  workingDir: '/data',
  env: {},
  dataPath: '/fixture',
  limits: { memoryMib: 128, cpuCores: 1, diskMib: 0 },
  ports: [],
  labels: {},
};
beforeEach(() => {
  vi.resetAllMocks();
  state.info.mockResolvedValue({
    OSType: 'linux',
    Architecture: 'x86_64',
    NCPU: 4,
    MemTotal: 4 * 1024 ** 3,
    MemoryLimit: true,
    CpuCfsQuota: true,
    SwapLimit: true,
    PidsLimit: true,
  });
  state.inspect.mockResolvedValue({ Os: 'linux', Architecture: 'amd64' });
  state.create.mockResolvedValue({ id: 'container' });
});
describe('runtime enforcement', () => {
  it('translates additional swap, preserves unset swap, and omits unsupported I/O weighting', async () => {
    const runtime = new DockerRuntime();
    await runtime.create({ ...spec, limits: { ...spec.limits, swapMib: 64, ioWeight: 500 } });
    expect(state.create.mock.calls[0]![0].HostConfig).toMatchObject({
      Memory: 128 * 1024 ** 2,
      MemorySwap: 192 * 1024 ** 2,
      PidsLimit: 2048,
    });
    expect(state.create.mock.calls[0]![0].HostConfig).not.toHaveProperty('BlkioWeight');
    await runtime.create(spec);
    expect(state.create.mock.calls[1]![0].HostConfig).not.toHaveProperty('MemorySwap');
    expect(await runtime.capabilities()).toMatchObject({
      architecture: 'amd64',
      memoryMib: 4096,
      ioWeight: false,
    });
  });
  it('applies valid I/O weights only on a capable host', async () => {
    state.info.mockResolvedValue({ ...(await state.info()), BlkioWeight: true });
    await new DockerRuntime().create({ ...spec, limits: { ...spec.limits, ioWeight: 500 } });
    expect(state.create.mock.calls[0]![0].HostConfig.BlkioWeight).toBe(500);
  });
  it('refuses root users and unenforceable memory limits before creating anything', async () => {
    await expect(new DockerRuntime().create({ ...spec, user: '0:0' })).rejects.toThrow(/non-root/);
    state.info.mockResolvedValue({ ...(await state.info()), MemoryLimit: false });
    await expect(new DockerRuntime().create(spec)).rejects.toThrow(/memory limits/);
    expect(state.create).not.toHaveBeenCalled();
  });
  it('rejects a swap override without a memory ceiling', async () => {
    await expect(
      new DockerRuntime().create({
        ...spec,
        limits: { memoryMib: 0, cpuCores: 1, diskMib: 0, swapMib: 0 },
      }),
    ).rejects.toThrow(/memory limit/);
    expect(state.create).not.toHaveBeenCalled();
  });
  it('never silently falls back to a weaker container configuration', async () => {
    state.create.mockRejectedValue(new Error('no-new-privileges unsupported'));
    await expect(new DockerRuntime().create(spec)).rejects.toThrow(/no-new-privileges/);
    expect(state.create).toHaveBeenCalledOnce();
  });
});
