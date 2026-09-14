import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';

const docker = vi.hoisted(() => ({ inspect: vi.fn(), stats: vi.fn(), logs: vi.fn() }));
vi.mock('dockerode', () => ({
  default: class {
    getContainer() {
      return docker;
    }
  },
}));
vi.mock('../apps/api/src/lib/config.js', () => ({ config: { dockerSocket: '/none' } }));
import {
  demuxDockerStream,
  flushDockerStream,
  DockerRuntime,
} from '../apps/api/src/runtime/docker.js';

function frame(text: string | Buffer, stream = 1) {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('Docker console decoding', () => {
  it('preserves split headers, split lines and UTF-8 characters across frames', () => {
    const carry = { buffer: Buffer.alloc(0) };
    const lines: string[] = [];
    const onLine = (line: string, stream: string) => lines.push(`${stream}:${line}`);
    const emoji = Buffer.from('🌍');
    const bytes = Buffer.concat([
      frame('Server '),
      frame(emoji.subarray(0, 2)),
      frame(emoji.subarray(2)),
      frame(' ready\r\n\n'),
      frame('warning\n', 2),
      frame('final'),
    ]);
    for (let i = 0; i < bytes.length; i += 3)
      demuxDockerStream(bytes.subarray(i, i + 3), onLine, carry);
    flushDockerStream(carry, onLine);
    expect(lines).toEqual(['stdout:Server 🌍 ready', 'stdout:', 'stderr:warning', 'stdout:final']);
  });

  it('flushes the final unterminated line at end and closes the Docker attachment', async () => {
    const source = new PassThrough();
    docker.logs.mockResolvedValue(source);
    const lines: string[] = [];
    const onEnd = vi.fn();
    const handle = await new DockerRuntime().streamLogs('id', {
      onLine: (line) => lines.push(line),
      onEnd,
    });
    source.end(frame('last line'));
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledOnce());
    expect(lines).toEqual(['last line']);
    handle.close();
    expect(source.destroyed).toBe(true);
    expect(source.listenerCount('data')).toBe(0);
  });
});

describe('Docker resource measurements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docker.inspect.mockResolvedValue({
      State: { Running: true, StartedAt: new Date(Date.now() - 12_000).toISOString() },
      HostConfig: { NanoCpus: 4e9 },
    });
    docker.stats.mockResolvedValue({
      cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 1000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 },
      memory_stats: { usage: 1024, limit: 4096, stats: { inactive_file: 256 } },
      networks: { eth0: { rx_bytes: 100, tx_bytes: 20 }, eth1: { rx_bytes: 50, tx_bytes: 30 } },
    });
  });
  it('measures multi-core CPU, excludes cache from memory, and sums network interfaces', async () => {
    const stats = await new DockerRuntime().stats('id');
    expect(stats).toMatchObject({
      cpuPercent: 160,
      cpuPerCorePercent: null,
      cpuLimitCores: 4,
      cpuHostCores: 4,
      memoryBytes: 768,
      memoryLimitBytes: 4096,
      diskBytes: null,
      networkRxBytes: 150,
      networkTxBytes: 50,
    });
    expect(stats!.uptimeSeconds).toBeGreaterThanOrEqual(12);
  });
  it('calculates each core from its own counter delta, without distributing the total', async () => {
    const raw = await docker.stats();
    raw.cpu_stats.cpu_usage.percpu_usage = [150, 100, 25, 25];
    raw.precpu_stats.cpu_usage.percpu_usage = [50, 50, 0, 0];
    const stats = await new DockerRuntime().stats('id');
    expect(stats!.cpuPerCorePercent).toEqual([80, 40, 20, 20]);
    expect(stats!.cpuPerCorePercent!.reduce((sum, value) => sum + value, 0)).toBe(
      stats!.cpuPercent,
    );
  });
  it.each([
    [[150, 100], undefined],
    [[150, 100], [50]],
    [
      [150, 100],
      [200, 50],
    ],
    [[], []],
  ])(
    'keeps per-core readings unavailable for missing or reset counters (%j, %j)',
    async (current, previous) => {
      const raw = await docker.stats();
      raw.cpu_stats.cpu_usage.percpu_usage = current;
      raw.precpu_stats.cpu_usage.percpu_usage = previous;
      expect((await new DockerRuntime().stats('id'))!.cpuPerCorePercent).toBeNull();
    },
  );
  it.each([
    [{ NanoCpus: 1500000000 }, 1.5],
    [{ NanoCpus: 0, CpuQuota: 150000, CpuPeriod: 100000 }, 1.5],
    [{ NanoCpus: 0, CpuQuota: -1 }, 0],
  ])('reports the active container CPU quota (%j)', async (HostConfig, expected) => {
    docker.inspect.mockResolvedValue({ State: { Running: true }, HostConfig });
    expect((await new DockerRuntime().stats('id'))!.cpuLimitCores).toBe(expected);
  });
  it('returns no reading for a stopped or removed container', async () => {
    const runtime = new DockerRuntime();
    docker.inspect.mockResolvedValueOnce({ State: { Running: false } });
    expect(await runtime.stats('id')).toBeNull();
    expect(docker.stats).not.toHaveBeenCalled();
    docker.inspect.mockRejectedValueOnce({ statusCode: 404 });
    expect(await runtime.stats('id')).toBeNull();
  });
  it('surfaces Docker failures instead of returning zero usage', async () => {
    docker.stats.mockRejectedValueOnce(new Error('Docker unreachable'));
    await expect(new DockerRuntime().stats('id')).rejects.toThrow('Docker unreachable');
  });
});
