/* eslint-disable @typescript-eslint/no-explicit-any -- Partial Prisma delegates are in-memory test doubles, not production inputs. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { defaultsFor, brand } from '@serverforge/core';
import { getAdapter } from '@serverforge/adapters';

const state = vi.hoisted(() => ({
  server: {} as any,
  root: '',
  starts: vi.fn(),
  status: vi.fn(),
  timeline: [] as any[],
  schedules: [] as any[],
  scheduleUpdates: [] as any[],
  managed: [] as any[],
  installLogs: [] as any[],
}));
vi.mock('../apps/api/src/services/platform.js', () => ({
  selectGamePlatform: async () => 'linux/amd64',
}));
vi.mock('@serverforge/db', () => ({
  uid: () => 'id',
  serializeBigInts: (v: unknown) => v,
  prisma: {
    server: {
      findMany: async (args: any) =>
        !args?.where || args.where.state.in.includes(state.server.state) ? [state.server] : [],
      findUnique: async () => state.server,
      findUniqueOrThrow: async () => state.server,
      update: async ({ data }: any) => {
        state.server = {
          ...state.server,
          ...data,
          ...(typeof data.crashCount === 'object'
            ? { crashCount: state.server.crashCount + data.crashCount.increment }
            : {}),
        };
        return state.server;
      },
    },
    backup: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    installLog: {
      create: async ({ data }: any) => {
        state.installLogs.push(data);
        return data;
      },
    },
    installationAttempt: { findFirst: async () => null },
    activity: {
      create: async ({ data }: any) => {
        state.timeline.push(data);
        return data;
      },
    },
    metricSample: { create: async () => ({}), deleteMany: async () => ({ count: 0 }) },
    schedule: {
      findUnique: async ({ where }: any) => state.schedules.find((s) => s.id === where.id) ?? null,
      findMany: async (args: any) =>
        state.schedules.filter(
          (s) =>
            (args.where.enabled === undefined || s.enabled === args.where.enabled) &&
            (!args.where.triggerType || s.triggerType === args.where.triggerType) &&
            (!args.where.cron || !!s.cron) &&
            (!args.where.nextRunAt || s.nextRunAt <= args.where.nextRunAt.lte) &&
            (!args.where.lastRunAt || s.lastRunAt != null) &&
            (args.where.lastRunOk !== null || s.lastRunOk == null),
        ),
      updateMany: async ({ where, data }: any) => {
        const row = state.schedules.find(
          (s) => s.id === where.id && s.lastRunAt === where.lastRunAt,
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      update: async ({ where, data }: any) => {
        state.scheduleUpdates.push(data);
        const row = state.schedules.find((s) => s.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    user: { findUnique: async () => ({ id: 'revoked-user', role: 'user', suspended: false }) },
  },
}));
vi.mock('../apps/api/src/lib/config.js', () => ({
  config: {
    get dataRoot() {
      return state.root;
    },
    dockerSocket: '/none',
  },
  runningInContainer: () => false,
}));
vi.mock('../apps/api/src/runtime/docker.js', () => ({
  DockerRuntime: class {
    listManaged = async () => state.managed;
    status = state.status;
    start = state.starts;
    create = async () => 'replacement';
    remove = async () => undefined;
    ensureImage = async () => undefined;
    streamLogs = async () => ({ close: vi.fn() });
    stats = async () => null;
  },
}));
vi.mock('../apps/api/src/lib/server-files.js', async (original) => ({
  ...(await original<object>()),
  prepareServerOwnership: async () => undefined,
}));
import { startSupervisor } from '../apps/api/src/workers/supervisor.js';
import { containerName } from '../apps/api/src/lib/container-name.js';
import { serverEvents } from '../apps/api/src/services/server-events.js';
import { isServerBusy } from '../apps/api/src/services/server-lock.js';
import { clearObservations } from '../apps/api/src/services/telemetry.js';

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-supervisor-'));
  state.timeline = [];
  state.schedules = [];
  state.scheduleUpdates = [];
  state.managed = [];
  state.installLogs = [];
  state.server = {
    id: 'id',
    uid: 'test',
    name: 'Test',
    state: 'running',
    ownerId: 'owner',
    subusers: [],
    autoRestart: true,
    crashCount: 0,
    lastCrashAt: null,
    lastStartAt: new Date(),
    containerId: 'old',
    gameId: 'minecraft-java',
    variantId: 'paper',
    version: '1.21.4',
    build: null,
    javaMajor: 21,
    settings: defaultsFor(getAdapter('minecraft-java').settingsSchema('paper')),
    dataPath: path.join(state.root, 'game'),
    memoryMib: 4096,
    cpuCores: 4,
    diskMib: 20000,
    swapMib: null,
    ioWeight: 500,
    environment: {},
    javaFlagsPreset: 'balanced',
    customJavaFlags: null,
    startupOverride: null,
    allocations: [],
  };
  await fs.mkdir(state.server.dataPath);
  state.managed = [
    {
      id: 'old',
      name: containerName(state.server),
      dataPath: state.server.dataPath,
      labels: { [`${brand.labelNamespace}/server`]: 'test' },
    },
  ];
  state.status.mockResolvedValue({ exists: true, running: false, exitCode: 137, oomKilled: true });
  state.starts.mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  serverEvents.removeAllListeners();
  clearObservations('test');
  await fs.rm(state.root, { recursive: true, force: true });
});
it('detects OOM, waits for backoff, and actually launches a replacement without resetting the crash count', async () => {
  await startSupervisor();
  expect(state.server.state).toBe('crashed');
  expect(state.server.crashCount).toBe(1);
  expect(state.timeline[0].message).toContain('ran out of memory');
  await vi.advanceTimersByTimeAsync(15000);
  expect(state.starts).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(15000);
  await vi.waitFor(() => expect(isServerBusy('test')).toBe(false));
  expect(state.starts).toHaveBeenCalledOnce();
  expect(state.server.state).toBe('running');
  expect(state.server.crashCount).toBe(1);
});
it('does not restart intentionally stopped servers or revive a guarded crash loop', async () => {
  state.server.state = 'offline';
  await startSupervisor();
  await vi.advanceTimersByTimeAsync(180000);
  expect(state.starts).not.toHaveBeenCalled();
  state.server.state = 'crashed';
  state.server.crashCount = 4;
  state.server.lastCrashAt = new Date(Date.now() - 180000);
  await vi.advanceTimersByTimeAsync(15000);
  expect(state.starts).not.toHaveBeenCalled();
});
it('claims a due schedule once and refuses to execute after its creator loses access', async () => {
  state.server.state = 'offline';
  state.schedules = [
    {
      id: 'schedule',
      uid: 'schedule',
      serverId: 'id',
      creatorId: 'revoked-user',
      name: 'Restart',
      enabled: true,
      cron: '* * * * *',
      triggerType: null,
      timezone: 'UTC',
      cooldownSeconds: 0,
      onlyWhenOnline: false,
      lastRunAt: null,
      nextRunAt: new Date(Date.now() + 1000),
      actions: [{ type: 'power', action: 'start' }],
    },
  ];
  await startSupervisor();
  await vi.advanceTimersByTimeAsync(15000);
  await vi.waitFor(() => expect(isServerBusy('test')).toBe(false));
  expect(state.starts).not.toHaveBeenCalled();
  expect(state.scheduleUpdates.at(-1).lastRunOk).toBe(false);
  expect(state.schedules[0].nextRunAt.getTime()).toBeGreaterThan(Date.now());
  await vi.advanceTimersByTimeAsync(15000);
  expect(state.scheduleUpdates).toHaveLength(1);
});

it('recovers an interrupted installation and reattaches an owned running container without creating another', async () => {
  state.server.state = 'installing';
  const stop = await startSupervisor();
  expect(state.server.state).toBe('install_failed');
  expect(state.installLogs[0].message).toContain('restarted during installation');
  await stop();
  state.server.state = 'starting';
  state.server.containerId = null;
  state.managed = [
    {
      id: 'recovered',
      name: containerName(state.server),
      state: 'running',
      dataPath: state.server.dataPath,
      labels: { [`${brand.labelNamespace}/server`]: 'test' },
    },
  ];
  state.status.mockResolvedValue({ exists: true, running: true });
  const stopAgain = await startSupervisor();
  expect(state.server.containerId).toBe('recovered');
  expect(state.server.state).toBe('running');
  expect(state.starts).not.toHaveBeenCalled();
  await stopAgain();
});

it('skips missed cron occurrences instead of replaying their actions', async () => {
  state.server.state = 'offline';
  state.schedules = [
    {
      id: 'missed',
      serverId: 'id',
      name: 'Missed command',
      enabled: true,
      cron: '* * * * *',
      timezone: 'UTC',
      lastRunAt: null,
      lastRunOk: null,
      nextRunAt: new Date(Date.now() - 60000),
    },
  ];
  const stop = await startSupervisor();
  expect(state.schedules[0].lastRunError).toContain('Missed while');
  expect(state.schedules[0].nextRunAt.getTime()).toBeGreaterThan(Date.now());
  expect(state.starts).not.toHaveBeenCalled();
  await stop();
});

it('retains every schedule triggered by one event while another operation holds the server lock', async () => {
  state.server.state = 'offline';
  state.schedules = ['first', 'second'].map((id) => ({
    id,
    uid: id,
    serverId: 'id',
    creatorId: 'revoked-user',
    name: id,
    enabled: true,
    cron: null,
    triggerType: 'server.stopped',
    timezone: 'UTC',
    cooldownSeconds: 60,
    onlyWhenOnline: false,
    lastRunAt: null,
    nextRunAt: null,
    actions: [{ type: 'power', action: 'start' }],
  }));
  await startSupervisor();
  serverEvents.emit('server', { serverUid: 'test', type: 'server.stopped', at: Date.now() });
  await vi.advanceTimersByTimeAsync(15000);
  await vi.waitFor(() => expect(isServerBusy('test')).toBe(false));
  await vi.advanceTimersByTimeAsync(15000);
  await vi.waitFor(() => expect(isServerBusy('test')).toBe(false));
  expect(state.schedules.every((s) => s.lastRunOk === false)).toBe(true);
  expect(state.scheduleUpdates).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(15000);
  expect(state.scheduleUpdates).toHaveLength(2);
});
