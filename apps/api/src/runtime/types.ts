import type { ResourceLimits, ResourceUsage } from '@serverforge/core';

export interface PortBinding {
  hostIp: string;
  hostPort: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
}

export interface ContainerSpec {
  name: string;
  image: string;
  command: string[];
  entrypoint?: string[];
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
}

export interface LogHandle {
  close(): void;
}

export interface RunOnceSpec {
  image: string;
  command: string[];
  entrypoint?: string[];
  env?: Record<string, string>;
  dataPath: string;
  timeoutMs?: number;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface RuntimeDriver {
  ping(): Promise<boolean>;
  ensureImage(image: string, onProgress?: (line: string) => void): Promise<void>;
  create(spec: ContainerSpec): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string, options?: { stopCommand?: string; timeoutSeconds?: number }): Promise<void>;
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
  selfMounts(): Promise<{ source: string; destination: string }[] | null>;
}
