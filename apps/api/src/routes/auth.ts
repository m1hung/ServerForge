import type { FastifyInstance } from 'fastify';
import {
  loginSchema,
  registerSchema,
  twoFactorLoginSchema,
  unauthorized,
  badRequest,
  forbidden,
  tooManyRequests,
  brand,
} from '@serverforge/core';
import { prisma, uid } from '@serverforge/db';
import { hashPassword, verifyPassword, sha256, randomToken, decryptSecret, safeEqual } from '../lib/crypto.js';
import { config } from '../lib/config.js';
import { matchingTotpCounter, normaliseRecoveryCode } from '../lib/totp.js';
import { createSession, requireUser, clearSessionCookie, revokeSession } from '../plugins/auth.js';

export async function authRoutes(app: FastifyInstance) {
  // ponytail: one API process; use a shared limiter/ticket store before adding replicas.
  const attempts = new Map<string, { count: number; expiresAt: number }>();
  const tickets = new Map<
    string,
    { userId: string; expiresAt: number; attempts: number; busy: boolean; passwordHash: string }
  >();
  let decoyHash: Promise<string> | undefined;

  function limitSignIn(username: string) {
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.expiresAt <= now) attempts.delete(key);
    for (const [key, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(key);
    for (const [key, limit, window] of [
      ['*', 60, 60_000],
      [username, 10, 15 * 60_000],
    ] as const) {
      const entry = attempts.get(key) ?? { count: 0, expiresAt: now + window };
      if (entry.count >= limit) {
        const minutes = Math.ceil((entry.expiresAt - now) / 60_000);
        throw tooManyRequests(
          `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        );
      }
      entry.count += 1;
      attempts.set(key, entry);
    }
  }

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
    limitSignIn(body.username);
    const user = await prisma.$transaction(async (tx) => {
      // Serialize the first-owner decision across simultaneous setup requests.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(193607, 1)`;
      const existing = await tx.user.count();
      if (existing === 0 && (!config.setupTokenHash || !safeEqual(sha256(body.setupToken || ''), config.setupTokenHash)))
        throw forbidden('Enter the one-time setup token displayed by the host installer.');
      const policy = await tx.setting.findUnique({ where: { key: 'registration.mode' } });
      if (existing > 0 && policy?.value !== 'open')
        throw forbidden('Registration is closed. Ask the workspace owner for access.');
      const taken = await tx.user.findUnique({ where: { username: body.username } });
      if (taken) throw badRequest('That username is already taken.');
      return tx.user.create({
        data: {
          uid: uid(),
          username: body.username,
          displayName: body.displayName || body.username,
          passwordHash: await hashPassword(body.password),
          role: existing === 0 ? 'owner' : 'user',
        },
      });
    });
    await createSession(reply, user.id, request);
    return {
      user: {
        id: user.id,
        uid: user.uid,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      },
    };
  });

  app.post('/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    limitSignIn(body.username);
    const user = await prisma.user.findUnique({ where: { username: body.username } });
    const hash = user?.passwordHash ?? (await (decoyHash ??= hashPassword(randomToken())));
    const valid = await verifyPassword(hash, body.password);
    if (!user || !valid) {
      throw unauthorized('Username or password is wrong.');
    }
    if (user.suspended) throw unauthorized('This account is suspended.');
    if (user.totpEnabledAt) {
      const ticket = randomToken(24);
      tickets.set(ticket, {
        userId: user.id,
        expiresAt: Date.now() + 5 * 60_000,
        attempts: 0,
        busy: false,
        passwordHash: user.passwordHash,
      });
      return { twoFactor: true, ticket };
    }
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await createSession(reply, user.id, request);
    return {
      user: {
        id: user.id,
        uid: user.uid,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      },
    };
  });

  app.post('/auth/login/2fa', async (request, reply) => {
    const body = twoFactorLoginSchema.parse(request.body);
    const pending = tickets.get(body.ticket);
    if (!pending || pending.expiresAt <= Date.now() || pending.busy) {
      if (pending && pending.expiresAt <= Date.now()) tickets.delete(body.ticket);
      throw unauthorized('That sign-in expired. Try again.');
    }
    pending.busy = true;
    pending.attempts += 1;
    if (pending.attempts >= 5) tickets.delete(body.ticket);
    try {
      const user = await prisma.$transaction(async (tx) => {
        // Different tickets must not reuse the same TOTP or recovery code concurrently.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(193608, hashtext(${pending.userId}))`;
        const user = await tx.user.findUnique({ where: { id: pending.userId } });
        if (
          !user?.totpSecret ||
          !user.totpEnabledAt ||
          user.suspended ||
          user.passwordHash !== pending.passwordHash
        ) {
          tickets.delete(body.ticket);
          throw unauthorized('That sign-in expired. Try again.');
        }
        const code = body.code.trim();
        const recoveryHash = sha256(normaliseRecoveryCode(code));
        const recoveryOk = user.recoveryCodeHashes.includes(recoveryHash);
        let counter: number | null = null;
        try {
          counter = matchingTotpCounter(decryptSecret(user.totpSecret), code);
        } catch {
          // A recovery code still works if the encrypted authenticator secret is damaged.
        }
        if (!recoveryOk && (counter === null || counter <= (user.totpLastCounter ?? -1)))
          throw unauthorized('That code is not valid or has already been used.');
        await tx.user.update({
          where: { id: user.id },
          data: {
            lastLoginAt: new Date(),
            ...(recoveryOk
              ? {
                  recoveryCodeHashes: user.recoveryCodeHashes.filter(
                    (hash) => hash !== recoveryHash,
                  ),
                }
              : { totpLastCounter: counter! }),
          },
        });
        return user;
      });
      tickets.delete(body.ticket);
      await createSession(reply, user.id, request);
      return {
        user: {
          id: user.id,
          uid: user.uid,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
        },
      };
    } finally {
      pending.busy = false;
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    requireUser(request);
    await revokeSession(request);
    clearSessionCookie(reply);
    return { ok: true };
  });
}
