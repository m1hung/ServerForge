import Docker from 'dockerode';
import {
  badRequest,
  brand,
  mibToBytes,
  type ResourceLimits,
  type ResourceUsage,
  type RuntimeCapabilities,
  type RuntimePlatform,
  type AppliedAllocation,
} from '@serverforge/core';
import os from 'node:os';
import http from 'node:http';
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
  private capabilityCache?: { at: number; value: RuntimeCapabilities };

  constructor(private readonly socketPath = config.dockerSocket, timeout?: number) {
    this.docker = new Docker({ socketPath, timeout });
  }

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    if (this.capabilityCache && Date.now() - this.capabilityCache.at < 10000)
      return this.capabilityCache.value;
    const info = await this.docker.info();
    const value: RuntimeCapabilities = {
      dockerVersion: info.ServerVersion,
      os: info.OSType,
      architecture:
        ({ x86_64: 'amd64', aarch64: 'arm64' } as Record<string, string>)[info.Architecture] ??
        info.Architecture,
      cpuCores: info.NCPU,
      memoryMib: Math.floor(info.MemTotal / 1024 ** 2),
      memoryLimit: info.MemoryLimit === true,
      cpuLimit: info.CpuCfsQuota === true,
      swapLimit: info.SwapLimit === true,
      pidsLimit: info.PidsLimit === true,
      ioWeight: info.BlkioWeight === true,
      cgroupVersion: info.CgroupVersion ?? 'unknown',
    };
    this.capabilityCache = { at: Date.now(), value };
    return value;
  }

  async ensureImage(
    image: string,
    onProgress?: (line: string) => void,
    platform?: RuntimePlatform,
  ): Promise<void> {
    try {
      const info = await this.docker.getImage(image).inspect();
      if (!platform || `${info.Os}/${info.Architecture}` === platform) return;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }

    const stream = await this.docker.pull(image, platform ? { platform } : {});
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

  private async resourceConfig(limits: ResourceLimits): Promise<Docker.HostConfig> {
    const capabilities = await this.capabilities();
    if (capabilities.os !== 'linux') throw badRequest('ServerForge requires Linux containers.');
    if (!capabilities.pidsLimit)
      throw badRequest('This Docker host cannot enforce the required process limit.');
    if (limits.memoryMib > 0 && !capabilities.memoryLimit)
      throw badRequest('This host cannot enforce memory limits.');
    if (limits.cpuCores > 0 && !capabilities.cpuLimit)
      throw badRequest('This host cannot enforce CPU limits.');
    if (limits.swapMib != null && limits.memoryMib <= 0)
      throw badRequest('Set a memory limit before configuring swap.');
    if (limits.swapMib != null && !capabilities.swapLimit)
      throw badRequest('This host cannot enforce swap limits.');
    return {
      Memory: limits.memoryMib > 0 ? mibToBytes(limits.memoryMib) : 0,
      NanoCpus: limits.cpuCores > 0 ? Math.round(limits.cpuCores * 1e9) : 0,
      ...(limits.swapMib != null
        ? { MemorySwap: mibToBytes(limits.memoryMib + limits.swapMib) }
        : {}),
      ...(capabilities.ioWeight &&
      limits.ioWeight != null &&
      limits.ioWeight >= 10 &&
      limits.ioWeight <= 1000
        ? { BlkioWeight: limits.ioWeight }
        : {}),
      PidsLimit: 2048,
    };
  }

  private async ensureNetwork(name: string): Promise<void> {
    const existing = await this.docker.listNetworks({ filters: { name: [`^${name}$`] } });
    if (existing.length > 0) return;
    await this.docker.createNetwork({ Name: name, CheckDuplicate: true }).catch(() => undefined);
  }

  async create(spec: ContainerSpec): Promise<string> {
    if (spec.user && !/^[1-9]\d*(?::[1-9]\d*)?$/.test(spec.user))
      throw badRequest('Game containers require a non-root numeric user and group.');
    const resources = await this.resourceConfig(spec.limits);
    await this.ensureImage(spec.image, undefined, spec.platform);
    if (spec.network) await this.ensureNetwork(spec.network);
    const { exposed, bindings } = portBindings(spec);
    const binds = [`${hostDataPath(spec.dataPath)}:${spec.workingDir}`];
    const container = await this.docker.createContainer({
      name: spec.name,
      platform: spec.platform,
      Image: spec.image,
      Cmd: spec.command,
      Entrypoint: spec.entrypoint,
      WorkingDir: spec.workingDir,
      StopSignal: spec.stopSignal,
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
        ...resources,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '3' } },
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
    options: { stopCommand?: string; timeoutSeconds?: number; forceAfterTimeout?: boolean } = {},
  ): Promise<void> {
    const container = this.docker.getContainer(id);
    try {
      if (options.stopCommand || options.forceAfterTimeout === false) {
        if (options.stopCommand) await this.writeStdin(id, options.stopCommand);
        else if ((await this.status(id)).running) {
          const signal = ((await container.inspect()).Config as { StopSignal?: string }).StopSignal || 'SIGTERM';
          await container.kill({ signal });
        }
        const deadline = Date.now() + (options.timeoutSeconds ?? 30) * 1000;
        while (Date.now() < deadline) {
          const status = await this.status(id);
          if (!status.running) return;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (options.forceAfterTimeout === false) throw new Error('The game did not stop gracefully before the timeout. No recovery snapshot was taken; inspect its console and retry.');
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
    // docker-modem sends attach options as a POST body. Docker may upgrade
    // before consuming that body, injecting JSON into the game's stdin.
    // An explicitly empty HTTP body keeps commands byte-for-byte intact.
    await new Promise<void>((resolve, reject) => {
      const request = http.request({ socketPath: this.socketPath, method: 'POST', path: `/containers/${encodeURIComponent(id)}/attach?stream=1&stdin=1`, headers: { Connection: 'Upgrade', Upgrade: 'tcp', 'Content-Length': '0' } });
      request.setTimeout(5000, () => request.destroy(new Error('Docker console attach timed out.')));
      request.once('error', reject);
      request.once('response', (response) => { response.resume(); reject(new Error(`Docker console attach failed (${response.statusCode}).`)); });
      request.once('upgrade', (_response, socket) => {
        request.setTimeout(0);
        socket.setTimeout(5000, () => socket.destroy(new Error('Docker console write timed out.')));
        socket.once('error', reject);
        socket.resume();
        socket.end(data, () => { socket.destroy(); resolve(); });
      });
      request.end();
    });
  }

  async updateLimits(id: string, limits: ResourceLimits): Promise<void> {
    await this.docker.getContainer(id).update(await this.resourceConfig(limits));
  }
  async appliedAllocation(id: string): Promise<AppliedAllocation | null> {
    try {
      const container = await this.docker.getContainer(id).inspect();
      if (!container.State.Running) return null;
      const limits = container.HostConfig;
      const memory = limits.Memory || 0;
      const protectedContainer =
        /^[1-9]\d*(?::[1-9]\d*)?$/.test(container.Config.User) &&
        (limits.CapDrop || []).includes('ALL') &&
        (limits.SecurityOpt || []).some(
          (value: string) => value === 'no-new-privileges' || value === 'no-new-privileges:true',
        );
      const logRotation =
        limits.LogConfig?.Config?.['max-size'] === '20m' &&
        limits.LogConfig?.Config?.['max-file'] === '3';
      const capabilities = await this.capabilities();
      const image = await this.docker.getImage(container.Image).inspect().catch(() => null);
      return {
        imageId: container.Image,
        imageReference: container.Config.Image,
        platform: image ? `${image.Os}/${image.Architecture}` : undefined,
        memoryMib: memory / 1024 ** 2,
        cpuCores: limits.NanoCpus
          ? limits.NanoCpus / 1e9
          : limits.CpuQuota && limits.CpuQuota > 0
            ? limits.CpuQuota / (limits.CpuPeriod || 100000)
            : 0,
        swapMib: !limits.MemorySwap
          ? null
          : limits.MemorySwap < 0
            ? -1
            : Math.max(0, limits.MemorySwap - memory) / 1024 ** 2,
        ioWeight: capabilities.ioWeight ? limits.BlkioWeight || null : null,
        pidsLimit: limits.PidsLimit ?? null,
        protected: protectedContainer,
        logRotation,
        warnings: [
          ...(!protectedContainer || !logRotation || limits.PidsLimit !== 2048
            ? ['Restart this server to apply the release container protections.']
            : []),
          ...(!capabilities.ioWeight ? ['I/O weighting is unavailable on this Docker host.'] : []),
        ],
      };
    } catch {
      return null;
    }
  }

  async listManaged(): Promise<ManagedContainer[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${brand.labelNamespace}/managed=true`] },
    });
    const managed: ManagedContainer[] = [];
    for (const entry of containers) {
      try {
        // Desktop's list endpoint reports VM paths (/host_mnt/...), whereas
        // inspect returns the original host bind. Never guess by stripping a
        // prefix: ownership recovery must match the actual configured mount.
        const details = await this.docker.getContainer(entry.Id).inspect();
        managed.push({ id: entry.Id, name: details.Name.replace(/^\//, ''), state: details.State.Status, labels: details.Config.Labels ?? {}, dataPath: details.Mounts.find((mount) => 'Type' in mount && mount.Type === 'bind' && mount.Destination === details.Config.WorkingDir)?.Source });
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      }
    }
    return managed;
  }

  async runOnce(spec: RunOnceSpec): Promise<{ exitCode: number; output: string }> {
    return this.runTemporary(spec);
  }

  async cleanupTemporary(dataPath: string): Promise<void> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${brand.labelNamespace}/temporary=true`] },
    });
    for (const container of containers) {
      const details = await this.docker.getContainer(container.Id).inspect().catch((error: { statusCode?: number }) => { if (error.statusCode !== 404) throw error; return null; });
      if (
        details?.Mounts?.some(
          (mount) =>
            mount.Destination === '/home/container' && mount.Source === hostDataPath(dataPath),
        )
      )
        await this.docker.getContainer(container.Id).remove({ force: true });
    }
  }

  async repairOwnership(dataPath: string, owner: string): Promise<void> {
    if (!/^[1-9]\d*:[1-9]\d*$/.test(owner))
      throw badRequest('File ownership must use a non-root numeric user and group.');
    const result = await this.runTemporary(
      {
        image: 'node:22.23.2-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284',
        entrypoint: ['/usr/bin/find'],
        // Symlink ownership is irrelevant to access; never follow installer
        // links into the image or change their targets outside this bind.
        command: ['/home/container', '-xdev', '(', '-type', 'd', '-o', '-type', 'f', ')', '-exec', '/bin/chown', '--', owner, '{}', '+'],
        dataPath,
        timeoutMs: 60000,
        limits: { memoryMib: 128, cpuCores: 1, diskMib: 0, swapMib: 0 },
      },
      true,
    );
    if (result.exitCode !== 0)
      throw new Error(`Could not set install file ownership: ${result.output.trim().slice(-2048)}`);
  }

  private async runTemporary(
    spec: RunOnceSpec,
    ownership = false,
  ): Promise<{ exitCode: number; output: string }> {
    spec.signal?.throwIfAborted();
    const resources = await this.resourceConfig(
      spec.limits ?? { memoryMib: 2048, cpuCores: 2, diskMib: 0 },
    );
    await this.ensureImage(spec.image, undefined, spec.platform);
    spec.signal?.throwIfAborted();
    let output = '';
    const container = await this.docker.createContainer({
      Image: spec.image,
      platform: spec.platform,
      Cmd: spec.command,
      Entrypoint: spec.entrypoint,
      WorkingDir: '/home/container',
      Env: envList({ HOME: '/home/container', ...spec.env }),
      User: ownership ? '0:0' : '1000:1000',
      Labels: {
        [`${brand.labelNamespace}/temporary`]: 'true',
        [`${brand.labelNamespace}/purpose`]: ownership ? 'ownership' : 'install',
      },
      HostConfig: {
        ...resources,
        CapDrop: ['ALL'],
        ...(ownership
          ? { CapAdd: ['CHOWN', 'DAC_OVERRIDE'], NetworkMode: 'none', ReadonlyRootfs: true }
          : {}),
        SecurityOpt: ['no-new-privileges:true'],
        LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '3' } },
        Binds: [`${hostDataPath(spec.dataPath)}:/home/container`],
        AutoRemove: false,
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let logStream: NodeJS.ReadableStream | undefined;
    let abort: (() => void) | undefined;
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
          abort = () => reject(spec.signal?.reason ?? new Error('Installation cancelled.'));
          if (spec.signal?.aborted) abort();
          else spec.signal?.addEventListener('abort', abort, { once: true });
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Install container timed out.')),
            spec.timeoutMs ?? 30 * 60 * 1000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (abort) spec.signal?.removeEventListener('abort', abort);
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
