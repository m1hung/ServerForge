import Docker from 'dockerode';
import { brand, mibToBytes, type ResourceLimits, type ResourceUsage } from '@serverforge/core';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { config } from '../lib/config.js';
import { hostDataPath } from '../lib/storage-paths.js';
import type {
  ContainerSpec,
  ContainerStatus,
  LogHandle,
  ManagedContainer,
  RunOnceSpec,
  RuntimeDriver,
} from './types.js';

function envList(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

function portBindings(spec: ContainerSpec) {
  const exposed: Record<string, object> = {};
  const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
  for (const port of spec.ports) {
    const key = `${port.containerPort}/${port.protocol}`;
    exposed[key] = {};
    bindings[key] = [{ HostIp: port.hostIp, HostPort: String(port.hostPort) }];
  }
  return { exposed, bindings };
}

/** Docker multiplexed attach/log frames: 8-byte header then payload. */
type LogCarry = {
  buffer: Buffer;
  decoders?: Record<'stdout' | 'stderr', StringDecoder>;
  partial?: Record<'stdout' | 'stderr', string>;
};

export function demuxDockerStream(
  chunk: Buffer,
  onLine: (line: string, stream: 'stdout' | 'stderr') => void,
  carry: LogCarry,
): void {
  carry.decoders ??= { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  carry.partial ??= { stdout: '', stderr: '' };
  carry.buffer = Buffer.concat([carry.buffer, chunk]);
  while (carry.buffer.length >= 8) {
    const streamType = carry.buffer[0];
    const size = carry.buffer.readUInt32BE(4);
    if (carry.buffer.length < 8 + size) return;
    const payload = carry.buffer.subarray(8, 8 + size);
    carry.buffer = carry.buffer.subarray(8 + size);
    const stream = streamType === 2 ? 'stderr' : 'stdout';
    const lines = (carry.partial[stream] + carry.decoders[stream].write(payload)).split(/\r?\n/);
    carry.partial[stream] = lines.pop() ?? '';
    for (const line of lines) onLine(line, stream);
    // Bound an unterminated line without losing the following output.
    if (carry.partial[stream].length > 8192) {
      onLine(`${carry.partial[stream].slice(0, 8192)}… [continued]`, stream);
      carry.partial[stream] = '';
    }
  }
}

export function flushDockerStream(
  carry: LogCarry,
  onLine: (line: string, stream: 'stdout' | 'stderr') => void,
): void {
  for (const stream of ['stdout', 'stderr'] as const) {
    const rest = (carry.partial?.[stream] ?? '') + (carry.decoders?.[stream].end() ?? '');
    if (rest) onLine(rest, stream);
    if (carry.partial) carry.partial[stream] = '';
  }
}

export class DockerRuntime implements RuntimeDriver {
  private readonly docker: Docker;

  constructor(socketPath = config.dockerSocket) {
    this.docker = new Docker({ socketPath });
  }

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async ensureImage(image: string, onProgress?: (line: string) => void): Promise<void> {
    const images = await this.docker.listImages();
    const present = images.some((entry) => (entry.RepoTags ?? []).includes(image));
    if (present) return;

    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (doneError) => (doneError ? reject(doneError) : resolve()),
        (event: { status?: string; progress?: string }) => {
          const line = [event.status, event.progress].filter(Boolean).join(' ');
          if (line) onProgress?.(line);
        },
      );
    });
  }

  private async ensureNetwork(name: string): Promise<void> {
    const existing = await this.docker.listNetworks({ filters: { name: [`^${name}$`] } });
    if (existing.length > 0) return;
    await this.docker.createNetwork({ Name: name, CheckDuplicate: true }).catch(() => undefined);
  }

  async create(spec: ContainerSpec): Promise<string> {
    await this.ensureImage(spec.image);
    if (spec.network) await this.ensureNetwork(spec.network);
    const { exposed, bindings } = portBindings(spec);
    const binds = [`${hostDataPath(spec.dataPath)}:${spec.workingDir}`];
    const container = await this.docker.createContainer({
      name: spec.name,
      Image: spec.image,
      Cmd: spec.command,
      Entrypoint: spec.entrypoint,
      WorkingDir: spec.workingDir,
      Env: envList(spec.env),
      Labels: spec.labels,
      User: spec.user ?? '1000:1000',
      ExposedPorts: exposed,
      OpenStdin: true,
      Tty: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: binds,
        PortBindings: bindings,
        NetworkMode: spec.network,
        Memory: spec.limits.memoryMib > 0 ? mibToBytes(spec.limits.memoryMib) : undefined,
        NanoCpus: spec.limits.cpuCores > 0 ? Math.round(spec.limits.cpuCores * 1e9) : undefined,
        RestartPolicy: { Name: 'no' },
      },
    });
    return container.id;
  }

  async start(id: string): Promise<void> {
    await this.docker.getContainer(id).start();
  }

  async stop(
    id: string,
    options: { stopCommand?: string; timeoutSeconds?: number } = {},
  ): Promise<void> {
    const container = this.docker.getContainer(id);
    try {
      if (options.stopCommand) {
        await this.writeStdin(id, options.stopCommand);
        const deadline = Date.now() + (options.timeoutSeconds ?? 30) * 1000;
        while (Date.now() < deadline) {
          const status = await this.status(id);
          if (!status.running) return;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      await container.stop({ t: options.timeoutSeconds ?? 10 });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 304 || statusCode === 404) return;
      throw error;
    }
  }

  async kill(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).kill();
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 409 || statusCode === 404) return;
      throw error;
    }
  }

  async remove(id: string, options: { force?: boolean } = {}): Promise<void> {
    try {
      await this.docker.getContainer(id).remove({ force: options.force === true });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404) return;
      throw error;
    }
  }

  async status(id: string): Promise<ContainerStatus> {
    try {
      const info = await this.docker.getContainer(id).inspect();
      return {
        exists: true,
        running: info.State.Running,
        state: info.State.Status,
        exitCode: info.State.ExitCode,
        oomKilled: info.State.OOMKilled,
        startedAt: info.State.StartedAt,
        error: info.State.Error || undefined,
      };
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404) return { exists: false, running: false };
      throw error;
    }
  }

  async stats(id: string): Promise<ResourceUsage | null> {
    try {
      const inspect = await this.docker.getContainer(id).inspect();
      if (!inspect.State.Running) return null;
      const raw = (await this.docker.getContainer(id).stats({ stream: false })) as {
        cpu_stats?: {
          cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
          system_cpu_usage?: number;
          online_cpus?: number;
        };
        precpu_stats?: {
          cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
          system_cpu_usage?: number;
        };
        memory_stats?: {
          usage?: number;
          limit?: number;
          stats?: { total_inactive_file?: number; inactive_file?: number; cache?: number };
        };
        networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
      };
      const cpuDelta =
        (raw.cpu_stats?.cpu_usage?.total_usage ?? 0) -
        (raw.precpu_stats?.cpu_usage?.total_usage ?? 0);
      const sysDelta =
        (raw.cpu_stats?.system_cpu_usage ?? 0) - (raw.precpu_stats?.system_cpu_usage ?? 0);
      const cpus =
        raw.cpu_stats?.online_cpus || raw.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
      const cpuPercent = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
      const currentCores = raw.cpu_stats?.cpu_usage?.percpu_usage;
      const previousCores = raw.precpu_stats?.cpu_usage?.percpu_usage;
      const cpuPerCorePercent =
        sysDelta > 0 &&
        currentCores?.length &&
        previousCores?.length === currentCores.length &&
        currentCores.every(
          (value, i) =>
            Number.isFinite(value) &&
            Number.isFinite(previousCores[i]) &&
            value >= previousCores[i]!,
        )
          ? currentCores.map((value, i) => ((value - previousCores[i]!) / sysDelta) * cpus * 100)
          : null;
      const hostConfig = inspect.HostConfig;
      const nanoCpus = hostConfig?.NanoCpus ?? 0;
      const quota = hostConfig?.CpuQuota ?? 0;
      const cpuLimitCores = hostConfig
        ? nanoCpus > 0
          ? nanoCpus / 1e9
          : quota > 0
            ? quota / (hostConfig.CpuPeriod || 100_000)
            : 0
        : undefined;
      const nets = Object.values(raw.networks ?? {});
      const started = inspect.State.StartedAt ? Date.parse(inspect.State.StartedAt) : Date.now();
      // Match Docker CLI memory: exclude reclaimable file cache on cgroup v1/v2.
      const memory = raw.memory_stats?.usage ?? 0;
      const memoryStats = raw.memory_stats?.stats;
      const cache =
        memoryStats?.total_inactive_file ?? memoryStats?.inactive_file ?? memoryStats?.cache ?? 0;
      return {
        timestamp: Date.now(),
        cpuPercent,
        cpuPerCorePercent,
        cpuHostCores: cpus,
        ...(cpuLimitCores !== undefined ? { cpuLimitCores } : {}),
        memoryBytes: cache < memory ? memory - cache : memory,
        memoryLimitBytes: raw.memory_stats?.limit ?? 0,
        diskBytes: null,
        networkRxBytes: nets.reduce((sum, n) => sum + (n.rx_bytes ?? 0), 0),
        networkTxBytes: nets.reduce((sum, n) => sum + (n.tx_bytes ?? 0), 0),
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - started) / 1000)),
      };
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404) return null;
      throw error;
    }
  }

  async streamLogs(
    id: string,
    options: {
      onLine: (line: string, stream: 'stdout' | 'stderr') => void;
      tail?: number;
      onEnd?: (error?: Error) => void;
    },
  ): Promise<LogHandle> {
    const stream = (await this.docker.getContainer(id).logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: options.tail ?? 100,
    })) as NodeJS.ReadableStream;
    const carry = { buffer: Buffer.alloc(0) };
    const onData = (chunk: Buffer) => demuxDockerStream(chunk, options.onLine, carry);
    let ended = false;
    const onEnd = (error?: Error) => {
      if (ended) return;
      ended = true;
      flushDockerStream(carry, options.onLine);
      options.onEnd?.(error);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onEnd);
    return {
      close() {
        stream.off('data', onData);
        stream.off('end', onEnd);
        // Retain an error listener while destroy settles.
        ended = true;
        (stream as { destroy?: () => void }).destroy?.();
      },
    };
  }

  async writeStdin(id: string, data: string): Promise<void> {
    const stream = (await this.docker.getContainer(id).attach({
      stream: true,
      stdin: true,
      hijack: true,
    })) as NodeJS.WritableStream;
    await new Promise<void>((resolve, reject) => {
      stream.write(data, (error) => (error ? reject(error) : resolve()));
    });
    (stream as { end?: () => void }).end?.();
  }

  async updateLimits(id: string, limits: ResourceLimits): Promise<void> {
    await this.docker.getContainer(id).update({
      Memory: limits.memoryMib > 0 ? mibToBytes(limits.memoryMib) : 0,
      NanoCpus: limits.cpuCores > 0 ? Math.round(limits.cpuCores * 1e9) : 0,
    });
  }

  async listManaged(): Promise<ManagedContainer[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${brand.labelNamespace}/managed=true`] },
    });
    return containers.map((entry) => ({
      id: entry.Id,
      name: (entry.Names[0] ?? '').replace(/^\//, ''),
      state: entry.State,
      labels: entry.Labels ?? {},
    }));
  }

  async runOnce(spec: RunOnceSpec): Promise<{ exitCode: number; output: string }> {
    await this.ensureImage(spec.image);
    let output = '';
    const container = await this.docker.createContainer({
      Image: spec.image,
      Cmd: spec.command,
      Entrypoint: spec.entrypoint,
      WorkingDir: '/home/container',
      Env: envList(spec.env ?? {}),
      User: '0:0',
      HostConfig: {
        Binds: [`${hostDataPath(spec.dataPath)}:/home/container`],
        AutoRemove: false,
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let logStream: NodeJS.ReadableStream | undefined;
    try {
      await container.start();
      const completion = (async () => {
        logStream = (await container.logs({
          follow: true,
          stdout: true,
          stderr: true,
        })) as NodeJS.ReadableStream;
        const carry = { buffer: Buffer.alloc(0) };
        await new Promise<void>((resolve, reject) => {
          logStream!.on('data', (chunk: Buffer) =>
            demuxDockerStream(
              chunk,
              (line, stream) => {
                // Keep the useful tail without retaining gigabytes of installer output.
                output = `${output}${line}\n`.slice(-1024 * 1024);
                spec.onLine?.(line, stream);
              },
              carry,
            ),
          );
          logStream!.on('end', () => {
            flushDockerStream(carry, (line, stream) => {
              output = `${output}${line}\n`.slice(-1024 * 1024);
              spec.onLine?.(line, stream);
            });
            resolve();
          });
          logStream!.on('error', reject);
        });
        const result = await container.wait();
        return { exitCode: result.StatusCode ?? 0, output };
      })();
      return await Promise.race([
        completion,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Install container timed out.')),
            spec.timeoutMs ?? 30 * 60 * 1000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      (logStream as { destroy?: () => void } | undefined)?.destroy?.();
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  async selfMounts(): Promise<{ source: string; destination: string }[] | null> {
    try {
      const info = await this.docker.getContainer(os.hostname()).inspect();
      return (info.Mounts ?? []).map((mount) => ({
        source: mount.Source,
        destination: mount.Destination,
      }));
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404) return null;
      return null;
    }
  }
}
