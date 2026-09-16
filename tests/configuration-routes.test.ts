import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../apps/api/src/services/platform.js', () => ({ selectGamePlatform: async () => 'linux/amd64' }));
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { isAppError, unauthorized, defaultsFor } from '@serverforge/core';
import { getAdapter } from '@serverforge/adapters';

const state = vi.hoisted(() => ({
  server: {} as Record<string, unknown>,
  update: vi.fn(),
  create: vi.fn(),
  start: vi.fn(),
  status: vi.fn(),
}));
vi.mock('@serverforge/db', () => ({
  prisma: {
    async $transaction(work: (tx: unknown) => unknown) {
      return work(this);
    },
    server: {
      findUnique: async () => state.server,
      findUniqueOrThrow: async () => state.server,
      update: state.update,
    },
  },
  serializeBigInts: (value: unknown) => value,
  uid: () => 'unused',
}));
vi.mock('../apps/api/src/services/resources.js', () => ({
  validateAllocation: async () => undefined,
  nodeCapacity: async () => null,
  requireFreeSpace: async () => undefined,
  measuredServerBytes: () => null,
}));
vi.mock('../apps/api/src/plugins/auth.js', () => ({
  requireUser: (request: FastifyRequest) => {
    if (!request.headers['x-user']) throw unauthorized();
    return { id: request.headers['x-user'], role: 'user' };
  },
}));
vi.mock('../apps/api/src/lib/config.js', () => ({
  config: { dockerSocket: '/none', dataRoot: '/tmp', hostDataRoot: '/tmp' },
  runningInContainer: () => false,
}));
vi.mock('../apps/api/src/lib/server-files.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prepareServerOwnership: async () => undefined,
}));
vi.mock('../apps/api/src/runtime/docker.js', () => ({
  DockerRuntime: class {
    appliedAllocation = async () => null;
    create = state.create;
    start = state.start;
    status = state.status;
    listManaged = async () => [];
    ensureImage = async () => undefined;
  },
}));
import { serverRoutes } from '../apps/api/src/routes/servers.js';

let app: FastifyInstance;
let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-configuration-'));
  state.server = {
    id: 'id',
    uid: 'test',
    name: 'Test server',
    ownerId: 'owner',
    containerId: null,
    gameId: 'minecraft-java',
    variantId: 'paper',
    version: '1.21.4',
    javaMajor: 21,
    state: 'offline',
    dataPath: root,
    memoryMib: 4096,
    cpuCores: 2,
    diskMib: 10240,
    settings: {
      ...defaultsFor(getAdapter('minecraft-java').settingsSchema('paper')),
      'rcon.password': 'kept-secret',
    },
    environment: {},
    javaFlagsPreset: 'balanced',
    allocations: [{ port: 25565, purpose: 'game', primary: true }],
    owner: { passwordHash: 'do-not-expose' },
    subusers: [{ userId: 'viewer', permissions: ['server.view'], roles: [] }],
  };
  state.update.mockImplementation(
    async ({ data }) => (state.server = { ...state.server, ...data }),
  );
  state.create.mockResolvedValue('test-container');
  state.start.mockResolvedValue(undefined);
  state.status.mockResolvedValue({ exists: false, running: false });
  app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (isAppError(error)) return reply.code(error.status).send(error.toJSON());
    return reply
      .code(error.name === 'ZodError' ? 400 : 500)
      .send({ error: { message: error.message } });
  });
  await app.register(serverRoutes);
});
afterEach(async () => {
  await app.close();
  await fs.rm(root, { recursive: true, force: true });
});
function save(payload: object, user = 'owner') {
  return app.inject({
    method: 'PATCH',
    url: '/servers/test',
    headers: { 'x-user': user },
    payload,
  });
}

describe('server configuration', () => {
  it('loads schema and saved values without exposing passwords or owner records', async () => {
    const response = await app.inject({
      url: '/servers/test/settings',
      headers: { 'x-user': 'owner' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      values: { 'max-players': 10 },
      configuredSecrets: ['rcon.password'],
    });
    expect(response.body).not.toContain('kept-secret');
    expect(response.body).not.toContain('do-not-expose');
    expect(
      (await app.inject({ url: '/servers/test', headers: { 'x-user': 'viewer' } })).json().server,
    ).toMatchObject({ canConfigure: false });
    expect(
      (await app.inject({ url: '/servers/test', headers: { 'x-user': 'viewer' } })).body,
    ).not.toContain('kept-secret');
  });
  it('requires settings permission for both reading and editing configuration', async () => {
    expect((await app.inject('/servers/test/settings')).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/servers/test/settings', headers: { 'x-user': 'viewer' } }))
        .statusCode,
    ).toBe(404);
    expect((await save({ limits: { memoryMib: 1024 } }, 'viewer')).statusCode).toBe(404);
    expect(state.update).not.toHaveBeenCalled();
  });
  it('saves settings and allocation together, retaining omitted secrets and coercing values', async () => {
    state.server.state = 'running';
    const result = await save({
      name: 'New name',
      limits: { memoryMib: 6144, cpuCores: 1.5, diskMib: 20480 },
      settings: { 'max-players': '24', pvp: false },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      restartRequired: true,
      server: { name: 'New name', memoryMib: 6144, cpuCores: 1.5 },
    });
    expect(state.server.settings).toMatchObject({
      'max-players': 24,
      pvp: false,
      'rcon.password': 'kept-secret',
    });
    expect(result.body).not.toContain('kept-secret');
    expect(state.update).toHaveBeenCalledOnce();
    expect(await fs.readdir(root)).toEqual([]);
    expect(state.start).not.toHaveBeenCalled();
  });
  it('writes saved game configuration and passes saved hardware to the next launch', async () => {
    await save({
      limits: { memoryMib: 6144, cpuCores: 1.5, diskMib: 20480 },
      settings: { motd: 'Our new server', 'max-players': 24, pvp: false },
    });
    state.start.mockImplementation(async () => {
      const properties = await fs.readFile(path.join(root, 'server.properties'), 'utf8');
      expect(properties).toContain('motd=Our new server');
      expect(properties).toContain('max-players=24');
      expect(properties).toContain('pvp=false');
    });
    const result = await app.inject({
      method: 'POST',
      url: '/servers/test/power',
      headers: { 'x-user': 'owner' },
      payload: { action: 'start' },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({
        limits: expect.objectContaining({ memoryMib: 6144, cpuCores: 1.5, diskMib: 20480 }),
      }),
    );
  });
  it('rejects invalid settings and limits without partially saving anything', async () => {
    expect(
      (await save({ limits: { memoryMib: -1 }, settings: { motd: 'valid' } })).statusCode,
    ).toBe(400);
    expect(
      (await save({ limits: { memoryMib: 8192 }, settings: { 'max-players': 0 } })).statusCode,
    ).toBe(400);
    expect((await save({ settings: { unknown: 'value' } })).statusCode).toBe(400);
    expect(state.update).not.toHaveBeenCalled();
  });
  it.each(['valheim', 'palworld'])(
    'applies %s configuration on its next launch',
    async (gameId) => {
      const adapter = getAdapter(gameId);
      const variantId = adapter.variants[0]!.id;
      Object.assign(state.server, {
        gameId,
        variantId,
        settings: defaultsFor(adapter.settingsSchema(variantId)),
        version: 'latest',
        allocations: adapter.requiredPorts(variantId).map((entry, index) => ({
          ip: '0.0.0.0',
          port: 25565 + index,
          purpose: entry.purpose,
          primary: index === 0,
        })),
      });
      const response = await save({
        settings: { ServerName: 'Saturday crew', ...(gameId === 'valheim' ? { Password: 'qualification-password' } : { AdminPassword: 'qualification-admin-password' }) },
        limits: { memoryMib: 8192, cpuCores: 2.5 },
      });
      expect(response.statusCode, response.body).toBe(200);
      if (gameId === 'palworld') await fs.writeFile(path.join(root, 'PalServer.sh'), '#!/bin/sh\n"$UE_PROJECT_ROOT/Pal/Binaries/Linux/PalServer-Linux-Shipping" Pal "$@"\n');
      const launch = await app.inject({
        method: 'POST',
        url: '/servers/test/power',
        headers: { 'x-user': 'owner' },
        payload: { action: 'start' },
      });
      expect(launch.statusCode, launch.body).toBe(200);
      expect(state.create.mock.calls[0][0].limits.memoryMib).toBe(8192);
      if (gameId === 'valheim')
        expect(state.create.mock.calls[0][0].command).toContain('Saturday crew');
      else
        expect(
          await fs.readFile(
            path.join(root, 'Pal/Saved/Config/LinuxServer/PalWorldSettings.ini'),
            'utf8',
          ),
        ).toContain('ServerName="Saturday crew"');
    },
  );
  it('can explicitly clear a saved password and blocks installer-only changes', async () => {
    expect((await save({ settings: { 'rcon.password': '' } })).statusCode).toBe(200);
    expect((state.server.settings as Record<string, unknown>)['rcon.password']).toBe('');
    state.server.variantId = 'modrinth-modpack';
    state.server.settings = {
      ...defaultsFor(getAdapter('minecraft-java').settingsSchema('modrinth-modpack')),
      modpack_project: 'existing-pack',
    };
    expect((await save({ settings: { modpack_project: 'different-pack' } })).statusCode).toBe(400);
    const response = await app.inject({
      url: '/servers/test/settings',
      headers: { 'x-user': 'owner' },
    });
    expect(
      response.json().schema.some((field: { key: string }) => field.key === 'modpack_project'),
    ).toBe(false);
  });
  it.each(['installing', 'starting', 'stopping', 'restoring'])(
    'blocks saves during %s',
    async (status) => {
      state.server.state = status;
      expect((await save({ limits: { cpuCores: 4 } })).statusCode).toBe(409);
      expect(state.update).not.toHaveBeenCalled();
    },
  );
});
