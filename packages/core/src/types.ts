/** Shared vocabulary between API, workers, adapters and the dashboard. */

export const SERVER_STATES = [
  'creating',
  'installing',
  'install_failed',
  'offline',
  'starting',
  'running',
  'stopping',
  'crashed',
  'updating',
  'restoring',
  'suspended',
  'deleting',
] as const;
export type ServerState = (typeof SERVER_STATES)[number];

/** States in which power actions other than "start" make no sense. */
export const INERT_STATES: ServerState[] = [
  'creating',
  'installing',
  'install_failed',
  'offline',
  'suspended',
];

/** States where the container is expected to exist and be reachable. */
export const LIVE_STATES: ServerState[] = ['starting', 'running', 'stopping'];

export type PowerAction = 'start' | 'stop' | 'restart' | 'kill';

export const ROLES = ['owner', 'admin', 'user'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Per-server permissions granted to sub-users. Deliberately coarse — a
 * self-hosted panel does not need 40 checkboxes, it needs 8 that people
 * actually understand.
 */
export const SERVER_PERMISSIONS = [
  'server.view',
  'server.power',
  'server.console',
  'server.settings',
  'server.files',
  'server.backups',
  'server.schedules',
  'server.mods',
  'server.subusers',
  'server.delete',
] as const;
export type ServerPermission = (typeof SERVER_PERMISSIONS)[number];

export const OWNER_PERMISSIONS: ServerPermission[] = [...SERVER_PERMISSIONS];

/**
 * Scopes an API key may be limited to.
 *
 * `*` is full account power (dashboard-equivalent). Otherwise each entry is a
 * server permission the key may exercise, plus `admin` for panel admin routes.
 */
export const API_KEY_SCOPES = ['*', 'admin', ...SERVER_PERMISSIONS] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * Things a server can do that a schedule may react to.
 *
 * Every one of these is already detected: player events come from the
 * adapter's `inspectLog`, the rest from the single writer for server state.
 * Nothing here requires a game to be polled.
 */
export const SCHEDULE_TRIGGERS = [
  'player.join',
  'player.leave',
  'server.ready',
  'server.crashed',
  'server.stopped',
] as const;
export type ScheduleTrigger = (typeof SCHEDULE_TRIGGERS)[number];

/** An event emitted by a running server, and the payload a trigger matches. */
export interface ServerEvent {
  serverUid: string;
  type: ScheduleTrigger;
  at: number;
  /** Present on player events. */
  playerName?: string;
}

export interface ResourceLimits {
  /** Container memory ceiling in MiB. 0 = unlimited (not recommended). */
  memoryMib: number;
  /** Fractional CPU cores, e.g. 2.5. 0 = unlimited. */
  cpuCores: number;
  /** Monitored storage budget in MiB, not a filesystem quota. 0 = no budget. */
  diskMib: number;
  /**
   * Additional swap in MiB. Zero disables swap when memory is limited.
   * Null and undefined both mean "not set" — null is what the database and
   * therefore the API return, so both must be representable here.
   */
  swapMib?: number | null;
  /** Block I/O weight, 10–1000, applied only where the host supports it. */
  ioWeight?: number | null;
}

export type RuntimePlatform = 'linux/amd64' | 'linux/arm64';
export interface AppliedAllocation {
  imageId?: string;
  imageReference?: string;
  platform?: string;
  memoryMib: number;
  cpuCores: number;
  swapMib: number | null;
  ioWeight: number | null;
  pidsLimit: number | null;
  protected: boolean;
  logRotation: boolean;
  warnings: string[];
}

export interface RuntimeCapabilities {
  dockerVersion: string;
  os: string;
  architecture: string;
  cpuCores: number;
  memoryMib: number;
  memoryLimit: boolean;
  cpuLimit: boolean;
  swapLimit: boolean;
  pidsLimit: boolean;
  ioWeight: boolean;
  cgroupVersion: string;
}

export interface NodeCapacity {
  capabilities: RuntimeCapabilities;
  memory: { totalMib: number; headroomMib: number; reservedMib: number; availableMib: number };
  cpu: { totalCores: number; reservedCores: number; overcommitted: boolean };
  disk: { freeBytes: number; totalBytes: number } | null;
  warnings: string[];
}

export interface ResourceUsage {
  timestamp: number;
  cpuPercent: number;
  /** This container’s usage on each host logical CPU. Null when Docker omits the counters. */
  cpuPerCorePercent?: number[] | null;
  /** Active container quota in core equivalents; 0 means unlimited. */
  cpuLimitCores?: number;
  cpuHostCores?: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  /** Null when disk usage has not been measured (Docker stats does not include it). */
  diskBytes: number | null;
  networkRxBytes: number;
  networkTxBytes: number;
  uptimeSeconds: number;
  /** Players online, when the adapter can determine it. */
  players?: { online: number; max: number };
}

export interface PortAllocation {
  id: string;
  ip: string;
  port: number;
  /** Adapter-defined role, e.g. "game", "rcon", "query". */
  purpose: string;
  primary: boolean;
}

export type InstallPhase =
  | 'queued'
  | 'preparing'
  | 'resolving_version'
  | 'downloading'
  | 'extracting'
  | 'configuring'
  | 'finalizing'
  | 'done'
  | 'failed';

export interface InstallProgress {
  serverId: string;
  phase: InstallPhase;
  /** 0–100. Best-effort; steps without a known size report indeterminate. */
  percent: number;
  message: string;
  /** Set when phase === 'failed'. */
  error?: string;
  at: number;
}

export interface ConsoleLine {
  /** Monotonic sequence within a server's console stream. */
  seq: number;
  at: number;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export type BackupState = 'pending' | 'running' | 'completed' | 'failed' | 'deleting';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType: 'server' | 'user' | 'node' | 'system';
  targetId: string | null;
  metadata?: Record<string, unknown>;
  ip?: string;
}
