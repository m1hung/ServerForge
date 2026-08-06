import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  explainRefusal,
  forbidden,
  resolveServerAccess,
  sanitisePermissionMap,
  unauthorized,
  type AccessInput,
  type Role,
  type ServerPermission,
} from '@serverforge/core';
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
 * which was used — except API keys may be scope-limited.
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
  /** Scopes on the API key. Absent for cookie sessions (full account power). */
  apiKeyScopes?: string[];
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
    apiKeyScopes: key.scopes,
  };
}

/**
 * Whether an API key is allowed to exercise a scope.
 * Cookie sessions always pass — the key check only applies to Bearer auth.
 */
export function apiKeyAllows(user: AuthenticatedUser, scope: string): boolean {
  if (!user.apiKeyId) return true;
  const scopes = user.apiKeyScopes ?? [];
  if (scopes.includes('*')) return true;
  if (scopes.includes(scope)) return true;
  return false;
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
  if (!apiKeyAllows(user, 'admin')) {
    throw forbidden('This API key is not allowed to perform administrator actions.');
  }
  return user;
}

/**
 * Turns a membership row into the shape the resolver understands.
 *
 * Exported because the routes that report *effective* permissions to the
 * dashboard have to build the same input — if they built it differently the
 * UI would show tabs the API then refuses.
 */
export function accessInputFor(
  user: { id: string; role: Role },
  server: { ownerId: string; subusers: ServerWithAccess['subusers'] },
): AccessInput {
  const membership = server.subusers.find((entry) => entry.userId === user.id);
  return {
    panelRole: user.role,
    isServerOwner: server.ownerId === user.id,
    directGrants: membership?.permissions ?? [],
    roles: (membership?.roles ?? []).map((role) => ({
      name: role.name,
      permissions: sanitisePermissionMap(role.permissions),
    })),
  };
}

/**
 * Resolves a server the user is allowed to touch, checking the specific
 * permission.
 *
 * The decision itself lives in `resolveServerAccess` — a pure function with an
 * exhaustive test suite — so this only has to fetch the inputs and translate a
 * refusal into the right HTTP status. An API key is a *ceiling*: it can narrow
 * what its owner may do through that key, never widen it, so it is checked
 * first and independently.
 *
 * Returns the server row so callers do not need a second query.
 */
export async function requireServerAccess(
  request: FastifyRequest,
  serverUid: string,
  permission: ServerPermission,
): Promise<{ user: AuthenticatedUser; server: ServerWithAccess }> {
  const user = await requireAuth(request);

  if (!apiKeyAllows(user, permission)) {
    throw forbidden(
      `This API key is missing the "${permission.replace('server.', '')}" scope.`,
    );
  }

  const server = await prisma.server.findUnique({
    where: { uid: serverUid },
    include: {
      allocations: true,
      node: true,
      // Not filtered to this user: the row is handed to callers as
      // `ServerWithAccess`, and the sub-user screens need the full list.
      subusers: { include: { roles: true } },
    },
  });

  // Deliberately a 404 rather than a 403: an unauthorised user should not be
  // able to probe which server ids exist.
  if (!server) throw unauthorized();

  const decision = resolveServerAccess(accessInputFor(user, server), permission);
  if (decision.allowed) return { user, server };

  // Someone with no relationship to the server at all is told it does not
  // exist, for the same reason as above. Someone who *is* on the server but
  // lacks this one permission already knows it exists, so they get the real
  // reason — including which role took it away, if one did.
  const known =
    server.ownerId === user.id ||
    user.role === 'admin' ||
    server.subusers.some((entry) => entry.userId === user.id);
  if (!known) throw unauthorized();

  throw forbidden(explainRefusal(decision, permission));
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
