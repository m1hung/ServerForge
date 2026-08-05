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

export interface ResourceLimits {
  /** Container memory ceiling in MiB. 0 = unlimited (not recommended). */
  memoryMib: number;
  /** Fractional CPU cores, e.g. 2.5. 0 = unlimited. */
  cpuCores: number;
  /** Disk quota in MiB, enforced by the disk watcher. 0 = unlimited. */
  diskMib: number;
  /**
   * Container swap in MiB. Defaults to memoryMib (i.e. no extra swap).
   * Null and undefined both mean "not set" — null is what the database and
   * therefore the API return, so both must be representable here.
   */
  swapMib?: number | null;
  /** Linux CPU shares style priority, 1–1000. */
  ioWeight?: number | null;
}

export interface ResourceUsage {
  timestamp: number;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  diskBytes: number;
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
