import type {
  ResourceLimits,
  ResourceUsage,
  RuntimeCapabilities,
  RuntimePlatform,
  AppliedAllocation,
} from '@serverforge/core';

export interface PortBinding {
  hostIp: string;
  hostPort: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
}

export interface ContainerSpec {
  name: string;
  image: string;
  platform?: RuntimePlatform;
  command: string[];
  entrypoint?: string[];
  stopSignal?: 'SIGINT' | 'SIGTERM';
  workingDir: string;
  env: Record<string, string>;
  dataPath: string;
  limits: ResourceLimits;
  ports: PortBinding[];
  network?: string;
  labels: Record<string, string>;
  user?: string;
}

export interface ContainerStatus {
  exists: boolean;
  running: boolean;
  state?: string;
  exitCode?: number | null;
  startedAt?: string | null;
  error?: string;
  oomKilled?: boolean;
}

export interface ManagedContainer {
  id: string;
  name: string;
  state: string;
  labels: Record<string, string>;
  dataPath?: string;
}

export interface LogHandle {
  close(): void;
}

export interface RunOnceSpec {
  signal?: AbortSignal;
  image: string;
  platform?: RuntimePlatform;
  command: string[];
  entrypoint?: string[];
  env?: Record<string, string>;
  dataPath: string;
  limits?: ResourceLimits;
  timeoutMs?: number;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface RuntimeDriver {
  ping(): Promise<boolean>;
  capabilities(): Promise<RuntimeCapabilities>;
  appliedAllocation(id: string): Promise<AppliedAllocation | null>;
  ensureImage(
    image: string,
    onProgress?: (line: string) => void,
    platform?: RuntimePlatform,
  ): Promise<void>;
  create(spec: ContainerSpec): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string, options?: { stopCommand?: string; timeoutSeconds?: number; forceAfterTimeout?: boolean }): Promise<void>;
  kill(id: string): Promise<void>;
  remove(id: string, options?: { force?: boolean }): Promise<void>;
  status(id: string): Promise<ContainerStatus>;
  stats(id: string): Promise<ResourceUsage | null>;
  streamLogs(
    id: string,
    options: {
      onLine: (line: string, stream: 'stdout' | 'stderr') => void;
      tail?: number;
      onEnd?: (error?: Error) => void;
    },
  ): Promise<LogHandle>;
  writeStdin(id: string, data: string): Promise<void>;
  updateLimits(id: string, limits: ResourceLimits): Promise<void>;
  listManaged(): Promise<ManagedContainer[]>;
  runOnce(spec: RunOnceSpec): Promise<{ exitCode: number; output: string }>;
  repairOwnership(dataPath: string, owner: string): Promise<void>;
  cleanupTemporary(dataPath: string): Promise<void>;
  selfMounts(): Promise<{ source: string; destination: string }[] | null>;
}
