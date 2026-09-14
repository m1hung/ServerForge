import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { isAppError } from '@serverforge/core';
import { createHmac } from 'node:crypto';
const state = vi.hoisted(() => ({ create: vi.fn(), remove: vi.fn() }));
vi.mock('../apps/api/src/lib/config.js', () => ({
  config: { sessionSecret: 'test-proxy-secret', sessionTtlSeconds: 3600, corsOrigins: ['http://localhost:3000'] },
  cookieSecure: () => false,
}));
vi.mock('@serverforge/db', () => ({
  prisma: {
    session: {
      create: state.create,
      deleteMany: state.remove,
      findUnique: async () => ({
        expiresAt: new Date(Date.now() + 100000),
        user: {
          id: 'owner',
          uid: 'owner',
          username: 'owner',
          displayName: 'Owner',
          role: 'owner',
          suspended: false,
        },
      }),
    },
  },
  uid: () => 'id',
}));
import { registerAuth, createSession } from '../apps/api/src/plugins/auth.js';
import { authRoutes } from '../apps/api/src/routes/auth.js';
import { sha256 } from '../apps/api/src/lib/crypto.js';
let app: FastifyInstance;
beforeEach(async () => {
  vi.clearAllMocks();
  state.create.mockResolvedValue({});
  state.remove.mockResolvedValue({ count: 1 });
  app = Fastify({ trustProxy: true });
  await app.register(cookie);
  await registerAuth(app);
  await app.register(authRoutes);
  app.post('/session-test', async (request, reply) => {
    await createSession(reply, 'owner', request);
    return { ok: true };
  });
  app.setErrorHandler((error, request, reply) =>
    reply.code(isAppError(error) ? error.status : 500).send({ error: error.message }),
  );
});
afterEach(async () => app.close());
describe('remote dashboard sessions', () => {
  it('rejects cross-origin browser writes before creating a session', async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/session-test',
      headers: {
        host: 'panel.example.ts.net',
        'x-forwarded-proto': 'https',
        origin: 'https://evil.example',
      },
    });
    expect(result.statusCode).toBe(403);
    expect(state.create).not.toHaveBeenCalled();
  });
  it('accepts the HTTPS dashboard origin and issues a Secure HttpOnly cookie', async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/session-test',
      headers: {
        host: 'api:8080',
        'x-serverforge-proxy-token': createHmac('sha256', 'test-proxy-secret').update('serverforge-web-proxy-v1').digest('hex'),
        'x-forwarded-host': 'panel.example.ts.net',
        'x-forwarded-proto': 'https',
        origin: 'https://panel.example.ts.net',
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.headers['set-cookie']).toContain('HttpOnly');
    expect(result.headers['set-cookie']).toContain('Secure');
    expect(result.headers['set-cookie']).toContain('SameSite=Lax');
  });
  it('keeps a local HTTP dashboard usable and supports configured development origins', async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/session-test',
      headers: { host: '192.168.1.20:3000', origin: 'http://192.168.1.20:3000' },
    });
    expect(result.statusCode).toBe(200);
    expect(result.headers['set-cookie']).not.toContain('Secure');
    const dev = await app.inject({
      method: 'POST',
      url: '/session-test',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(dev.statusCode).toBe(200);
  });
  it('rejects spoofed forwarding headers and does not change cookie security or the recorded client', async () => {
    const spoof = await app.inject({ method: 'POST', url: '/session-test', headers: { host: 'api:8080', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', 'x-forwarded-for': '1.2.3.4', origin: 'https://evil.example' } });
    expect(spoof.statusCode).toBe(403);
    const direct = await app.inject({ method: 'POST', url: '/session-test', headers: { host: 'api:8080', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', 'x-forwarded-for': '1.2.3.4' } });
    expect(direct.statusCode).toBe(200);
    expect(direct.headers['set-cookie']).not.toContain('Secure');
    expect(state.create.mock.calls[0][0].data.ip).not.toBe('1.2.3.4');
  });
  it('blocks a browser cross-site write even without an Origin header', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/session-test',
          headers: { 'sec-fetch-site': 'cross-site' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('revokes the stored session on logout rather than only hiding its browser cookie', async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: 'sf_session=session-token' },
    });
    expect(result.statusCode).toBe(200);
    expect(state.remove).toHaveBeenCalledWith({ where: { tokenHash: sha256('session-token') } });
    expect(result.headers['set-cookie']).toContain('Expires=Thu, 01 Jan 1970');
  });
});
