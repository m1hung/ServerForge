import type { ResourceLimits, ResourceUsage } from '@serverforge/core';

/**
 * The runtime driver contract.
 *
 * Everything the platform does to a running game server goes through this
 * interface. The Docker implementation talks to a local socket; a future
 * remote-node implementation will post the same operations to an agent over
 * HTTPS. Business logic must never import dockerode directly.
 */

export interface ContainerSpec {
  /** Stable container name, derived from the server uid. */
  name: string;
  image: string;
  command: string[];
  workingDir: string;
  env: Record<string, string>;
  /** Host path mounted at /home/container. */
  dataPath: string;
  limits: ResourceLimits;
  /** hostIp:hostPort -> containerPort/protocol */
  ports: { hostIp: string; hostPort: number; containerPort: number; protocol: 'tcp' | 'udp' }[];
  /** Docker network to join. */
  network: string;
  /** Labels used to identify and reconcile managed containers. */
  labels: Record<string, string>;
}

export interface ContainerStatus {
  exists: boolean;
  running: boolean;
  /** Docker's own state string, for diagnostics. */
  state?: string;
  exitCode?: number;
  startedAt?: string;
  /** True when the kernel OOM-killer stopped it — worth a specific message. */
  oomKilled?: boolean;
}

export interface ExecResult {
  exitCode: number;
  output: string;
}

export interface LogStreamHandle {
  close(): void;
}

export interface RuntimeDriver {
  readonly kind: 'docker' | 'agent';

  /** True when the runtime is reachable. Drives the node health indicator. */
  ping(): Promise<boolean>;

  /** Pulls an image if absent, reporting progress lines. */
  ensureImage(image: string, onProgress?: (line: string) => void): Promise<void>;

  create(spec: ContainerSpec): Promise<string>;
  start(containerId: string): Promise<void>;
  /** Graceful stop: writes `stopCommand` to stdin if given, else SIGTERM. */
  stop(containerId: string, options: { stopCommand?: string; timeoutSeconds: number }): Promise<void>;
  kill(containerId: string): Promise<void>;
  remove(containerId: string, options?: { force?: boolean }): Promise<void>;
  status(containerId: string): Promise<ContainerStatus>;

  /** Writes a line to the container's stdin — how console commands are sent. */
  writeStdin(containerId: string, data: string): Promise<void>;

  /**
   * Streams stdout/stderr. `since` replays from a timestamp so a reconnecting
   * browser does not lose the lines it missed.
   */
  streamLogs(
    containerId: string,
    handlers: { onLine: (line: string, stream: 'stdout' | 'stderr') => void; onEnd?: () => void },
    options?: { tail?: number; since?: number },
  ): Promise<LogStreamHandle>;

  /** Single stats sample. Implementations must not leave a stream open. */
  stats(containerId: string): Promise<ResourceUsage | null>;

  /** Applies new CPU/memory limits without recreating the container. */
  updateLimits(containerId: string, limits: ResourceLimits): Promise<void>;

  /**
   * Runs a throwaway container against the server's data directory. Used for
   * SteamCMD, loader installers and archive work that needs a real runtime.
   */
  runOnce(options: {
    image: string;
    command: string[];
    dataPath: string;
    env?: Record<string, string>;
    workingDir?: string;
    timeoutMs?: number;
    onLine?: (line: string) => void;
  }): Promise<ExecResult>;

  /** Container ids this driver manages, for reconciliation on boot. */
  listManaged(): Promise<{ id: string; name: string; running: boolean }[]>;

  /**
   * Makes game containers reachable from this process, if that takes anything.
   *
   * Needed for RCON, which is the only console some games have. Optional
   * because it is a property of how the runtime is deployed, not of the
   * contract: a remote agent would already be beside its own containers.
   */
  joinGameNetwork?(): Promise<void>;

  /**
   * Mount table of the container this process is running in, or null when it
   * is not running in one (or the runtime cannot say). Startup uses it to
   * prove HOST_DATA_ROOT names the real host side of the data directory
   * before a wrong value silently breaks every game container.
   */
  selfMounts(): Promise<{ source: string; destination: string }[] | null>;
}
