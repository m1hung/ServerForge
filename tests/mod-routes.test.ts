import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { isAppError } from '@serverforge/core';

const state = vi.hoisted(() => ({ server: {} as Record<string, unknown> }));
vi.mock('@serverforge/db', () => ({
  prisma: { server: { findUnique: async () => state.server } },
  serializeBigInts: (value: unknown) => value,
  uid: () => 'new-server',
}));
vi.mock('../apps/api/src/plugins/auth.js', () => ({
  requireAdmin: () => ({ id: 'owner', role: 'owner' }),
  requireUser: (request: FastifyRequest) => ({
    id: request.headers['x-user'] ?? 'owner',
    role: 'user',
  }),
}));
vi.mock('../apps/api/src/lib/config.js', () => ({
  config: { dockerSocket: '/none', dataRoot: '/tmp', hostDataRoot: '/tmp' },
  runningInContainer: () => false,
}));
import { serverRoutes } from '../apps/api/src/routes/servers.js';

let app: FastifyInstance;
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-mod-routes-'));
  state.server = {
    id: 'id',
    uid: 'test',
    name: 'Test',
    ownerId: 'owner',
    dataPath: root,
    gameId: 'minecraft-java',
    variantId: 'fabric',
    state: 'offline',
    allocations: [],
    subusers: [{ userId: 'viewer', permissions: ['server.view'], roles: [] }],
  };
  app = Fastify();
  await app.register(multipart);
  app.setErrorHandler((error, _request, reply) => {
    if (isAppError(error)) return reply.code(error.status).send(error.toJSON());
    return reply.code(500).send({ error: { message: error.message } });
  });
  await app.register(serverRoutes);
});
afterEach(async () => {
  await app.close();
  await fs.rm(root, { force: true, recursive: true });
});
function upload(user = 'owner') {
  return app.inject({
    method: 'POST',
    url: '/servers/test/mods',
    headers: { 'x-user': user, 'content-type': 'multipart/form-data; boundary=modboundary' },
    payload:
      '--modboundary\r\nContent-Disposition: form-data; name="file"; filename="example.jar"\r\nContent-Type: application/java-archive\r\n\r\nmod contents\r\n--modboundary--\r\n',
  });
}

describe('mods HTTP API', () => {
  it('uploads, lists, disables and enables a real file through multipart and JSON requests', async () => {
    expect((await upload()).statusCode).toBe(201);
    expect((await app.inject('/servers/test/mods')).json().files).toEqual([
      { name: 'example.jar', enabled: true, size: 12 },
    ]);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/servers/test/mods',
          payload: { name: 'example.jar', enabled: false },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject('/servers/test/mods')).json().files[0].enabled).toBe(false);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/servers/test/mods',
          payload: { name: 'example.jar.disabled', enabled: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(await fs.readFile(path.join(root, 'mods/example.jar'), 'utf8')).toBe('mod contents');
  });
  it('enforces server.mods permission independently of view permission', async () => {
    expect((await upload('viewer')).statusCode).toBe(404);
    expect(
      (await app.inject({ url: '/servers/test/mods', headers: { 'x-user': 'viewer' } })).json(),
    ).toMatchObject({ canManage: false, files: [] });
    expect(await fs.readdir(root)).toEqual([]);
  });
  it('blocks changes on a running server and vanilla editions', async () => {
    state.server.state = 'running';
    expect((await upload()).statusCode).toBe(409);
    state.server.state = 'offline';
    state.server.variantId = 'vanilla';
    expect((await upload()).statusCode).toBe(400);
    expect(await fs.readdir(root)).toEqual([]);
  });
  it('rejects Minecraft creation before any install unless the EULA was accepted', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/servers',
      payload: {
        name: 'Test server',
        gameId: 'minecraft-java',
        variantId: 'fabric',
        version: '1.20.1',
        limits: { memoryMib: 4096, cpuCores: 2, diskMib: 10240 },
        settings: {},
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/EULA/);
    expect(await fs.readdir(root)).toEqual([]);
  });
});
