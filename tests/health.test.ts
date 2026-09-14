import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { isAppError } from '@serverforge/core';

const state = vi.hoisted(() => ({ database: true, docker: true, storage: true, schema: true, collation: true }));
vi.mock('@serverforge/db', () => ({
  prisma: {
    server: { findMany: async () => [] },
    setting: { findMany: async () => [] },
    installationAttempt: { findMany: async () => [] },
    schedule: { findMany: async () => [] },
    $queryRaw: async (sql: TemplateStringsArray) => {
      if (!state.database || (sql[0].includes('totpLastCounter') && !state.schema))
        throw new Error('unavailable');
      if (sql[0].includes('_prisma_migrations')) return [{ migration_name: '202609140003_release_candidate' }];
      if (sql[0].includes('pg_database_collation_actual_version')) return [{ current: state.collation }];
      return [];
    },
  },
}));
vi.mock('../apps/api/src/lib/config.js', () => ({
  config: {
    dockerSocket: '/none',
    dataRoot: '/data',
    backupRoot: '/backups',
    cacheRoot: '/cache',
    brand: { name: 'ServerForge' },
  },
}));
vi.mock('node:fs/promises', () => ({
  default: {
    access: async () => {
      if (!state.storage) throw new Error('readonly');
    },
  },
}));
vi.mock('../apps/api/src/runtime/docker.js', () => ({
  DockerRuntime: class {
    ping = async () => state.docker;
    capabilities = async () => ({});
    listManaged = async () => [];
  },
}));
import { healthRoutes } from '../apps/api/src/routes/health.js';
import { lifecycle } from '../apps/api/src/services/lifecycle.js';
import {
  beginServerOperation,
  drainServerOperations,
  activeServerOperations,
} from '../apps/api/src/services/server-lock.js';

let clock = Date.now();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime((clock += 10000));
  Object.assign(state, { database: true, docker: true, storage: true, schema: true, collation: true });
  Object.assign(lifecycle, {
    mode: 'ready',
    supervisorRequired: true,
    lastSupervisorTickAt: Date.now(),
  });
});
afterEach(() => {
  vi.useRealTimers();
  Object.assign(lifecycle, { mode: 'ready', supervisorRequired: false });
});

async function app() {
  const result = Fastify();
  result.decorateRequest('user', null);
  result.addHook('onRequest', async (request) => {
    if (request.headers['x-test-user'])
      request.user = {
        id: 'test',
        uid: 'test',
        username: 'test',
        displayName: 'test',
        role: 'owner',
        ...(request.headers['x-test-scope']
          ? { scopes: [String(request.headers['x-test-scope'])] }
          : {}),
      };
  });
  result.setErrorHandler((error, _request, reply) =>
    reply.code(isAppError(error) ? error.status : 500).send({ error: error.message }),
  );
  await result.register(healthRoutes);
  return result;
}

it.each(['database', 'schema', 'collation', 'docker', 'storage'] as const)(
  'reports a failed %s dependency as not ready while remaining live',
  async (dependency) => {
    state[dependency] = false;
    const server = await app();
    for (const path of ['/health', '/health/ready']) {
      const response = await server.inject(path);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        ok: false,
        brand: 'ServerForge',
        checks: { [dependency]: false },
      });
    }
    expect((await server.inject('/health/live')).statusCode).toBe(200);
    await server.close();
  },
);

it('checks the supervisor heartbeat and restricts detailed status to unscoped admins', async () => {
  const server = await app();
  expect((await server.inject('/health/ready')).statusCode).toBe(200);
  lifecycle.lastSupervisorTickAt = Date.now() - 46000;
  expect((await server.inject('/health/ready')).statusCode).toBe(503);
  expect((await server.inject('/api/system/status')).statusCode).toBe(401);
  expect(
    (
      await server.inject({
        url: '/api/system/status',
        headers: { 'x-test-user': 'owner', 'x-test-scope': 'server.view' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await server.inject({ url: '/api/system/status', headers: { 'x-test-user': 'owner' } }))
      .statusCode,
  ).toBe(200);
  await server.close();
});

it('rejects new work while draining existing operations with a bounded timeout', async () => {
  let finish!: () => void;
  const running = beginServerOperation(
    'drain-test',
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  lifecycle.mode = 'stopping';
  expect(() => beginServerOperation('new', async () => {})).toThrow(/shutting down/);
  const drain = drainServerOperations(100);
  await vi.advanceTimersByTimeAsync(100);
  expect(await drain).toBe(false);
  expect(activeServerOperations()).toContain('drain-test');
  finish();
  await running;
  expect(await drainServerOperations()).toBe(true);
  expect(activeServerOperations()).toEqual([]);
});
