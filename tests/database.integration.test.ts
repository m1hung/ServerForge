import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@serverforge/db';

const enabled = !!process.env.SF_TEST_DATABASE_URL;
if (process.env.SF_REQUIRE_INTEGRATION === '1' && !enabled)
  throw new Error('Required database tests need npm run test:integration.');
if (enabled) {
  const url = new URL(process.env.SF_TEST_DATABASE_URL!);
  if (
    url.pathname !== '/serverforge_test' ||
    url.username !== 'serverforge_test' ||
    process.env.DATABASE_URL !== url.href ||
    !/^serverforge-test-[a-f0-9]+$/.test(process.env.SF_TEST_PROJECT ?? '')
  )
    throw new Error('Refusing database tests outside the isolated test project.');
}

describe.skipIf(!enabled)('authentication against real Postgres', () => {
  let app: FastifyInstance;
  const password = 'integration-only password 123';
  const register = (username: string) =>
    app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password, setupToken: process.env.SF_TEST_SETUP_TOKEN } });

  beforeAll(async () => {
    const [{ name }] = await prisma.$queryRaw<
      { name: string }[]
    >`SELECT current_database() AS name`;
    expect(name).toBe('serverforge_test');
    const { buildApp } = await import('../apps/api/src/app.js');
    app = await buildApp();
  });
  beforeEach(async () => {
    await prisma.server.deleteMany();
    await prisma.node.deleteMany();
    await prisma.user.deleteMany();
    await prisma.setting.upsert({
      where: { key: 'registration.mode' },
      create: { key: 'registration.mode', value: 'invite_only' },
      update: { value: 'invite_only' },
    });
  });
  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  it('serializes competing first-owner requests in the database', async () => {
    const responses = await Promise.all([register('first'), register('second')]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 403]);
    expect(await prisma.user.count({ where: { role: 'owner' } })).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });

  it('persists only a session hash and revokes it on logout', async () => {
    const response = await register('owner');
    expect(response.statusCode).toBe(200);
    const cookie = response.cookies.find((c) => c.name === 'sf_session')!;
    const session = await prisma.session.findFirstOrThrow();
    expect(session.tokenHash).toBe(createHash('sha256').update(cookie.value).digest('hex'));
    const headers = { cookie: `sf_session=${cookie.value}` };
    expect((await app.inject({ url: '/api/me', headers })).json().user.role).toBe('owner');
    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/logout', headers })).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: '/api/me', headers })).json().user).toBeNull();
    expect(await prisma.session.count()).toBe(0);
  });

  it('denies existing sessions immediately when the account is suspended', async () => {
    const response = await register('owner');
    const cookie = response.cookies.find((c) => c.name === 'sf_session')!;
    await prisma.user.updateMany({ data: { suspended: true } });
    expect(
      (
        await app.inject({ url: '/api/me', headers: { cookie: `sf_session=${cookie.value}` } })
      ).json().user,
    ).toBeNull();
  });

  it('serializes concurrent memory reservations and permits reducing an existing over-allocation', async () => {
    await register('owner');
    const owner = await prisma.user.findFirstOrThrow();
    const node = await prisma.node.create({
      data: { uid: 'test-node', name: 'Test', memoryMib: 2048, overheadPct: 10 },
    });
    const { validateAllocation } = await import('../apps/api/src/services/resources.js');
    const limits = { memoryMib: 1024, cpuCores: 1, diskMib: 0 };
    const outcomes = await Promise.allSettled(
      ['first', 'second'].map((uid) =>
        prisma.$transaction(async (tx) => {
          await validateAllocation(tx, node, limits);
          return tx.server.create({
            data: {
              uid,
              name: uid,
              gameId: 'minecraft-java',
              variantId: 'vanilla',
              version: '1.21.4',
              ownerId: owner.id,
              nodeId: node.id,
              dataPath: `/fixture/${uid}`,
              ...limits,
            },
          });
        }),
      ),
    );
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.server.count()).toBe(1);
    const server = await prisma.server.findFirstOrThrow();
    await prisma.server.update({ where: { id: server.id }, data: { memoryMib: 4096 } });
    await expect(
      prisma.$transaction((tx) =>
        validateAllocation(
          tx,
          node,
          { ...limits, memoryMib: 3072 },
          { ...server, memoryMib: 4096 },
        ),
      ),
    ).resolves.toBeDefined();
  });
});
