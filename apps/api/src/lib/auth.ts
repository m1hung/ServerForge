import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized, type Role, type ServerPermission } from '@serverforge/core';
import { prisma, uid as makeUid, type ServerWithAccess } from '@serverforge/db';
import { config } from '../config.js';
import { generateToken, hashToken } from './crypto.js';

/**
 * Authentication and authorisation.
 *
 * Two credential types share one resolution path:
 *   • session cookies for the dashboard
 *   • `Authorization: Bearer sf_…` API keys for scripts and CI
 *
 * Both resolve to the same `AuthenticatedUser`, so route handlers never care
 * which was used.
 */

export const SESSION_COOKIE = 'sf_session';

export interface AuthenticatedUser {
  id: string;
  uid: string;
  username: string;
  displayName: string;
  role: Role;
  /** Set when the request authenticated with an API key rather than a cookie. */
  apiKeyId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

export async function createSession(
  userId: string,
  meta: { userAgent?: string; ip?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken('sf_sess');
  const expiresAt = new Date(Date.now() + config.SESSION_TTL * 1000);

  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      ip: meta.ip ?? null,
    },
  });

  return { token, expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    // `lax` still sends the cookie on top-level navigation while blocking
    // cross-site POSTs.
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    secure: config.cookieSecure,
    sameSite: 'lax',
  });
}

/** Resolves credentials without throwing. Used by optional-auth routes. */
export async function resolveUser(request: FastifyRequest): Promise<AuthenticatedUser | null> {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return resolveApiKey(header.slice(7).trim());
  }

  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date()) return null;
  if (session.user.suspended) return null;

  return {
    id: session.user.id,
    uid: session.user.uid,
    username: session.user.username,
    displayName: session.user.displayName,
    role: session.user.role,
  };
}

async function resolveApiKey(token: string): Promise<AuthenticatedUser | null> {
  const key = await prisma.apiKey.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!key || key.revokedAt) return null;
  if (key.expiresAt && key.expiresAt < new Date()) return null;
  if (key.user.suspended) return null;

  // Fire-and-forget: a failed timestamp update must not fail the request.
  void prisma.apiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return {
    id: key.user.id,
    uid: key.user.uid,
    username: key.user.username,
    displayName: key.user.displayName,
    role: key.user.role,
    apiKeyId: key.id,
  };
}

/** Fastify preHandler that requires a signed-in user. */
export async function requireAuth(request: FastifyRequest): Promise<AuthenticatedUser> {
  const user = request.user ?? (await resolveUser(request));
  if (!user) throw unauthorized();
  request.user = user;
  return user;
}

export async function requireRole(request: FastifyRequest, roles: Role[]): Promise<AuthenticatedUser> {
  const user = await requireAuth(request);
  if (!roles.includes(user.role)) throw forbidden('That action is limited to administrators.');
  return user;
}

/**
 * Resolves a server the user is allowed to touch, checking the specific
 * permission. Owners and panel admins bypass the per-server list.
 *
 * Returns the server row so callers do not need a second query.
 */
export async function requireServerAccess(
  request: FastifyRequest,
  serverUid: string,
  permission: ServerPermission,
): Promise<{ user: AuthenticatedUser; server: ServerWithAccess }> {
  const user = await requireAuth(request);

  const server = await prisma.server.findUnique({
    where: { uid: serverUid },
    include: { allocations: true, node: true, subusers: { where: { userId: user.id } } },
  });

  // Deliberately a 404 rather than a 403: an unauthorised user should not be
  // able to probe which server ids exist.
  if (!server) throw unauthorized();

  const isOwner = server.ownerId === user.id;
  const isAdmin = user.role === 'owner' || user.role === 'admin';
  if (isOwner || isAdmin) return { user, server };

  const membership = server.subusers[0];
  if (!membership) throw unauthorized();
  if (!membership.permissions.includes(permission)) {
    throw forbidden(`You don't have the "${permission.replace('server.', '')}" permission here.`);
  }

  return { user, server };
}

/** Issues an API key, returning the plaintext exactly once. */
export async function issueApiKey(
  userId: string,
  input: { name: string; scopes: string[]; expiresAt?: Date | null },
): Promise<{ token: string; id: string; prefix: string }> {
  const token = generateToken('sf_live');
  const record = await prisma.apiKey.create({
    data: {
      uid: makeUid(),
      name: input.name,
      tokenHash: hashToken(token),
      prefix: token.slice(0, 16),
      scopes: input.scopes,
      userId,
      expiresAt: input.expiresAt ?? null,
    },
  });
  return { token, id: record.id, prefix: record.prefix };
}

/** Removes expired sessions. Runs on a timer from the worker process. */
export async function pruneSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return result.count;
}
