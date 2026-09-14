/* eslint-disable @typescript-eslint/no-explicit-any -- Partial Prisma delegates are in-memory test doubles, not production inputs. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../apps/api/src/services/platform.js', () => ({ selectGamePlatform: async () => 'linux/amd64' }));
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { defaultsFor, isAppError, unauthorized } from '@serverforge/core';
import { getAdapter } from '@serverforge/adapters';
import { Readable } from 'node:stream';
import * as tar from 'tar';

const state = vi.hoisted(() => ({
  server: {} as any,
  backups: [] as any[],
  activities: [] as any[],
  stop: vi.fn(),
  start: vi.fn(),
  config: { dataRoot: '', backupRoot: '', dockerSocket: '/none' },
  update: vi.fn(),
  callback: undefined as any,
  upsert: vi.fn(),
}));
vi.mock('@serverforge/db', () => ({
  uid: () => Math.random().toString(36).slice(2),
  serializeBigInts: (v: unknown) =>
    JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))),
  prisma: {
    server: {
      findUnique: async () => state.server,
      findUniqueOrThrow: async () => state.server,
      update: async ({ data }: any) => {
        state.update(data);
        state.server = { ...state.server, ...data };
        return state.server;
      },
    },
    backup: {
      create: async ({ data }: any) => {
        const row = { id: data.uid, createdAt: new Date(), ...data };
        state.backups.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = state.backups.find((b) => b.id === where.id);
        Object.assign(row, data);
        return row;
      },
      findMany: async () => state.backups,
      findFirst: async ({ where }: any) =>
        state.backups.find((b) => b.uid === where.uid && b.serverId === where.serverId),
      delete: vi.fn(),
    },
    activity: {
      create: async ({ data }: any) => {
        state.activities.push(data);
        return data;
      },
      findMany: async () => state.activities,
      findFirst: async ({ where }: any) => [...state.activities].reverse().find((event) => event.serverId === where.serverId && where.action.in.includes(event.action)) ?? null,
    },
    schedule: { create: vi.fn(), update: vi.fn(), findMany: async () => [] },
    metricSample: { create: vi.fn(), findMany: async () => [] },
    user: {
      findUnique: async ({ where }: any) =>
        where.username === 'sam'
          ? { id: 'sam', username: 'sam', role: 'user', suspended: false }
          : null,
    },
    serverUser: { upsert: state.upsert },
  },
}));
vi.mock('../apps/api/src/lib/config.js', () => ({
  config: state.config,
  runningInContainer: () => false,
}));
vi.mock('../apps/api/src/plugins/auth.js', () => ({
  requireUser: (request: FastifyRequest) => {
    if (!request.headers['x-user']) throw unauthorized();
    return {
      id: request.headers['x-user'],
      role: 'user',
      ...(request.headers['x-scope'] ? { scopes: [request.headers['x-scope']] } : {}),
    };
  },
}));
vi.mock('../apps/api/src/runtime/docker.js', () => ({
  DockerRuntime: class {
    stop = state.stop;
    start = state.start;
    remove = async () => undefined;
    create = async () => 'new-container';
    ensureImage = async () => undefined;
    status = async () => ({ exists: false, running: false });
    streamLogs = async (_id: string, callbacks: any) => {
      state.callback = callbacks;
      return { close: vi.fn() };
    };
  },
}));
vi.mock('../apps/api/src/lib/server-files.js', async (original) => ({
  ...(await original<object>()),
  prepareServerOwnership: async () => undefined,
}));
import { managementRoutes } from '../apps/api/src/routes/management.js';
import {
  archiveDirectory,
  createBackup,
  extractBackup,
  recoverSwap,
  replaceServerFiles,
  restoreBackup,
  savedConfiguration,
  operationRoot,
} from '../apps/api/src/services/backups.js';
import {
  readTextFile,
  writeTextFile,
  listFiles,
  uploadFile,
  unpackFile,
  fileChecksum,
} from '../apps/api/src/services/file-manager.js';
import {
  compareInventory,
  directoryInventory,
  preservedPaths,
  prepareUpdate,
  applyUpdate,
  readUpdate,
} from '../apps/api/src/services/updates.js';
import {
  nextRun,
  validateSchedule,
  actionPermissions,
} from '../apps/api/src/services/schedules.js';
import { crashDecision } from '../apps/api/src/workers/supervisor.js';
import {
  parseTickMetrics,
  observeServer,
  acceptTickOutput,
  observations,
  clearObservations,
} from '../apps/api/src/services/telemetry.js';
import { withServerLock } from '../apps/api/src/services/server-lock.js';

let root: string, app: FastifyInstance;
beforeEach(async () => {
  vi.clearAllMocks();
  state.backups = [];
  state.activities = [];
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-management-'));
  state.config.dataRoot = root;
  state.config.backupRoot = path.join(root, 'backups');
  state.server = {
    id: 'server-id',
    uid: 'test',
    name: 'Test',
    ownerId: 'owner',
    node: {},
    state: 'offline',
    dataPath: path.join(root, 'game'),
    containerId: null,
    gameId: 'minecraft-java',
    variantId: 'paper',
    version: '1.21.4',
    build: null,
    javaMajor: 21,
    environment: {},
    startupOverride: null,
    javaFlagsPreset: 'balanced',
    customJavaFlags: null,
    memoryMib: 4096,
    cpuCores: 4,
    diskMib: 20000,
    swapMib: null,
    ioWeight: 500,
    settings: defaultsFor(getAdapter('minecraft-java').settingsSchema('paper')),
    allocations: [],
    subusers: [
      { userId: 'viewer', permissions: ['server.view'], roles: [] },
      { userId: 'scheduler', permissions: ['server.view', 'server.schedules'], roles: [] },
      { userId: 'member-admin', permissions: ['server.view', 'server.subusers'], roles: [] },
    ],
  };
  await fs.mkdir(state.server.dataPath);
  await fs.mkdir(state.config.backupRoot);
  app = Fastify();
  await app.register(multipart);
  app.setErrorHandler((error, _req, reply) =>
    reply
      .code(isAppError(error) ? error.status : error.name === 'ZodError' ? 400 : 500)
      .send({ error: { message: error.message } }),
  );
  await app.register(managementRoutes);
});
afterEach(async () => {
  clearObservations('test');
  await app.close();
  await fs.rm(root, { recursive: true, force: true });
});
const call = (
  url: string,
  method: 'GET' | 'POST' | 'PUT' = 'GET',
  payload?: object,
  user = 'owner',
  scope?: string,
) =>
  app.inject({
    url: `/servers/test${url}`,
    method,
    payload,
    headers: { 'x-user': user, ...(scope ? { 'x-scope': scope } : {}) },
  });

describe('files and backup integrity', () => {
  it('round trips actual world files and restores the saved panel configuration', async () => {
    await fs.mkdir(path.join(state.server.dataPath, 'world'));
    await fs.writeFile(path.join(state.server.dataPath, 'world/level.dat'), 'world-before');
    const backup = await createBackup(state.server, 'Before mods');
    expect(backup.state).toBe('completed');
    expect(backup.checksum).toHaveLength(64);
    await fs.writeFile(path.join(state.server.dataPath, 'world/level.dat'), 'world-after');
    state.server.memoryMib = 8192;
    await restoreBackup(state.server, backup);
    expect(await fs.readFile(path.join(state.server.dataPath, 'world/level.dat'), 'utf8')).toBe(
      'world-before',
    );
    expect(state.server.memoryMib).toBe(4096);
    expect(state.server.state).toBe('offline');
    expect(state.backups).toHaveLength(2);
    expect(state.start).not.toHaveBeenCalled();
    expect(
      await fs.stat(path.join(operationRoot('test'), 'previous')).catch(() => null),
    ).toBeNull();
  });
  it('fails a tampered archive before touching the current world', async () => {
    await fs.writeFile(path.join(state.server.dataPath, 'world.dat'), 'safe');
    const backup = await createBackup(state.server);
    await fs.appendFile(path.join(state.config.backupRoot, backup.filePath!), 'changed');
    await expect(restoreBackup(state.server, backup)).rejects.toThrow('checksum');
    expect(await fs.readFile(path.join(state.server.dataPath, 'world.dat'), 'utf8')).toBe('safe');
    expect(state.stop).not.toHaveBeenCalled();
  });
  it('recovers an interrupted directory swap using the original configuration', async () => {
    const live = state.server.dataPath,
      work = operationRoot('test');
    await fs.mkdir(work, { recursive: true });
    await fs.writeFile(path.join(live, 'world.dat'), 'original');
    await fs.rename(live, path.join(work, 'previous'));
    await fs.mkdir(live);
    await fs.writeFile(path.join(live, 'world.dat'), 'incomplete');
    await fs.writeFile(
      path.join(work, 'swap.json'),
      JSON.stringify({ committed: false, original: savedConfiguration(state.server) }),
    );
    state.server.memoryMib = 8192;
    await recoverSwap(state.server);
    expect(await fs.readFile(path.join(live, 'world.dat'), 'utf8')).toBe('original');
    expect(state.server.memoryMib).toBe(4096);
  });
  it('rolls back when a staged directory cannot be swapped in', async () => {
    await fs.writeFile(path.join(state.server.dataPath, 'world.dat'), 'original');
    await expect(
      replaceServerFiles(
        state.server,
        path.join(root, 'missing'),
        savedConfiguration(state.server),
      ),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(state.server.dataPath, 'world.dat'), 'utf8')).toBe(
      'original',
    );
  });
  it('rejects stale edits and keeps the external change intact', async () => {
    const file = path.join(state.server.dataPath, 'config.txt');
    await fs.writeFile(file, 'old');
    const opened = await readTextFile(state.server.dataPath, 'config.txt');
    await fs.writeFile(file, 'external');
    await expect(
      writeTextFile(state.server.dataPath, 'config.txt', 'mine', opened.revision),
    ).rejects.toThrow('changed');
    expect(await fs.readFile(file, 'utf8')).toBe('external');
    const current = await readTextFile(state.server.dataPath, 'config.txt');
    await writeTextFile(state.server.dataPath, 'config.txt', 'saved', current.revision);
    expect(await fs.readFile(file, 'utf8')).toBe('saved');
  });
  it('rejects traversal, parent symlinks, binary edits, and overwrite uploads', async () => {
    await fs.writeFile(path.join(root, 'secret'), 'private');
    await fs.symlink(root, path.join(state.server.dataPath, 'link'));
    await expect(readTextFile(state.server.dataPath, '../secret')).rejects.toThrow();
    await expect(readTextFile(state.server.dataPath, 'link/secret')).rejects.toThrow();
    await fs.writeFile(path.join(state.server.dataPath, 'binary'), Buffer.from([0, 1]));
    await expect(readTextFile(state.server.dataPath, 'binary')).rejects.toThrow('binary');
    await uploadFile(state.server.dataPath, 'new.txt', Readable.from('one'));
    await expect(
      uploadFile(state.server.dataPath, 'new.txt', Readable.from('two')),
    ).rejects.toThrow('already exists');
    expect(await fs.readFile(path.join(state.server.dataPath, 'new.txt'), 'utf8')).toBe('one');
    expect(
      (await listFiles(state.server.dataPath, '/')).entries.some((e) => e.name === 'link'),
    ).toBe(false);
  });
  it('rejects linked archives and corrupt ZIP extraction without partial destination files', async () => {
    await fs.writeFile(path.join(root, 'outside'), 'private');
    await fs.symlink('../outside', path.join(state.server.dataPath, 'link'));
    const archive = path.join(root, 'links.tar.gz');
    await tar.c({ file: archive, cwd: state.server.dataPath, gzip: true }, ['link']);
    await expect(extractBackup(archive, path.join(root, 'extract'))).rejects.toThrow();
    await fs.writeFile(path.join(state.server.dataPath, 'broken.zip'), 'not-a-zip');
    await expect(unpackFile(state.server.dataPath, 'broken.zip', 'result')).rejects.toThrow();
    expect(await fs.stat(path.join(state.server.dataPath, 'result')).catch(() => null)).toBeNull();
  });
  it('includes executable files and nested saves in an archive', async () => {
    await fs.mkdir(path.join(state.server.dataPath, 'nested'));
    await fs.writeFile(path.join(state.server.dataPath, 'nested/start.sh'), '#!/bin/sh\n', {
      mode: 0o755,
    });
    const archive = path.join(root, 'backup.tar.gz');
    await archiveDirectory(state.server.dataPath, archive);
    expect(await fileChecksum(archive)).toHaveLength(64);
    await extractBackup(archive, path.join(root, 'restored'));
    expect((await fs.stat(path.join(root, 'restored/nested/start.sh'))).mode & 0o111).not.toBe(0);
  });
});
describe('management authorization and conflicts', () => {
  it('saves exactly the selected shared permissions and clears previous inherited roles', async () => {
    const result = await call('/access', 'PUT', {
      username: 'sam',
      permissions: ['server.view', 'server.console'],
    });
    expect(result.statusCode).toBe(200);
    expect(state.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { permissions: ['server.view', 'server.console'], roles: { set: [] } },
      }),
    );
  });
  it('cannot grant permissions above the membership administrator’s own access', async () => {
    expect(
      (
        await call(
          '/access',
          'PUT',
          { username: 'sam', permissions: ['server.files'] },
          'member-admin',
        )
      ).statusCode,
    ).toBe(404);
    expect(state.upsert).not.toHaveBeenCalled();
  });
  it('requires an existing active account before creating shared access', async () => {
    expect(
      (await call('/access', 'PUT', { username: 'missing', permissions: ['server.view'] }))
        .statusCode,
    ).toBe(400);
    expect(state.upsert).not.toHaveBeenCalled();
  });
  it.each(['/files', '/backups', '/updates', '/schedules', '/access'])(
    'denies a viewer access to %s',
    async (endpoint) => {
      expect((await call(endpoint, 'GET', undefined, 'viewer')).statusCode).toBe(404);
    },
  );
  it('enforces API key scope even when the account owns the server', async () => {
    expect((await call('/backups', 'GET', undefined, 'owner', 'server.view')).statusCode).toBe(404);
  });
  it('never serializes backup configuration or stored secrets in the list', async () => {
    await createBackup(state.server);
    const result = await call('/backups');
    expect(result.statusCode).toBe(200);
    expect(result.body).not.toContain('configuration');
    expect(result.body).not.toContain('rcon.password');
  });
  it('reports a background restore failure on the backups page and replaces it after a successful backup', async () => {
    const backup = await createBackup(state.server, 'Before corruption');
    await fs.appendFile(path.join(state.config.backupRoot, backup.filePath!), 'damaged');
    expect((await call(`/backups/${backup.uid}/restore`, 'POST', {})).statusCode).toBe(202);
    await vi.waitFor(async () => {
      expect((await call('/backups')).json().lastOperation).toMatchObject({ action: 'restore.failed', message: expect.stringContaining('checksum') });
    });
    await createBackup(state.server, 'Fresh recovery point');
    state.activities.push({ serverId: 'another-server', action: 'backup.failed', message: 'Unrelated failure' });
    expect((await call('/backups')).json().lastOperation).toMatchObject({ action: 'backup.completed', message: 'Backup ready: Fresh recovery point' });
  });
  it('rejects file writes while running and during other operations', async () => {
    await fs.writeFile(path.join(state.server.dataPath, 'file.txt'), 'old');
    const body = {
      path: 'file.txt',
      content: 'new',
      ...(await readTextFile(state.server.dataPath, 'file.txt')),
    };
    body.content = 'new';
    state.server.state = 'running';
    expect((await call('/files/content', 'PUT', body)).statusCode).toBe(409);
    state.server.state = 'offline';
    await withServerLock('test', async () => {
      expect((await call('/files/content', 'PUT', body)).statusCode).toBe(409);
    });
    expect(await fs.readFile(path.join(state.server.dataPath, 'file.txt'), 'utf8')).toBe('old');
  });
  it('does not let scheduling access grant power or backup capabilities', async () => {
    const response = await call(
      '/schedules',
      'POST',
      {
        name: 'Escalate',
        cron: '0 * * * *',
        timezone: 'UTC',
        actions: [{ type: 'power', action: 'restart' }],
      },
      'scheduler',
    );
    expect(response.statusCode).toBe(404);
  });
});
describe('operational decisions and measurements', () => {
  it('backs off three times, stops crash loops, and resets after a stable interval', () => {
    const now = Date.now();
    expect(crashDecision(true, 0, null, now)).toMatchObject({
      count: 1,
      delay: 30000,
      restart: true,
    });
    expect(crashDecision(true, 2, new Date(now), now)).toMatchObject({
      count: 3,
      delay: 120000,
      restart: true,
    });
    expect(crashDecision(true, 3, new Date(now), now).restart).toBe(false);
    expect(crashDecision(false, 0, null, now).restart).toBe(false);
    expect(crashDecision(true, 10, new Date(now - 700000), now).count).toBe(1);
  });
  it('handles timezone/DST and rejects invalid schedule timing', () => {
    expect(
      nextRun('0 4 * * *', 'America/Los_Angeles', new Date('2026-03-07T13:00:00Z')).toISOString(),
    ).toBe('2026-03-08T11:00:00.000Z');
    expect(() => nextRun('* * * * * *', 'UTC')).toThrow();
    expect(() => nextRun('0 4 * * *', 'bad-zone')).toThrow();
    expect(() =>
      validateSchedule({ name: 'Missing trigger', actions: [{ type: 'backup' }] }),
    ).toThrow();
    expect(actionPermissions([{ type: 'update', startAfter: true }])).toContain('server.backups');
  });
  it('stages a pack without touching the live world, then preserves the latest save and plugin data on apply', async () => {
    const adapter = getAdapter('minecraft-java');
    const resolve = vi.spyOn(adapter, 'resolveVersion').mockResolvedValue({ id: '1.21.5' });
    const runtime = vi.spyOn(adapter, 'detectRuntime').mockResolvedValue(21);
    const install = vi.spyOn(adapter, 'install').mockImplementation(async (ctx) => {
      await fs.writeFile(path.join(ctx.dataPath, 'server.jar'), 'new-server');
      await fs.mkdir(path.join(ctx.dataPath, 'plugins'), { recursive: true });
      await fs.writeFile(path.join(ctx.dataPath, 'plugins/new.jar'), 'new-plugin');
    });
    await fs.mkdir(path.join(state.server.dataPath, 'world'));
    await fs.writeFile(path.join(state.server.dataPath, 'world/level.dat'), 'before-preparation');
    await fs.mkdir(path.join(state.server.dataPath, 'plugins/Example'), { recursive: true });
    await fs.writeFile(
      path.join(state.server.dataPath, 'plugins/Example/config.yml'),
      'custom-config',
    );
    await prepareUpdate(state.server, '1.21.5');
    expect((await readUpdate('test'))?.state).toBe('ready');
    expect(await fs.readFile(path.join(state.server.dataPath, 'world/level.dat'), 'utf8')).toBe(
      'before-preparation',
    );
    await fs.writeFile(path.join(state.server.dataPath, 'world/level.dat'), 'latest-save');
    await applyUpdate(state.server, false);
    expect(await fs.readFile(path.join(state.server.dataPath, 'world/level.dat'), 'utf8')).toBe(
      'latest-save',
    );
    expect(
      await fs.readFile(path.join(state.server.dataPath, 'plugins/Example/config.yml'), 'utf8'),
    ).toBe('custom-config');
    expect(state.server.version).toBe('1.21.5');
    expect(state.backups).toHaveLength(1);
    expect((await readUpdate('test'))?.state).toBe('completed');
    install.mockRestore();
    resolve.mockRestore();
    runtime.mockRestore();
  });
  it('compares installation files and preserves configured world folders', async () => {
    await fs.mkdir(path.join(state.server.dataPath, 'custom'));
    await fs.writeFile(path.join(state.server.dataPath, 'custom/level.dat'), 'world');
    expect(await preservedPaths(state.server)).toContain('custom');
    const before = await directoryInventory(state.server.dataPath);
    await fs.writeFile(path.join(state.server.dataPath, 'new.jar'), 'mod');
    expect(compareInventory(before, await directoryInventory(state.server.dataPath))).toMatchObject(
      { added: ['new.jar'], total: 1 },
    );
  });
  it('records observed players and expires tick readings instead of presenting stale data as live', async () => {
    state.server.containerId = 'container';
    state.server.state = 'running';
    await observeServer(state.server);
    state.callback.onLine('[Server thread/INFO]: Alex joined the game');
    expect(observations(state.server).players).toContain('Alex');
    acceptTickOutput(
      'test',
      'TPS from last 5s, 10s, 1m, 5m, 15m:\n20.0, 20.0, 20.0\nTick durations (min/med/95%ile/max ms) from last 10s, 1m:\n1.0/4.0/10.0/20.0; 1.0/3.0/10.0/20.0',
    );
    expect(observations(state.server).ticks).toMatchObject({ tps: 20, mspt: 4 });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 121000);
    expect(observations(state.server).ticks).toBeNull();
    vi.restoreAllMocks();
    expect(parseTickMetrics('TPS: 19.8\nMSPT: 42.5')).toEqual({ tps: 19.8, mspt: 42.5 });
  });
});
