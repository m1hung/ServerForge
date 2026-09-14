import type { FastifyInstance } from 'fastify';
import {
  loginSchema,
  registerSchema,
  twoFactorLoginSchema,
  unauthorized,
  badRequest,
  brand,
} from '@serverforge/core';
import { prisma, uid } from '@serverforge/db';
import { hashPassword, verifyPassword, sha256, randomToken } from '../lib/crypto.js';
import { verifyTotp, normaliseRecoveryCode } from '../lib/totp.js';
import { createSession, requireUser, clearSessionCookie } from '../plugins/auth.js';

const tickets = new Map<string, { userId: string; expiresAt: number }>();

export async function authRoutes(app: FastifyInstance) {
  app.get('/me', async (request) => {
    if (!request.user) return { user: null };
    return { user: request.user };
  });

  app.get('/setup', async () => {
    const count = await prisma.user.count();
    return { needsSetup: count === 0, brand };
  });

  app.post('/auth/register', async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const existing = await prisma.user.count();
    const taken = await prisma.user.findUnique({ where: { username: body.username } });
    if (taken) throw badRequest('That username is already taken.');
    const user = await prisma.user.create({
      data: {
        uid: uid(),
        username: body.username,
        displayName: body.displayName || body.username,
        passwordHash: await hashPassword(body.password),
        role: existing === 0 ? 'owner' : 'user',
      },
    });
    await createSession(reply, user.id, request);
    return { user: { id: user.id, uid: user.uid, username: user.username, displayName: user.displayName, role: user.role } };
  });

  app.post('/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { username: body.username } });
    if (!user || !(await verifyPassword(user.passwordHash, body.password))) {
      throw unauthorized('Username or password is wrong.');
    }
    if (user.suspended) throw unauthorized('This account is suspended.');
    if (user.totpEnabledAt) {
      const ticket = randomToken(24);
      tickets.set(ticket, { userId: user.id, expiresAt: Date.now() + 5 * 60_000 });
      return { twoFactor: true, ticket };
    }
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await createSession(reply, user.id, request);
    return { user: { id: user.id, uid: user.uid, username: user.username, displayName: user.displayName, role: user.role } };
  });

  app.post('/auth/login/2fa', async (request, reply) => {
    const body = twoFactorLoginSchema.parse(request.body);
    const pending = tickets.get(body.ticket);
    if (!pending || pending.expiresAt < Date.now()) throw unauthorized('That sign-in expired. Try again.');
    const user = await prisma.user.findUnique({ where: { id: pending.userId } });
    if (!user?.totpSecret) throw unauthorized();
    const code = body.code.trim();
    const totpOk = verifyTotp(user.totpSecret, code);
    const recoveryOk = user.recoveryCodeHashes.includes(sha256(normaliseRecoveryCode(code)));
    if (!totpOk && !recoveryOk) throw unauthorized('That code is not valid.');
    if (recoveryOk) {
      await prisma.user.update({
        where: { id: user.id },
        data: { recoveryCodeHashes: user.recoveryCodeHashes.filter((hash) => hash !== sha256(normaliseRecoveryCode(code))) },
      });
    }
    tickets.delete(body.ticket);
    await createSession(reply, user.id, request);
    return { user: { id: user.id, uid: user.uid, username: user.username, displayName: user.displayName, role: user.role } };
  });

  app.post('/auth/logout', async (request, reply) => {
    requireUser(request);
    clearSessionCookie(reply);
    return { ok: true };
  });
}
