import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { isAppError } from '@serverforge/core';

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  policy: 'invite_only' as string | null,
  sessions: vi.fn(),
  lock: vi.fn(),
  verify: vi.fn(),
}));
vi.mock('../apps/api/src/lib/config.js', () => ({
  config: { setupTokenHash: 'ce7bc318464464c62af47f18c0707bc4c6b765228072f21e3a28dea4087715bb', sessionTtlSeconds: 3600, corsOrigins: [], encryptionKey: 'ab'.repeat(32) },
  cookieSecure: () => false,
}));
vi.mock('../apps/api/src/lib/crypto.js', async (original) => ({
  ...(await original<object>()),
  hashPassword: async (password: string) => `hash:${password}`,
  verifyPassword: state.verify,
}));
vi.mock('@serverforge/db', () => {
  const prisma = {
    user: {
      count: async () => state.rows.length,
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        state.rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `user-${state.rows.length}`, ...data };
        state.rows.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.rows.find((user) => user.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    setting: { findUnique: async () => (state.policy === null ? null : { value: state.policy }) },
    session: { create: state.sessions },
    $executeRaw: state.lock,
  };
  let transaction = Promise.resolve();
  return {
    uid: () => 'uid',
    prisma: {
      ...prisma,
      $transaction: (run: (tx: typeof prisma) => Promise<unknown>) => {
        const result = transaction.then(() => run(prisma));
        transaction = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    },
  };
});

import { authRoutes } from '../apps/api/src/routes/auth.js';
import { registerAuth } from '../apps/api/src/plugins/auth.js';
import { encryptSecret, sha256 } from '../apps/api/src/lib/crypto.js';
import { totp } from '../apps/api/src/lib/totp.js';

const secret = 'JBSWY3DPEHPK3PXP';
const password = 'a long test password';
let app: FastifyInstance;
const post = (url: string, payload: unknown, headers?: Record<string, string>) =>
  app.inject({ method: 'POST', url, payload, headers });
const login = async () => {
  const response = await post('/auth/login', { username: 'owner', password });
  expect(response.statusCode).toBe(200);
  return response.json().ticket as string;
};
const twoFactor = () =>
  Object.assign(state.rows[0]!, {
    totpSecret: encryptSecret(secret),
    totpEnabledAt: new Date(),
    totpLastCounter: null,
    recoveryCodeHashes: [sha256('ABCDEFGHJK')],
  });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T04:00:00Z'));
  vi.clearAllMocks();
  state.policy = 'invite_only';
  state.rows = [
    {
      id: 'owner',
      uid: 'owner',
      username: 'owner',
      displayName: 'Owner',
      role: 'owner',
      passwordHash: `hash:${password}`,
      suspended: false,
    },
  ];
  state.sessions.mockResolvedValue({});
  state.verify.mockImplementation(async (hash: string, input: string) => hash === `hash:${input}`);
  app = Fastify({ trustProxy: true });
  app.setErrorHandler((error, request, reply) =>
    reply
      .code(isAppError(error) ? error.status : error.name === 'ZodError' ? 400 : 500)
      .send({ error: error.message }),
  );
  await app.register(cookie);
  await registerAuth(app);
  await app.register(authRoutes);
});
afterEach(async () => {
  await app.close();
  vi.useRealTimers();
});

describe('registration and password sign-in', () => {
  it.each(['invite_only', 'closed', null])('honors the %s registration policy', async (policy) => {
    state.policy = policy;
    expect((await post('/auth/register', { username: 'stranger', password })).statusCode).toBe(403);
    expect(state.rows).toHaveLength(1);
    expect(state.sessions).not.toHaveBeenCalled();
  });
  it('allows explicitly open registration without granting ownership', async () => {
    state.policy = 'open';
    const response = await post('/auth/register', { username: 'friend', password });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.role).toBe('user');
  });
  it('serializes first-account setup and creates exactly one owner', async () => {
    state.rows = [];
    const responses = await Promise.all(
      ['first', 'second'].map((username) => post('/auth/register', { username, password, setupToken: 'test-setup-token' })),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([200, 403]);
    expect(state.rows.map((row) => row.role)).toEqual(['owner']);
    expect(state.lock).toHaveBeenCalledTimes(2);
  });
  it('uses a password verification for unknown users too', async () => {
    expect((await post('/auth/login', { username: 'missing', password })).statusCode).toBe(401);
    expect(state.verify).toHaveBeenCalledOnce();
  });
  it('limits a username even when forwarded IP headers change, then expires the limit', async () => {
    for (let i = 0; i < 10; i++) {
      expect(
        (
          await post(
            '/auth/login',
            { username: 'OWNER', password: 'wrong' },
            {
              'x-forwarded-for': `192.0.2.${i + 1}`,
            },
          )
        ).statusCode,
      ).toBe(401);
    }
    expect((await post('/auth/login', { username: 'owner', password })).statusCode).toBe(429);
    expect(state.verify).toHaveBeenCalledTimes(10);
    vi.setSystemTime(Date.now() + 15 * 60_000);
    expect((await post('/auth/login', { username: 'owner', password })).statusCode).toBe(200);
  });
  it('bounds password work across a spray of different usernames', async () => {
    for (let i = 0; i < 60; i++)
      expect((await post('/auth/login', { username: `missing-${i}`, password })).statusCode).toBe(
        401,
      );
    expect((await post('/auth/login', { username: 'different', password })).statusCode).toBe(429);
    expect(state.verify).toHaveBeenCalledTimes(60);
  });
  it('rejects oversized passwords before hashing', async () => {
    const response = await post('/auth/login', { username: 'owner', password: 'x'.repeat(201) });
    expect(response.statusCode).toBe(400);
    expect(state.verify).not.toHaveBeenCalled();
  });
});

describe('two-factor sign-in', () => {
  it('decrypts the stored secret, consumes tickets, and rejects a previously accepted time step', async () => {
    twoFactor();
    const ticket = await login();
    expect(state.sessions).not.toHaveBeenCalled();
    const code = totp(secret);
    expect((await post('/auth/login/2fa', { ticket, code })).statusCode).toBe(200);
    expect((await post('/auth/login/2fa', { ticket, code })).statusCode).toBe(401);
    const second = await login();
    expect((await post('/auth/login/2fa', { ticket: second, code })).statusCode).toBe(401);
    vi.setSystemTime(Date.now() + 30_000);
    expect((await post('/auth/login/2fa', { ticket: second, code: totp(secret) })).statusCode).toBe(
      200,
    );
    expect(state.sessions).toHaveBeenCalledTimes(2);
  });
  it('expires a ticket after five wrong codes', async () => {
    twoFactor();
    const ticket = await login();
    for (let i = 0; i < 5; i++)
      expect((await post('/auth/login/2fa', { ticket, code: 'invalid' })).statusCode).toBe(401);
    expect((await post('/auth/login/2fa', { ticket, code: totp(secret) })).statusCode).toBe(401);
    expect(state.sessions).not.toHaveBeenCalled();
  });
  it('consumes a recovery code once even across concurrent tickets', async () => {
    twoFactor();
    const tickets = [await login(), await login()];
    const responses = await Promise.all(
      tickets.map((ticket) => post('/auth/login/2fa', { ticket, code: 'abcde-fghjk' })),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 401]);
    expect(state.rows[0]!.recoveryCodeHashes).toEqual([]);
    expect(state.sessions).toHaveBeenCalledOnce();
  });
  it.each(['suspended', 'password', 'disabled'])(
    'rejects a pending sign-in after the account is %s',
    async (change) => {
      twoFactor();
      const ticket = await login();
      Object.assign(
        state.rows[0]!,
        change === 'suspended'
          ? { suspended: true }
          : change === 'password'
            ? { passwordHash: 'new' }
            : { totpEnabledAt: null },
      );
      expect((await post('/auth/login/2fa', { ticket, code: totp(secret) })).statusCode).toBe(401);
      expect(state.sessions).not.toHaveBeenCalled();
    },
  );
  it('expires unused tickets after five minutes', async () => {
    twoFactor();
    const ticket = await login();
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect((await post('/auth/login/2fa', { ticket, code: totp(secret) })).statusCode).toBe(401);
  });
});
