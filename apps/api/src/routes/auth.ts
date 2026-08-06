import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  badRequest,
  brand,
  conflict,
  loginSchema,
  registerSchema,
  tooManyRequests,
  twoFactorDisableSchema,
  twoFactorEnableSchema,
  twoFactorLoginSchema,
  twoFactorSetupSchema,
  unauthorized,
  usernameSchema,
} from '@serverforge/core';
import { prisma, uid as makeUid } from '@serverforge/db';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSession,
  destroySession,
  requireAuth,
  resolveUser,
  setSessionCookie,
} from '../lib/auth.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { keys, redis } from '../lib/redis.js';
import { recordAudit } from '../lib/events.js';
import { formatSecret, generateSecret, otpauthQr, otpauthUri } from '../lib/totp.js';
import {
  beginEnrolment,
  completeEnrolment,
  consumeTicket,
  countTicketFailure,
  disableTwoFactor,
  discardTicket,
  issueTicket,
  regenerateRecoveryCodes,
  requiresTwoFactor,
  verifySecondFactor,
} from '../services/two-factor.js';

/**
 * Authentication routes.
 *
 * Registration is open only until the first account exists — after that it is
 * invite-only by default. A self-hosted panel exposed to the internet with
 * open registration is a foot-gun, so the safe state is the default state.
 */
/**
 * A valid Argon2 hash of a value nobody knows, computed once and reused.
 * Comparing against it costs the same as a real check.
 */
let decoy: Promise<string> | null = null;
function decoyHash(): Promise<string> {
  decoy ??= hashPassword(`decoy:${Math.random()}`);
  return decoy;
}

function publicUser(user: {
  uid: string;
  username: string;
  displayName: string;
  role: string;
}) {
  return {
    uid: user.uid,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  };
}

/** The tail of a successful sign-in, shared by the one-step and two-step paths. */
async function startSession(
  reply: FastifyReply,
  user: { id: string; uid: string },
  userAgent: string | undefined,
  ip: string,
): Promise<void> {
  const session = await createSession(user.id, {
    ...(userAgent ? { userAgent } : {}),
    ip,
  });
  setSessionCookie(reply, session.token, session.expiresAt);

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await recordAudit({
    actorId: user.id,
    action: 'user.login',
    targetType: 'user',
    targetId: user.uid,
    ip,
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/auth/context', async (request) => {
    const user = await resolveUser(request);
    const userCount = await prisma.user.count();

    return {
      brand: { name: brand.name, tagline: brand.tagline, accent: brand.accent },
      /** True on a fresh install: the UI shows "create your account" instead of a login form. */
      needsSetup: userCount === 0,
      user: user
        ? {
            uid: user.uid,
            username: user.username,
            displayName: user.displayName,
            role: user.role,
          }
        : null,
    };
  });

  app.post('/api/auth/register', async (request, reply) => {
    const input = registerSchema.parse(request.body);

    const userCount = await prisma.user.count();
    if (userCount > 0) {
      const mode = await prisma.setting.findUnique({ where: { key: 'registration.mode' } });
      if ((mode?.value as string) !== 'open') {
        throw conflict(
          'This panel is not accepting new sign-ups.',
          'Ask the person who runs it to invite you.',
        );
      }
    }

    const existing = await prisma.user.findUnique({ where: { username: input.username } });
    if (existing) {
      throw conflict('That username is already taken.', 'Try signing in instead.');
    }

    const user = await prisma.user.create({
      data: {
        uid: makeUid(),
        username: input.username,
        passwordHash: await hashPassword(input.password),
        displayName: input.displayName?.trim() || input.username,
        // The very first account owns the panel.
        role: userCount === 0 ? 'owner' : 'user',
      },
    });

    const session = await createSession(user.id, {
      ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
      ip: request.ip,
    });
    setSessionCookie(reply, session.token, session.expiresAt);

    await recordAudit({
      actorId: user.id,
      action: 'user.register',
      targetType: 'user',
      targetId: user.uid,
      ip: request.ip,
    });

    return reply.code(201).send({ user: publicUser(user) });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const input = loginSchema.parse(request.body);

    // Throttle per username+IP. Counting both means one attacker cannot lock
    // out a legitimate user by hammering their handle from elsewhere.
    const throttleKey = keys.loginAttempts(`${input.username}:${request.ip}`);
    const attempts = await redis.incr(throttleKey);
    if (attempts === 1) await redis.expire(throttleKey, 900);
    if (attempts > 10) {
      throw tooManyRequests('Too many sign-in attempts. Wait 15 minutes and try again.');
    }

    const user = await prisma.user.findUnique({ where: { username: input.username } });

    // Verify against a real hash even when the user does not exist, so
    // response timing does not reveal which usernames have accounts.
    const valid = await verifyPassword(user?.passwordHash ?? (await decoyHash()), input.password);

    if (!user || !valid) {
      throw unauthorized('That username or password is not right.');
    }
    if (user.suspended) {
      throw unauthorized('This account has been suspended.');
    }

    await redis.del(throttleKey);

    // A correct password is not a session when a second factor is owed. The
    // ticket lets the browser come back for step two and nothing else.
    if (requiresTwoFactor(user)) {
      await recordAudit({
        actorId: user.id,
        action: 'user.login_2fa_challenge',
        targetType: 'user',
        targetId: user.uid,
        ip: request.ip,
      });
      return { twoFactorRequired: true, ticket: await issueTicket(user.id) };
    }

    await startSession(reply, user, request.headers['user-agent'], request.ip);
    return { user: publicUser(user) };
  });

  /**
   * Step two. Takes an authenticator code or a recovery code — the person
   * signing in should not have to tell us which kind they are holding.
   */
  app.post('/api/auth/login/2fa', async (request, reply) => {
    const input = twoFactorLoginSchema.parse(request.body);

    const userId = await consumeTicket(input.ticket);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.suspended) {
      await discardTicket(input.ticket);
      throw unauthorized('That sign-in attempt is no longer valid.');
    }

    const result = await verifySecondFactor(user, input.code);
    if (!result.ok) {
      await countTicketFailure(input.ticket);
      await recordAudit({
        actorId: user.id,
        action: 'user.login_2fa_failed',
        targetType: 'user',
        targetId: user.uid,
        ip: request.ip,
      });
      throw unauthorized('That code is not right, or it has already been used.');
    }

    await discardTicket(input.ticket);
    await startSession(reply, user, request.headers['user-agent'], request.ip);

    if (result.usedRecoveryCode) {
      await recordAudit({
        actorId: user.id,
        action: 'user.login_recovery_code',
        targetType: 'user',
        targetId: user.uid,
        metadata: { remaining: result.recoveryCodesLeft },
        ip: request.ip,
      });
    }

    return {
      user: publicUser(user),
      usedRecoveryCode: result.usedRecoveryCode,
      recoveryCodesLeft: result.recoveryCodesLeft,
      ...(result.usedRecoveryCode
        ? {
            hint:
              result.recoveryCodesLeft === 0
                ? 'That was your last recovery code. Generate a new set under Account before you are locked out.'
                : `You have ${result.recoveryCodesLeft} recovery code${result.recoveryCodesLeft === 1 ? '' : 's'} left.`,
          }
        : {}),
    };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies?.[SESSION_COOKIE];
    if (token) await destroySession(token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => {
    const user = await requireAuth(request);
    const record = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: {
        uid: true,
        username: true,
        displayName: true,
        role: true,
        avatarColor: true,
        createdAt: true,
        lastLoginAt: true,
        totpEnabledAt: true,
        recoveryCodeHashes: true,
      },
    });

    // Carried on /me rather than fetched separately: the dashboard shell
    // already blocks on this call, so a second round trip would mean the app
    // renders once before deciding it should have shown the wizard instead.
    // Only owners and admins can run setup, so nobody else is ever nagged.
    const { getSetting, SETUP_COMPLETED } = await import('../lib/settings.js');
    const setupCompleted =
      record.role === 'owner' || record.role === 'admin'
        ? await getSetting<boolean>(SETUP_COMPLETED, false)
        : true;

    // The hashes themselves never leave the server — only how many are left,
    // which is what the account page needs to warn someone running low.
    const { recoveryCodeHashes, totpEnabledAt, ...rest } = record;
    return {
      user: {
        ...rest,
        twoFactorEnabled: totpEnabledAt !== null,
        recoveryCodesLeft: totpEnabledAt !== null ? recoveryCodeHashes.length : 0,
      },
      setupCompleted,
    };
  });

  app.patch('/api/auth/me', async (request) => {
    const user = await requireAuth(request);
    const body = request.body as { displayName?: string; avatarColor?: string; username?: string };

    const data: Record<string, string> = {};
    if (body.displayName !== undefined) {
      const name = body.displayName.trim();
      if (name.length < 1 || name.length > 64) throw badRequest('Choose a name between 1 and 64 characters.');
      data.displayName = name;
    }
    if (body.username !== undefined) {
      const parsed = usernameSchema.safeParse(body.username);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues[0]?.message ?? 'That username is not valid.');
      }
      const taken = await prisma.user.findUnique({ where: { username: parsed.data } });
      if (taken && taken.id !== user.id) {
        throw conflict('That username is already taken.');
      }
      data.username = parsed.data;
    }
    if (body.avatarColor !== undefined) {
      if (!/^#[0-9a-f]{6}$/i.test(body.avatarColor)) throw badRequest('That is not a valid colour.');
      data.avatarColor = body.avatarColor;
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data,
      select: {
        uid: true,
        username: true,
        displayName: true,
        role: true,
        avatarColor: true,
      },
    });
    return { user: updated };
  });

  // ── Two-factor enrolment ──────────────────────────────────────────────
  //
  // Every route here re-asks for the password. The session is already
  // authenticated, but turning 2FA on is exactly what someone who stole a
  // session would do to keep the real owner out — and turning it off is what
  // they would do to keep themselves in.

  app.post('/api/auth/2fa/setup', async (request) => {
    const user = await requireAuth(request);
    const input = twoFactorSetupSchema.parse(request.body);

    const record = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await verifyPassword(record.passwordHash, input.password))) {
      throw unauthorized('That password is not right.');
    }
    if (record.totpEnabledAt) {
      throw conflict(
        'Two-factor authentication is already on.',
        'Turn it off first if you want to set up a different app.',
      );
    }

    const secret = generateSecret();
    await beginEnrolment(user.id, secret);

    const uri = otpauthUri({ secret, account: record.username, issuer: brand.name });

    // A failed QR render must not block enrolment: the setup key below it is
    // the authoritative path and works in every app.
    const qr = await otpauthQr(uri).catch(() => null);

    return {
      secret,
      formattedSecret: formatSecret(secret),
      otpauthUri: uri,
      qrDataUri: qr,
    };
  });

  app.post('/api/auth/2fa/enable', async (request) => {
    const user = await requireAuth(request);
    const input = twoFactorEnableSchema.parse(request.body);

    const record = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!record.totpSecret) {
      throw conflict('Start the setup first.', 'Open Account and choose "Set up two-factor".');
    }
    if (record.totpEnabledAt) {
      throw conflict('Two-factor authentication is already on.');
    }

    // Confirming with a live code is the point: it proves the app is holding
    // the same secret, so nobody locks themselves out of a working account.
    const result = await verifySecondFactor(record, input.code);
    if (!result.ok) {
      throw unauthorized('That code is not right. Check your app and try the next one.');
    }

    const recoveryCodes = await completeEnrolment(record);

    // Existing sessions are left alone on purpose: turning 2FA on protects
    // future sign-ins, and signing someone out of every device they own as a
    // reward for improving their security is a good way to stop them doing it.
    await recordAudit({
      actorId: user.id,
      action: 'user.2fa_enabled',
      targetType: 'user',
      targetId: user.uid,
      ip: request.ip,
    });

    return {
      ok: true,
      recoveryCodes,
      message:
        'Two-factor authentication is on. Save these recovery codes somewhere other than your phone — they are the only way back in if you lose it, and they are not shown again.',
    };
  });

  app.post('/api/auth/2fa/disable', async (request) => {
    const user = await requireAuth(request);
    const input = twoFactorDisableSchema.parse(request.body);

    const record = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!record.totpEnabledAt) {
      throw conflict('Two-factor authentication is not on.');
    }
    if (!(await verifyPassword(record.passwordHash, input.password))) {
      throw unauthorized('That password is not right.');
    }

    const result = await verifySecondFactor(record, input.code);
    if (!result.ok) {
      throw unauthorized('That code is not right, or it has already been used.');
    }

    await disableTwoFactor(user.id);
    await recordAudit({
      actorId: user.id,
      action: 'user.2fa_disabled',
      targetType: 'user',
      targetId: user.uid,
      ip: request.ip,
    });

    return { ok: true, message: 'Two-factor authentication is off.' };
  });

  app.post('/api/auth/2fa/recovery-codes', async (request) => {
    const user = await requireAuth(request);
    const input = twoFactorSetupSchema.parse(request.body);

    const record = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!record.totpEnabledAt) {
      throw conflict('Two-factor authentication is not on.');
    }
    if (!(await verifyPassword(record.passwordHash, input.password))) {
      throw unauthorized('That password is not right.');
    }

    const recoveryCodes = await regenerateRecoveryCodes(user.id);
    await recordAudit({
      actorId: user.id,
      action: 'user.2fa_recovery_codes_regenerated',
      targetType: 'user',
      targetId: user.uid,
      ip: request.ip,
    });

    return {
      ok: true,
      recoveryCodes,
      message: 'These replace your old codes. The old ones no longer work.',
    };
  });

  app.post('/api/auth/password', async (request) => {
    const user = await requireAuth(request);
    const body = request.body as { currentPassword?: string; newPassword?: string };

    if (!body.currentPassword || !body.newPassword) {
      throw badRequest('Enter your current password and the new one.');
    }
    if (body.newPassword.length < 10) {
      throw badRequest('Use at least 10 characters for the new password — a short phrase works well.');
    }

    const record = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await verifyPassword(record.passwordHash, body.currentPassword))) {
      throw unauthorized('Your current password is not right.');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(body.newPassword) },
    });

    // Changing a password should end other sessions — that is the whole point
    // of changing it after a scare.
    await prisma.session.deleteMany({ where: { userId: user.id } });

    await recordAudit({
      actorId: user.id,
      action: 'user.password_change',
      targetType: 'user',
      targetId: user.uid,
      ip: request.ip,
    });

    const activeKeys = await prisma.apiKey.count({
      where: { userId: user.id, revokedAt: null },
    });

    return {
      ok: true,
      message: 'Password changed. You have been signed out everywhere else.',
      activeKeys,
      hint:
        activeKeys > 0
          ? `Your ${activeKeys} API key${activeKeys === 1 ? '' : 's'} still work${activeKeys === 1 ? 's' : ''}. If you changed your password because someone else may have had access, revoke them too.`
          : undefined,
    };
  });
}
