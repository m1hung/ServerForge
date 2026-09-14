import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { prisma, uid } from '@serverforge/db';
import { SERVER_PERMISSIONS, registerSchema, badRequest, forbidden, notFound } from '@serverforge/core';
import { createSession, requireAdmin } from '../plugins/auth.js';
import { hashPassword, randomToken, sha256 } from '../lib/crypto.js';
import { accountRateLimit, audit, proofSchema, withAccountProof } from '../services/account-security.js';
import { closeConsoleStreams } from '../services/console-stream.js';

const grants = z.array(z.object({ serverUid: z.string().min(1).max(64), permissions: z.array(z.enum(SERVER_PERMISSIONS)).min(1).max(SERVER_PERMISSIONS.length) })).max(50).default([]);
const userSelection = { uid: true, username: true, displayName: true, role: true, suspended: true, createdAt: true, lastLoginAt: true, totpEnabledAt: true } as const;
export async function accountsAdminRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.get('/admin/users', async (request) => {
    requireAdmin(request);
    return { users: await prisma.user.findMany({ select: userSelection, orderBy: { createdAt: 'asc' }, take: 500 }) };
  });
  app.patch('/admin/users/:uid', async (request) => {
    const actor = requireAdmin(request);
    const targetUid = z.object({ uid: z.string().max(64) }).parse(request.params).uid;
    const input = proofSchema.extend({ role: z.enum(['owner', 'admin', 'user']).optional(), suspended: z.boolean().optional(), displayName: z.string().trim().min(1).max(80).optional() }).strict().parse(request.body);
    const { password: _password, code: _code, ...body } = input;
    const user = await withAccountProof(request, input, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(193607, 2)`;
      const currentActor = await tx.user.findUniqueOrThrow({ where: { id: actor.id } });
      if (currentActor.suspended || currentActor.role === 'user') throw forbidden();
      const target = await tx.user.findUnique({ where: { uid: targetUid } });
      if (!target) throw notFound('Account');
      if (currentActor.role !== 'owner' && (target.role !== 'user' || (body.role && body.role !== 'user'))) throw forbidden('Only workspace owners can manage administrator and owner access.');
      if (target.role === 'owner' && (body.suspended === true || (body.role && body.role !== 'owner'))) {
        const owners = await tx.user.count({ where: { role: 'owner', suspended: false, id: { not: target.id } } });
        if (!owners) throw badRequest('The last active workspace owner cannot be suspended or demoted.');
      }
      const changed = await tx.user.update({ where: { id: target.id }, data: body, select: userSelection });
      if (body.suspended || body.role) {
        await tx.session.deleteMany({ where: { userId: target.id } });
        await tx.apiKey.updateMany({ where: { userId: target.id }, data: { revokedAt: new Date() } });
        if (body.suspended) await tx.invitation.updateMany({ where: { inviterId: target.id, acceptedAt: null }, data: { revokedAt: new Date() } });
      }
      await audit(tx, request, 'account.admin_updated', 'user', target.id, body);
      return changed;
    });
    closeConsoleStreams(); return { user };
  });
  app.get('/admin/invites', async (request) => {
    requireAdmin(request);
    const invitations = await prisma.invitation.findMany({ orderBy: { createdAt: 'desc' }, take: 100, select: { uid: true, role: true, grants: true, expiresAt: true, revokedAt: true, acceptedAt: true, createdAt: true } });
    return { invitations };
  });
  app.post('/admin/invites', async (request) => {
    const actor = requireAdmin(request);
    accountRateLimit(`invite:${actor.id}`, 10);
    const body = z.object({ role: z.enum(['user', 'admin']).default('user'), grants }).strict().parse(request.body);
    const token = randomToken();
    const invitation = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(193607, 2)`;
      const inviter = await tx.user.findUniqueOrThrow({ where: { id: actor.id } });
      if (inviter.suspended || inviter.role === 'user' || (body.role === 'admin' && inviter.role !== 'owner')) throw forbidden('Only owners can invite workspace administrators.');
      for (const grant of body.grants) if (!await tx.server.findUnique({ where: { uid: grant.serverUid } })) throw notFound('Server');
      if (new Set(body.grants.map((grant) => grant.serverUid)).size !== body.grants.length) throw badRequest('Select each server once.');
      const invitation = await tx.invitation.create({ data: { uid: uid(), tokenHash: sha256(token), inviterId: actor.id, role: body.role, grants: body.grants, expiresAt: new Date(Date.now() + 72 * 3600000) } });
      await audit(tx, request, 'invitation.created', 'invitation', invitation.id, { role: body.role, serverCount: body.grants.length });
      return invitation;
    });
    return { uid: invitation.uid, path: `/invite#${token}`, expiresAt: invitation.expiresAt };
  });
  app.delete('/admin/invites/:uid', async (request) => {
    const actor = requireAdmin(request);
    const { uid } = z.object({ uid: z.string().max(64) }).parse(request.params);
    const invitation = await prisma.invitation.findUnique({ where: { uid } });
    if (!invitation) throw notFound('Invitation');
    if (actor.role !== 'owner' && invitation.role !== 'user') throw forbidden();
    await prisma.$transaction(async (tx) => {
      await tx.invitation.updateMany({ where: { uid, acceptedAt: null }, data: { revokedAt: new Date() } });
      await audit(tx, request, 'invitation.revoked', 'invitation', invitation.id);
    });
    return { ok: true };
  });
  app.post('/auth/invites/accept', async (request, reply) => {
    accountRateLimit(`accept:${request.ip}`, 15);
    const body = registerSchema.extend({ token: z.string().min(32).max(128).regex(/^[a-zA-Z0-9_-]+$/) }).parse(request.body);
    const tokenHash = sha256(body.token);
    const passwordHash = await hashPassword(body.password);
    const user = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(193607, 2)`;
      const invitation = await tx.invitation.findUnique({ where: { tokenHash } });
      if (!invitation || invitation.revokedAt || invitation.acceptedAt || invitation.expiresAt <= new Date()) throw badRequest('This invitation expired, was revoked, or has already been used. Ask for a new link.');
      const inviter = await tx.user.findUnique({ where: { id: invitation.inviterId } });
      if (!inviter || inviter.suspended || inviter.role === 'user' || (invitation.role === 'admin' && inviter.role !== 'owner')) throw forbidden('The person who created this invitation can no longer grant this access.');
      if (await tx.user.findUnique({ where: { username: body.username } })) throw badRequest('That username is already taken.');
      const accepted = await tx.invitation.updateMany({ where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { acceptedAt: new Date() } });
      if (!accepted.count) throw badRequest('This invitation is no longer available.');
      const user = await tx.user.create({ data: { uid: uid(), username: body.username, displayName: body.displayName || body.username, passwordHash, role: invitation.role } });
      for (const grant of grants.parse(invitation.grants)) {
        const server = await tx.server.findUnique({ where: { uid: grant.serverUid } });
        if (!server) throw badRequest('A server in this invitation was removed. Ask for a new invitation.');
        await tx.serverUser.create({ data: { serverId: server.id, userId: user.id, permissions: grant.permissions } });
      }
      await tx.invitation.update({ where: { id: invitation.id }, data: { acceptedById: user.id } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'invitation.accepted', targetType: 'invitation', targetId: invitation.id, ip: request.ip } });
      return user;
    });
    await createSession(reply, user.id, request);
    return { user: { uid: user.uid, username: user.username, displayName: user.displayName, role: user.role } };
  });
}
