import type { FastifyInstance } from 'fastify';
import { apiKeySchema, badRequest, conflict, inviteUserSchema } from '@serverforge/core';
import { prisma, serializeBigInts, uid as makeUid } from '@serverforge/db';
import { issueApiKey, requireAuth, requireRole } from '../lib/auth.js';
import { hashPassword } from '../lib/crypto.js';
import { recordAudit } from '../lib/events.js';
import { countFreePorts } from '../services/allocations.js';
import { getRuntime } from '../runtime/index.js';
import { config } from '../config.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ── API keys (any user, for their own automation) ─────────────────────
  app.get('/api/keys', async (request) => {
    const user = await requireAuth(request);
    const keys = await prisma.apiKey.findMany({
      where: { userId: user.id, revokedAt: null },
      select: { uid: true, name: true, prefix: true, scopes: true, lastUsedAt: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return { keys };
  });

  app.post('/api/keys', async (request, reply) => {
    const user = await requireAuth(request);
    const input = apiKeySchema.parse(request.body);

    const { token, prefix } = await issueApiKey(user.id, {
      name: input.name,
      scopes: input.scopes,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    });

    await recordAudit({
      actorId: user.id,
      action: 'apikey.create',
      targetType: 'user',
      targetId: user.uid,
      ip: request.ip,
    });

    return reply.code(201).send({
      // The only time the plaintext is ever available.
      token,
      prefix,
      message: 'Copy this key now — it will not be shown again.',
    });
  });

  app.delete('/api/keys/:keyUid', async (request) => {
    const user = await requireAuth(request);
    const { keyUid } = request.params as { keyUid: string };

    const key = await prisma.apiKey.findUnique({ where: { uid: keyUid } });
    if (!key || key.userId !== user.id) throw badRequest('That key does not exist.');

    await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    return { ok: true };
  });

  // ── Users ─────────────────────────────────────────────────────────────
  app.get('/api/admin/users', async (request) => {
    await requireRole(request, ['owner', 'admin']);
    const users = await prisma.user.findMany({
      select: {
        uid: true,
        username: true,
        displayName: true,
        role: true,
        suspended: true,
        createdAt: true,
        lastLoginAt: true,
        _count: { select: { ownedServers: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return { users };
  });

  app.post('/api/admin/users', async (request, reply) => {
    const actor = await requireRole(request, ['owner', 'admin']);
    const input = inviteUserSchema.parse(request.body);
    const body = request.body as { password?: string; displayName?: string };

    if (!body.password || body.password.length < 10) {
      throw badRequest('Set a starting password of at least 10 characters for the new account.');
    }

    const existing = await prisma.user.findUnique({ where: { username: input.username } });
    if (existing) throw conflict('Someone already has an account with that username.');

    // Only the owner can mint another owner-level account.
    if (input.role !== 'user' && actor.role !== 'owner') {
      throw conflict('Only the panel owner can create administrator accounts.');
    }

    const user = await prisma.user.create({
      data: {
        uid: makeUid(),
        username: input.username,
        displayName: body.displayName?.trim() || input.username,
        passwordHash: await hashPassword(body.password),
        role: input.role,
      },
      select: { uid: true, username: true, displayName: true, role: true },
    });

    await recordAudit({
      actorId: actor.id,
      action: 'user.create',
      targetType: 'user',
      targetId: user.uid,
      metadata: { role: user.role },
      ip: request.ip,
    });

    return reply.code(201).send({ user });
  });

  app.patch('/api/admin/users/:userUid', async (request) => {
    const actor = await requireRole(request, ['owner', 'admin']);
    const { userUid } = request.params as { userUid: string };
    const body = request.body as { role?: 'owner' | 'admin' | 'user'; suspended?: boolean };

    const target = await prisma.user.findUnique({ where: { uid: userUid } });
    if (!target) throw badRequest('That account does not exist.');

    // Guard rails that prevent a panel from becoming unadministrable.
    if (target.id === actor.id && body.suspended) throw conflict('You cannot suspend your own account.');
    if (body.role && actor.role !== 'owner') throw conflict('Only the panel owner can change roles.');
    if (target.role === 'owner' && body.role && body.role !== 'owner') {
      const owners = await prisma.user.count({ where: { role: 'owner' } });
      if (owners <= 1) throw conflict('There must always be at least one owner.');
    }

    const updated = await prisma.user.update({
      where: { id: target.id },
      data: {
        ...(body.role ? { role: body.role } : {}),
        ...(body.suspended !== undefined ? { suspended: body.suspended } : {}),
      },
      select: { uid: true, username: true, role: true, suspended: true },
    });

    // Suspension must be immediate, not "when their session expires".
    if (body.suspended) await prisma.session.deleteMany({ where: { userId: target.id } });

    await recordAudit({
      actorId: actor.id,
      action: 'user.update',
      targetType: 'user',
      targetId: target.uid,
      metadata: { ...body },
      ip: request.ip,
    });

    return { user: updated };
  });

  // ── Nodes ─────────────────────────────────────────────────────────────
  app.get('/api/admin/nodes', async (request) => {
    await requireRole(request, ['owner', 'admin']);
    const nodes = await prisma.node.findMany({ orderBy: { createdAt: 'asc' } });

    const enriched = await Promise.all(
      nodes.map(async (node) => {
        const runtime = getRuntime(node);
        const [online, freePorts, allocated, serverCount] = await Promise.all([
          runtime.ping().catch(() => false),
          countFreePorts(node.id),
          prisma.server.aggregate({
            where: { nodeId: node.id },
            _sum: { memoryMib: true, diskMib: true },
          }),
          prisma.server.count({ where: { nodeId: node.id } }),
        ]);

        return {
          uid: node.uid,
          name: node.name,
          transport: node.transport,
          publicHost: node.publicHost,
          online,
          maintenance: node.maintenance,
          portRange: `${node.portRangeStart}–${node.portRangeEnd}`,
          freePorts,
          servers: serverCount,
          capacity: {
            memoryMib: node.memoryMib,
            allocatedMemoryMib: allocated._sum.memoryMib ?? 0,
            diskMib: node.diskMib,
            allocatedDiskMib: allocated._sum.diskMib ?? 0,
            overheadPct: node.overheadPct,
          },
        };
      }),
    );

    return { nodes: enriched };
  });

  app.patch('/api/admin/nodes/:nodeUid', async (request) => {
    const actor = await requireRole(request, ['owner', 'admin']);
    const { nodeUid } = request.params as { nodeUid: string };
    const body = request.body as {
      name?: string;
      publicHost?: string;
      memoryMib?: number;
      diskMib?: number;
      cpuCores?: number;
      overheadPct?: number;
      maintenance?: boolean;
    };

    const node = await prisma.node.update({
      where: { uid: nodeUid },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.publicHost ? { publicHost: body.publicHost } : {}),
        ...(body.memoryMib !== undefined ? { memoryMib: body.memoryMib } : {}),
        ...(body.diskMib !== undefined ? { diskMib: body.diskMib } : {}),
        ...(body.cpuCores !== undefined ? { cpuCores: body.cpuCores } : {}),
        ...(body.overheadPct !== undefined ? { overheadPct: body.overheadPct } : {}),
        ...(body.maintenance !== undefined ? { maintenance: body.maintenance } : {}),
      },
    });

    await recordAudit({
      actorId: actor.id,
      action: 'node.update',
      targetType: 'node',
      targetId: node.uid,
      ip: request.ip,
    });

    return { node: { uid: node.uid, name: node.name } };
  });

  // ── Panel settings ────────────────────────────────────────────────────
  app.get('/api/admin/settings', async (request) => {
    await requireRole(request, ['owner', 'admin']);
    const settings = await prisma.setting.findMany({ where: { encrypted: false } });
    const map = Object.fromEntries(settings.map((s) => [s.key, s.value]));

    return {
      settings: map,
      integrations: {
        // Whether a key exists, never the key itself.
        curseforge: Boolean(config.CURSEFORGE_API_KEY),
      },
    };
  });

  app.put('/api/admin/settings/:key', async (request) => {
    const actor = await requireRole(request, ['owner', 'admin']);
    const { key } = request.params as { key: string };
    const body = request.body as { value?: unknown };

    const allowed = ['registration.mode', 'defaults.limits', 'panel.title'];
    if (!allowed.includes(key)) throw badRequest('That setting cannot be changed here.');

    await prisma.setting.upsert({
      where: { key },
      create: { key, value: body.value as never },
      update: { value: body.value as never },
    });

    await recordAudit({
      actorId: actor.id,
      action: 'settings.update',
      targetType: 'system',
      targetId: key,
      ip: request.ip,
    });

    return { ok: true };
  });

  app.get('/api/admin/audit', async (request) => {
    await requireRole(request, ['owner', 'admin']);
    const query = request.query as { limit?: string };

    const entries = await prisma.auditLog.findMany({
      orderBy: { at: 'desc' },
      take: Math.min(Number(query.limit ?? 100), 500),
      include: { actor: { select: { displayName: true, username: true } } },
    });

    return { entries: serializeBigInts(entries) };
  });
}
