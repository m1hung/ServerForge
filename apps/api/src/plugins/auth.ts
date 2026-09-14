import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { unauthorized, type Role } from '@serverforge/core';
import { prisma } from '@serverforge/db';
import { config, cookieSecure } from '../lib/config.js';
import { sha256 } from '../lib/crypto.js';

export interface AuthUser {
  id: string;
  uid: string;
  username: string;
  displayName: string;
  role: Role;
  scopes?: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

const COOKIE = 'sf_session';

export async function createSession(reply: FastifyReply, userId: string, request: FastifyRequest) {
  const token = (await import('../lib/crypto.js')).randomToken();
  await prisma.session.create({
    data: {
      tokenHash: sha256(token),
      userId,
      userAgent: request.headers['user-agent']?.slice(0, 256),
      ip: request.ip,
      expiresAt: new Date(Date.now() + config.sessionTtlSeconds * 1000),
    },
  });
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(),
    maxAge: config.sessionTtlSeconds,
  });
}

export async function registerAuth(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    request.user = null;
    const token = request.cookies[COOKIE];
    const bearer = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7)
      : null;
    const raw = token || bearer;
    if (!raw) return;

    if (raw.startsWith('sf_')) {
      const key = await prisma.apiKey.findUnique({
        where: { tokenHash: sha256(raw) },
        include: { user: true },
      });
      if (
        !key ||
        key.user.suspended ||
        key.revokedAt ||
        (key.expiresAt && key.expiresAt < new Date())
      )
        return;
      await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
      request.user = {
        id: key.user.id,
        uid: key.user.uid,
        username: key.user.username,
        displayName: key.user.displayName,
        role: key.user.role,
        scopes: key.scopes,
      };
      return;
    }

    const session = await prisma.session.findUnique({
      where: { tokenHash: sha256(raw) },
      include: { user: true },
    });
    if (!session || session.expiresAt < new Date() || session.user.suspended) return;
    request.user = {
      id: session.user.id,
      uid: session.user.uid,
      username: session.user.username,
      displayName: session.user.displayName,
      role: session.user.role,
    };
  });
}

export function requireUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw unauthorized();
  return request.user;
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(COOKIE, { path: '/' });
}
