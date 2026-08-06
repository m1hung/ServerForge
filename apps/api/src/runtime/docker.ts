import Docker from 'dockerode';
import { hostname } from 'node:os';
import type { Duplex } from 'node:stream';
import { brand, mibToBytes, type ResourceLimits, type ResourceUsage } from '@serverforge/core';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { hostDataPath } from '../lib/storage-paths.js';
import type {
  ContainerSpec,
  ContainerStatus,
  ExecResult,
  LogStreamHandle,
  RuntimeDriver,
} from './types.js';

/**
 * Docker implementation of the runtime driver.
 *
 * Containers run unprivileged as uid 1000 with a read-only root filesystem
 * except for the bind-mounted data directory: a game server should be able
 * to write its world and nothing else.
 */
export class DockerRuntime implements RuntimeDriver {
  readonly kind = 'docker' as const;
  private readonly docker: Docker;

  /**
   * Whether `no-new-privileges` is usable on this host.
   *
   * On some kernel/Docker combinations setting it makes *every* exec fail with
   * "operation not permitted", regardless of image or user — which turns a
   * defence-in-depth measure into a total outage. It is therefore probed once
   * and applied only where it actually works, rather than assumed.
   *
   * `null` = not yet probed.
   */
  private noNewPrivileges: boolean | null = null;

  constructor(socketPath: string = config.DOCKER_SOCKET) {
    this.docker = new Docker({ socketPath });
  }

  /**
   * Runs a throwaway container with the flag set and sees whether it can exec.
   * The result is cached for the life of the process: the answer is a property
   * of the host, not of the image.
   */
  private async canUseNoNewPrivileges(image: string): Promise<boolean> {
    if (this.noNewPrivileges !== null) return this.noNewPrivileges;

    try {
      const probe = await this.docker.createContainer({
        Image: image,
        Cmd: ['/bin/sh', '-c', 'exit 0'],
        Tty: false,
        Labels: { [`${brand.labelNamespace}/role`]: 'probe' },
        HostConfig: {
          SecurityOpt: ['no-new-privileges'],
          NetworkMode: 'none',
          AutoRemove: false,
        },
      });

      try {
        await probe.start();
        const result = (await probe.wait()) as { StatusCode: number };
        this.noNewPrivileges = result.StatusCode === 0;
      } finally {
        await probe.remove({ force: true }).catch(() => undefined);
      }
    } catch {
      this.noNewPrivileges = false;
    }

    if (!this.noNewPrivileges) {
      logger.warn(
        'This host rejects containers started with no-new-privileges, so that hardening is ' +
          'disabled. Everything still runs with all capabilities dropped and as a non-root user.',
      );
    }

    return this.noNewPrivileges;
  }

  private async securityOpt(image: string): Promise<string[]> {
    return (await this.canUseNoNewPrivileges(image)) ? ['no-new-privileges'] : [];
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
    const [existing] = await this.docker.listImages({ filters: { reference: [image] } });
    if (existing) return;

    onProgress?.(`Pulling ${image} — first use of this runtime, so it takes a minute…`);

    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (error) => (error ? reject(error) : resolve()),
        (event: { status?: string; progress?: string }) => {
          if (event.status) onProgress?.(`${event.status}${event.progress ? ` ${event.progress}` : ''}`);
        },
      );
    });
  }

  async create(spec: ContainerSpec): Promise<string> {
    await this.ensureNetwork(spec.network);

    const exposed: Record<string, Record<string, never>> = {};
    const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
    for (const port of spec.ports) {
      const key = `${port.containerPort}/${port.protocol}`;
      exposed[key] = {};
      bindings[key] = [{ HostIp: port.hostIp, HostPort: String(port.hostPort) }];
    }

    const container = await this.docker.createContainer({
      name: spec.name,
      Image: spec.image,
      Cmd: spec.command,
      // Only when the adapter asks: an image's entrypoint may be doing setup
      // the command depends on. See StartupPlan.entrypoint.
      ...(spec.entrypoint ? { Entrypoint: spec.entrypoint } : {}),
      WorkingDir: spec.workingDir,
      Env: toEnv(spec.env),
      ExposedPorts: exposed,
      Labels: spec.labels,
      // stdin stays open so console commands can be written to the process.
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: '1000:1000',
      HostConfig: {
        Binds: [`${hostDataPath(spec.dataPath)}:/home/container:rw`],
        PortBindings: bindings,
        NetworkMode: spec.network,
        RestartPolicy: { Name: 'no' },
        // The panel owns restarts: Docker restarting a crashed server behind
        // our back would desync state and hide crash loops from the user.
        ...this.resourceConfig(spec.limits),
        // Defence in depth: a game server never needs to raise privileges.
        // Probed rather than assumed — see canUseNoNewPrivileges().
        SecurityOpt: await this.securityOpt(spec.image),
        CapDrop: ['ALL'],
        // Servers routinely spawn many threads; the default is too low for
        // modded Minecraft and produces confusing "can't create thread" errors.
        PidsLimit: 512,
        LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '3' } },
      },
    });

    return container.id;
  }

  private resourceConfig(limits: ResourceLimits) {
    const memory = limits.memoryMib > 0 ? mibToBytes(limits.memoryMib) : 0;
    // Null and undefined both mean "no swap override"; null is what the
    // database stores, so checking only for undefined would have treated an
    // unset value as a swap limit of NaN bytes.
    const swap = limits.swapMib != null ? mibToBytes(limits.swapMib) : memory;

    return {
      Memory: memory,
      // Equal to Memory means "no swap on top of the limit", which keeps a
      // leaking server from dragging the whole host into swap thrash.
      MemorySwap: memory > 0 ? Math.max(memory, swap) : 0,
      MemoryReservation: memory > 0 ? Math.floor(memory * 0.75) : 0,
      CpuPeriod: 100_000,
      CpuQuota: limits.cpuCores > 0 ? Math.round(limits.cpuCores * 100_000) : 0,
      BlkioWeight: limits.ioWeight ?? 500,
      OomKillDisable: false,
    };
  }

  async start(containerId: string): Promise<void> {
    await this.docker.getContainer(containerId).start();
  }

  async stop(
    containerId: string,
    options: { stopCommand?: string; timeoutSeconds: number },
  ): Promise<void> {
    const container = this.docker.getContainer(containerId);

    // Games like Minecraft flush their world on an in-band `stop` command.
    // SIGTERM works too, but the in-band path is what the game itself
    // documents as safe, so prefer it when the adapter provides one.
    if (options.stopCommand) {
      try {
        await this.writeStdin(containerId, options.stopCommand);
        const stopped = await this.waitForExit(containerId, options.timeoutSeconds * 1000);
        if (stopped) return;
        logger.warn({ containerId }, 'graceful stop command timed out, falling back to SIGTERM');
      } catch (error) {
        logger.warn({ containerId, error }, 'could not write stop command, falling back to SIGTERM');
      }
    }

    try {
      await container.stop({ t: options.timeoutSeconds });
    } catch (error) {
      if (!isNotModified(error) && !isNotFound(error)) throw error;
    }
  }

  private async waitForExit(containerId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.status(containerId);
      if (!status.running) return true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  async kill(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).kill();
    } catch (error) {
      // Killing something that already exited is the goal, not a failure. It
      // is also routine: "force stop" is what people press when a server is
      // in the middle of dying on its own. Docker answers 409 here rather
      // than the 304 it uses for stop.
      if (!isNotModified(error) && !isNotFound(error) && !isNotRunning(error)) throw error;
    }
  }

  async remove(containerId: string, options: { force?: boolean } = {}): Promise<void> {
    try {
      await this.docker.getContainer(containerId).remove({ force: options.force ?? true, v: false });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async status(containerId: string): Promise<ContainerStatus> {
    try {
      const info = await this.docker.getContainer(containerId).inspect();
      return {
        exists: true,
        running: info.State.Running,
        state: info.State.Status,
        exitCode: info.State.ExitCode,
        startedAt: info.State.StartedAt,
        oomKilled: info.State.OOMKilled,
      };
    } catch (error) {
      if (isNotFound(error)) return { exists: false, running: false };
      throw error;
    }
  }

  async writeStdin(containerId: string, data: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    const stream = (await container.attach({
      stream: true,
      stdin: true,
      hijack: true,
    })) as unknown as Duplex;

    await new Promise<void>((resolve, reject) => {
      stream.write(data, (error) => (error ? reject(error) : resolve()));
    });
    stream.end();
  }

  async streamLogs(
    containerId: string,
    handlers: { onLine: (line: string, stream: 'stdout' | 'stderr') => void; onEnd?: () => void },
    options: { tail?: number; since?: number } = {},
  ): Promise<LogStreamHandle> {
    const container = this.docker.getContainer(containerId);
    const stream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: options.tail ?? 200,
      ...(options.since ? { since: Math.floor(options.since / 1000) } : {}),
    })) as unknown as NodeJS.ReadableStream;

    // Docker multiplexes stdout/stderr into one stream with an 8-byte header
    // per frame when the container has no TTY. Demux, then split on newlines,
    // carrying any partial line into the next chunk.
    let stdoutBuffer = '';
    let stderrBuffer = '';

    const emit = (chunk: Buffer, which: 'stdout' | 'stderr') => {
      const text = chunk.toString('utf8');
      const buffer = which === 'stdout' ? stdoutBuffer + text : stderrBuffer + text;
      const lines = buffer.split('\n');
      const remainder = lines.pop() ?? '';
      if (which === 'stdout') stdoutBuffer = remainder;
      else stderrBuffer = remainder;
      for (const line of lines) handlers.onLine(line.replace(/\r$/, ''), which);
    };

    const stdout = new WritableCollector((chunk) => emit(chunk, 'stdout'));
    const stderr = new WritableCollector((chunk) => emit(chunk, 'stderr'));
    this.docker.modem.demuxStream(stream, stdout as unknown as NodeJS.WritableStream, stderr as unknown as NodeJS.WritableStream);

    stream.on('end', () => handlers.onEnd?.());
    stream.on('error', () => handlers.onEnd?.());

    return {
      close() {
        (stream as unknown as { destroy?: () => void }).destroy?.();
      },
    };
  }

  async stats(containerId: string): Promise<ResourceUsage | null> {
    try {
      const raw = (await this.docker
        .getContainer(containerId)
        .stats({ stream: false })) as unknown as DockerStats;

      return {
        timestamp: Date.now(),
        cpuPercent: computeCpuPercent(raw),
        memoryBytes: memoryUsage(raw),
        memoryLimitBytes: raw.memory_stats?.limit ?? 0,
        diskBytes: 0, // filled in by the disk watcher; Docker cannot report it
        networkRxBytes: sumNetwork(raw, 'rx_bytes'),
        networkTxBytes: sumNetwork(raw, 'tx_bytes'),
        uptimeSeconds: 0,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async updateLimits(containerId: string, limits: ResourceLimits): Promise<void> {
    await this.docker.getContainer(containerId).update(this.resourceConfig(limits));
  }

  async runOnce(options: {
    image: string;
    command: string[];
    dataPath: string;
    env?: Record<string, string>;
    workingDir?: string;
    timeoutMs?: number;
    onLine?: (line: string) => void;
  }): Promise<ExecResult> {
    await this.ensureImage(options.image, options.onLine);

    const container = await this.docker.createContainer({
      Image: options.image,
      Cmd: options.command,
      WorkingDir: options.workingDir ?? '/home/container',
      Env: toEnv(options.env ?? {}),
      User: '1000:1000',
      Tty: false,
      Labels: {
        [`${brand.labelNamespace}/managed`]: 'true',
        [`${brand.labelNamespace}/role`]: 'install',
      },
      HostConfig: {
        Binds: [`${hostDataPath(options.dataPath)}:/home/container:rw`],
        AutoRemove: false,
        NetworkMode: 'bridge',
        SecurityOpt: await this.securityOpt(options.image),
        // Install jobs are short-lived but can be memory hungry (Forge's
        // installer, SteamCMD's decompression). 4 GiB is a safe ceiling.
        Memory: mibToBytes(4096),
        PidsLimit: 512,
      },
    });

    const chunks: string[] = [];
    let partial = '';
    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      chunks.push(text);
      const lines = (partial + text).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) options.onLine?.(line.trim());
    };

    try {
      const stream = (await container.attach({
        stream: true,
        stdout: true,
        stderr: true,
      })) as unknown as NodeJS.ReadableStream;
      const out = new WritableCollector(collect);
      const sink = out as unknown as NodeJS.WritableStream;
      this.docker.modem.demuxStream(stream, sink, sink);

      await container.start();

      const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
      const result = await Promise.race([
        container.wait(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('install step timed out')), timeoutMs),
        ),
      ]);

      return { exitCode: (result as { StatusCode: number }).StatusCode, output: chunks.join('') };
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  async listManaged(): Promise<{ id: string; name: string; running: boolean }[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${brand.labelNamespace}/managed=true`] },
    });
    return containers.map((c) => ({
      id: c.Id,
      name: (c.Names[0] ?? '').replace(/^\//, ''),
      running: c.State === 'running',
    }));
  }

  /**
   * Docker sets a container's hostname to its own short id unless overridden,
   * which is how a container finds itself over the socket it is given. Running
   * on the host instead, that lookup simply 404s — indistinguishable from any
   * other reason we cannot tell, and both mean "no mount table to check".
   */
  async selfMounts(): Promise<{ source: string; destination: string }[] | null> {
    try {
      const self = await this.docker.getContainer(hostname()).inspect();
      return (self.Mounts ?? []).map((mount) => ({
        source: mount.Source,
        destination: mount.Destination,
      }));
    } catch {
      return null;
    }
  }

  /**
   * Puts this process's own container on the game network.
   *
   * RCON is the only console some games have, and reaching it means reaching
   * the game container: published host ports are not routable from inside
   * another container on any platform worth relying on, while a shared Docker
   * network resolves container names.
   *
   * Done here rather than in the compose file on purpose. The network is
   * created by `ensureNetwork` the first time a server is deployed, so on any
   * panel that has ever run a game it already exists *without* Compose's
   * ownership labels — and a compose file that suddenly claims it fails the
   * next `npm start` with a label mismatch. Attaching at runtime upgrades
   * cleanly, and a panel running on the host has nothing to do.
   */
  async joinGameNetwork(): Promise<void> {
    let self;
    try {
      self = await this.docker.getContainer(hostname()).inspect();
    } catch {
      // Not in a container, or the daemon cannot identify us. Either way the
      // host-side address is the right one and there is nothing to attach.
      return;
    }

    const network = config.DOCKER_NETWORK;
    if (self.NetworkSettings?.Networks?.[network]) return;

    await this.ensureNetwork(network);
    await this.docker.getNetwork(network).connect({ Container: self.Id });
    logger.info({ network }, 'joined the game network so RCON can reach game containers');
  }

  private async ensureNetwork(name: string): Promise<void> {
    const networks = await this.docker.listNetworks({ filters: { name: [name] } });
    if (networks.some((n) => n.Name === name)) return;
    await this.docker.createNetwork({
      Name: name,
      Driver: 'bridge',
      Labels: { [`${brand.labelNamespace}/managed`]: 'true' },
    });
  }
}

// ────────────────────────────────────────────────────────────────── helpers ──

/** Where every container's writable data is mounted, and so where HOME is. */
const CONTAINER_HOME = '/home/container';

/**
 * Builds the env list, defaulting HOME to the one writable directory.
 *
 * Containers run as uid 1000 with the server's data bind-mounted at
 * /home/container, but images carry whatever HOME their author set — usually
 * /root, which uid 1000 cannot write. Anything that consults HOME then fails
 * on a path it has no business touching. SteamCMD is the loud case: it exits
 * with `mkdir: cannot create directory '/root': Permission denied`, reported
 * as a Steam outage because that is what a non-zero exit usually means.
 *
 * Set here rather than in each adapter because the pairing is the runtime's:
 * this is the code that chooses both the user and the mount point, so it is
 * the code that knows they have to agree. An adapter passing its own HOME
 * still wins.
 */
function toEnv(env: Record<string, string>): string[] {
  return Object.entries({ HOME: CONTAINER_HOME, ...env }).map(([key, value]) => `${key}=${value}`);
}

interface DockerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> };
  networks?: Record<string, Record<string, number>>;
}

export function computeCpuPercent(stats: DockerStats): number {
  const cpuDelta =
    (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
  if (cpuDelta <= 0 || systemDelta <= 0) return 0;

  const cores =
    stats.cpu_stats?.online_cpus ?? stats.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
  return Number(((cpuDelta / systemDelta) * cores * 100).toFixed(2));
}

/**
 * Docker's `usage` includes the page cache, which makes an idle server look
 * like it is at 100% memory. Subtracting the reclaimable cache is what the
 * `docker stats` CLI does, and it matches what users expect to see.
 */
export function memoryUsage(stats: DockerStats): number {
  const usage = stats.memory_stats?.usage ?? 0;
  const cache = stats.memory_stats?.stats?.['inactive_file'] ?? stats.memory_stats?.stats?.['cache'] ?? 0;
  return Math.max(0, usage - cache);
}

function sumNetwork(stats: DockerStats, field: 'rx_bytes' | 'tx_bytes'): number {
  if (!stats.networks) return 0;
  return Object.values(stats.networks).reduce((total, iface) => total + (iface[field] ?? 0), 0);
}

function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: number })?.statusCode === 404;
}

function isNotModified(error: unknown): boolean {
  return (error as { statusCode?: number })?.statusCode === 304;
}

/** Docker's answer when an operation needs a running container and has none. */
function isNotRunning(error: unknown): boolean {
  return (error as { statusCode?: number })?.statusCode === 409;
}

/** Minimal writable sink; avoids pulling in a stream helper dependency. */
class WritableCollector {
  writable = true;
  constructor(private readonly onChunk: (chunk: Buffer) => void) {}
  write(chunk: Buffer): boolean {
    this.onChunk(chunk);
    return true;
  }
  end(): void {}
  on(): void {}
  once(): void {}
  emit(): void {}
  removeListener(): void {}
}
