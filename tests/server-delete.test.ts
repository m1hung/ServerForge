import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { isAppError, unauthorized } from '@serverforge/core';

const state = vi.hoisted(() => ({
  server: {} as Record<string, unknown>,
  deleted: [] as string[],
  audited: [] as string[],
}));
vi.mock('@serverforge/db', () => ({
  prisma: {
    server: {
      findUnique: async () => state.server,
      update: async ({ data }: { data: Record<string, unknown> }) =>
        Object.assign(state.server, data),
      delete: async ({ where }: { where: { id: string } }) => {
        state.deleted.push(where.id);
      },
    },
  },
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
vi.mock('../apps/api/src/services/account-security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/api/src/services/account-security.js')>()),
  withAccountProof: async (
    _request: unknown,
    proof: { password: string },
    action: (tx: unknown) => Promise<unknown>,
  ) => {
    if (proof.password !== 'correct') throw unauthorized('Your current password is incorrect.');
    return action({});
  },
  audit: async (_tx: unknown, _request: unknown, action: string) => {
    state.audited.push(action);
  },
}));
let root: string;
vi.mock('../apps/api/src/lib/config.js', () => ({
  config: {
    dockerSocket: '/none',
    get dataRoot() {
      return path.join(root, 'data');
    },
    get hostDataRoot() {
      return path.join(root, 'data');
    },
    get backupRoot() {
      return path.join(root, 'backups');
    },
  },
  runningInContainer: () => false,
}));
import { serverRoutes } from '../apps/api/src/routes/servers.js';

let app: FastifyInstance;
let dataPath: string;
let backupPath: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-delete-'));
  dataPath = path.join(root, 'data/servers/test');
  backupPath = path.join(root, 'backups/test');
  await fs.mkdir(dataPath, { recursive: true });
  await fs.mkdir(backupPath, { recursive: true });
  await fs.writeFile(path.join(dataPath, 'world.dat'), 'world');
  await fs.writeFile(path.join(backupPath, 'b1.tar.gz'), 'backup');
  state.deleted = [];
  state.audited = [];
  state.server = {
    id: 'id',
    uid: 'test',
    name: 'Test',
    ownerId: 'owner',
    dataPath,
    gameId: 'minecraft-java',
    variantId: 'fabric',
    state: 'offline',
    containerId: null,
    publicAccess: false,
    allocations: [],
    subusers: [{ userId: 'viewer', permissions: ['server.view'], roles: [] }],
  };
  app = Fastify();
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
const remove = (password: string, user = 'owner') =>
  app.inject({
    method: 'DELETE',
    url: '/servers/test',
    headers: { 'x-user': user },
    payload: { password },
  });
const exists = (target: string) =>
  fs.access(target).then(
    () => true,
    () => false,
  );

describe('DELETE /servers/:uid', () => {
  it('refuses while running, on a bad password, and without the delete permission', async () => {
    state.server.state = 'running';
    expect((await remove('correct')).statusCode).toBe(409);
    state.server.state = 'offline';
    expect((await remove('wrong')).statusCode).toBe(401);
    expect((await remove('correct', 'viewer')).statusCode).toBe(404);
    expect(state.deleted).toEqual([]);
    expect(await exists(path.join(dataPath, 'world.dat'))).toBe(true);
    expect(await exists(path.join(backupPath, 'b1.tar.gz'))).toBe(true);
  });
  it('removes the record, game files and backups once the password checks out', async () => {
    expect((await remove('correct')).statusCode).toBe(200);
    expect(state.deleted).toEqual(['id']);
    expect(state.audited).toEqual(['server.deleted']);
    expect(await exists(dataPath)).toBe(false);
    expect(await exists(backupPath)).toBe(false);
  });
});
