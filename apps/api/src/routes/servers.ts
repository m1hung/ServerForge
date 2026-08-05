import type { FastifyInstance } from 'fastify';
import {
  badRequest,
  cloneServerSchema,
  conflict,
  consoleCommandSchema,
  createServerSchema,
  defaultsFor,
  forbidden,
  groupSettings,
  powerActionSchema,
  settingsPatchSchema,
  startupPatchSchema,
  updateServerSchema,
  validateSettings,
  OWNER_PERMISSIONS,
  type ServerPermission,
} from '@serverforge/core';
import { buildCatalogue, getAdapter } from '@serverforge/adapters';
import { prisma, serializeBigInts } from '@serverforge/db';
import { apiKeyAllows, requireAuth, requireServerAccess } from '../lib/auth.js';
import { readConsoleBuffer, recordActivity } from '../lib/events.js';
import { installQueue } from '../queue/index.js';
import {
  cloneServer,
  createServer,
  deleteServer,
  restartServer,
  sendConsoleCommand,
  startServer,
  stopServer,
} from '../services/servers.js';
import { changePrimaryPort } from '../services/allocations.js';
import { playerCount } from '../services/monitor.js';
import { getRuntime } from '../runtime/index.js';

export async function serverRoutes(app: FastifyInstance): Promise<void> {
  // ── Catalogue: what the deploy wizard renders ─────────────────────────
  app.get('/api/games', async (request) => {
    await requireAuth(request);
    return { games: buildCatalogue() };
  });

  app.get('/api/games/:gameId/variants/:variantId/versions', async (request) => {
    await requireAuth(request);
    const { gameId, variantId } = request.params as { gameId: string; variantId: string };
    const adapter = getAdapter(gameId);
    // Upstream registries are flaky; a failure here should degrade the wizard
    // to "latest", not break it.
    try {
      return { versions: await adapter.listVersions(variantId) };
    } catch {
      return {
        versions: [{ id: 'latest', label: 'Latest', stable: true }],
        warning: 'We could not reach the version list just now. "Latest" will be resolved at install time.',
      };
    }
  });

  app.get('/api/games/:gameId/variants/:variantId/settings-schema', async (request) => {
    await requireAuth(request);
    const { gameId, variantId } = request.params as { gameId: string; variantId: string };
    const adapter = getAdapter(gameId);
    const schema = adapter.settingsSchema(variantId);
    return {
      schema,
      defaults: defaultsFor(schema),
      groups: groupSettings(schema).map((g) => g.group),
      defaultLimits: adapter.defaultLimits(variantId),
    };
  });

  // ── Fleet ─────────────────────────────────────────────────────────────
  app.get('/api/servers', async (request) => {
    const user = await requireAuth(request);
    if (!apiKeyAllows(user, 'server.view')) {
      throw forbidden('This API key is missing the "view" scope.');
    }
    const isAdmin = user.role === 'owner' || user.role === 'admin';

    const servers = await prisma.server.findMany({
      where: isAdmin
        ? {}
        : { OR: [{ ownerId: user.id }, { subusers: { some: { userId: user.id } } }] },
      include: { allocations: { where: { primary: true } }, node: true, owner: true },
      orderBy: { createdAt: 'desc' },
    });

    const withCounts = await Promise.all(
      servers.map(async (server) => ({
        uid: server.uid,
        name: server.name,
        description: server.description,
        state: server.state,
        gameId: server.gameId,
        variantId: server.variantId,
        version: server.version,
        memoryMib: server.memoryMib,
        cpuCores: server.cpuCores,
        diskMib: server.diskMib,
        installedAt: server.installedAt,
        createdAt: server.createdAt,
        owner: { uid: server.owner.uid, displayName: server.owner.displayName },
        node: { uid: server.node.uid, name: server.node.name, publicHost: server.node.publicHost },
        address: connectAddress(server.node.publicHost, server.allocations[0]?.port),
        players: await playerCount(server.uid),
        isOwner: server.ownerId === user.id,
      })),
    );

    return { servers: withCounts };
  });

  app.post('/api/servers', async (request, reply) => {
    const user = await requireAuth(request);
    if (!apiKeyAllows(user, 'server.settings')) {
      throw forbidden('This API key is missing the "settings" scope required to create servers.');
    }
    const input = createServerSchema.parse(request.body);

    const server = await createServer(input, { id: user.id, displayName: user.displayName });

    await installQueue().add('install', {
      serverUid: server.uid,
      mode: 'install',
      startAfter: input.startOnCreate,
      actorId: user.id,
    });

    return reply.code(202).send({
      server: { uid: server.uid, name: server.name, state: server.state },
      message: 'Your server is being set up. You can watch progress on its page.',
    });
  });

  // ── Single server ─────────────────────────────────────────────────────
  app.get('/api/servers/:uid', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server, user } = await requireServerAccess(request, uid, 'server.view');

    const adapter = getAdapter(server.gameId);
    const variant = adapter.variants.find((v) => v.id === server.variantId);

    return {
      server: {
        uid: server.uid,
        name: server.name,
        description: server.description,
        state: server.state,
        gameId: server.gameId,
        game: { id: adapter.id, name: adapter.name, icon: adapter.icon },
        variantId: server.variantId,
        variant: variant ? { id: variant.id, name: variant.name, supportsMods: variant.supportsMods } : null,
        version: server.version,
        build: server.build,
        limits: {
          memoryMib: server.memoryMib,
          cpuCores: server.cpuCores,
          diskMib: server.diskMib,
          swapMib: server.swapMib,
          ioWeight: server.ioWeight,
        },
        settings: server.settings,
        environment: server.environment,
        startupOverride: server.startupOverride,
        javaFlagsPreset: server.javaFlagsPreset,
        customJavaFlags: server.customJavaFlags,
        autoRestart: server.autoRestart,
        allocations: server.allocations.map((a) => ({
          id: a.id,
          ip: a.ip,
          port: a.port,
          purpose: a.purpose,
          primary: a.primary,
        })),
        address: connectAddress(server.node.publicHost, server.allocations.find((a) => a.primary)?.port),
        node: { uid: server.node.uid, name: server.node.name, publicHost: server.node.publicHost },
        installedAt: server.installedAt,
        lastStartAt: server.lastStartAt,
        crashCount: server.crashCount,
        createdAt: server.createdAt,
        isOwner: server.ownerId === user.id,
        modDirectory: adapter.modDirectory?.(server.variantId) ?? null,
        consoleGlossary: adapter.consoleGlossary?.(server.variantId) ?? null,
        /**
         * What this caller may actually do here. The UI hides what it cannot
         * use rather than rendering buttons that fail with a 403 on click.
         */
        permissions: effectivePermissions(user, server),
      },
    };
  });

  app.patch('/api/servers/:uid', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server, user } = await requireServerAccess(request, uid, 'server.settings');
    const input = updateServerSchema.parse(request.body);

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.limits) {
      Object.assign(data, input.limits);
      // Applying limits live avoids a restart for a memory bump, which is the
      // most common reason someone touches this page.
      if (server.containerId && server.state === 'running') {
        const runtime = getRuntime(server.node);
        await runtime
          .updateLimits(server.containerId, {
            memoryMib: input.limits.memoryMib ?? server.memoryMib,
            cpuCores: input.limits.cpuCores ?? server.cpuCores,
            diskMib: input.limits.diskMib ?? server.diskMib,
            ioWeight: input.limits.ioWeight ?? server.ioWeight,
          })
          .catch(() => undefined);
      }
    }

    const updated = await prisma.server.update({ where: { id: server.id }, data });
    await recordActivity({
      serverId: server.id,
      actorId: user.id,
      actorName: user.displayName,
      action: 'server.update',
      message: `${user.displayName} updated the server configuration.`,
    });

    return { server: { uid: updated.uid, name: updated.name, description: updated.description } };
  });

  app.delete('/api/servers/:uid', async (request) => {
    const { uid } = request.params as { uid: string };
    const { user } = await requireServerAccess(request, uid, 'server.delete');

    await deleteServer(uid, { id: user.id, displayName: user.displayName });
    return { ok: true, message: 'Server deleted.' };
  });

  // ── Power ─────────────────────────────────────────────────────────────
  app.post('/api/servers/:uid/power', async (request) => {
    const { uid } = request.params as { uid: string };
    const { user } = await requireServerAccess(request, uid, 'server.power');
    const { action } = powerActionSchema.parse(request.body);
    const actor = { id: user.id, displayName: user.displayName };

    switch (action) {
      case 'start':
        await startServer(uid, actor);
        break;
      case 'stop':
        await stopServer(uid, {}, actor);
        break;
      case 'restart':
        await restartServer(uid, actor);
        break;
      case 'kill':
        await stopServer(uid, { force: true }, actor);
        break;
    }

    return { ok: true, action };
  });

  app.post('/api/servers/:uid/command', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server, user } = await requireServerAccess(request, uid, 'server.console');
    const { command } = consoleCommandSchema.parse(request.body);

    await sendConsoleCommand(uid, command);
    await recordActivity({
      serverId: server.id,
      actorId: user.id,
      actorName: user.displayName,
      action: 'server.command',
      message: `${user.displayName} ran: ${command.slice(0, 120)}`,
    });

    return { ok: true };
  });

  app.get('/api/servers/:uid/console', async (request) => {
    const { uid } = request.params as { uid: string };
    await requireServerAccess(request, uid, 'server.console');
    const query = request.query as { limit?: string };
    return { lines: await readConsoleBuffer(uid, Math.min(Number(query.limit ?? 200), 500)) };
  });

  // ── Settings ──────────────────────────────────────────────────────────
  app.get('/api/servers/:uid/settings', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.view');

    const adapter = getAdapter(server.gameId);
    const schema = adapter.settingsSchema(server.variantId);
    const values = { ...defaultsFor(schema), ...(server.settings as Record<string, never>) };

    // Secrets are never echoed back; the UI shows a "set"/"not set" state and
    // writes a new value if the user chooses to change it.
    const redacted = { ...values } as Record<string, unknown>;
    for (const setting of schema) {
      if (setting.type === 'string' && setting.secret && redacted[setting.key]) {
        redacted[setting.key] = '';
      }
    }

    return { schema, values: redacted, groups: groupSettings(schema) };
  });

  app.patch('/api/servers/:uid/settings', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server, user } = await requireServerAccess(request, uid, 'server.settings');
    const { values } = settingsPatchSchema.parse(request.body);

    const adapter = getAdapter(server.gameId);
    const schema = adapter.settingsSchema(server.variantId);

    const merged = { ...defaultsFor(schema), ...(server.settings as Record<string, never>), ...values };
    const result = validateSettings(schema, merged);
    if (!result.ok) {
      throw badRequest('Some settings need fixing.', result.issues);
    }

    await prisma.server.update({
      where: { id: server.id },
      data: { settings: result.values as never },
    });

    const changedKeys = Object.keys(values);
    const needsRestart = schema.some(
      (s) => changedKeys.includes(s.key) && s.restartRequired,
    );

    await recordActivity({
      serverId: server.id,
      actorId: user.id,
      actorName: user.displayName,
      action: 'settings.update',
      message: `${user.displayName} changed ${changedKeys.length} setting${changedKeys.length === 1 ? '' : 's'}.`,
      metadata: { keys: changedKeys },
    });

    return {
      ok: true,
      needsRestart: needsRestart && ['running', 'starting'].includes(server.state),
      message:
        needsRestart && ['running', 'starting'].includes(server.state)
          ? 'Saved. Restart the server for these to take effect.'
          : 'Saved.',
    };
  });

  app.patch('/api/servers/:uid/startup', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server, user } = await requireServerAccess(request, uid, 'server.settings');
    const input = startupPatchSchema.parse(request.body);

    const data: Record<string, unknown> = {};
    if (input.startupOverride !== undefined) data.startupOverride = input.startupOverride;
    if (input.javaFlagsPreset !== undefined) data.javaFlagsPreset = input.javaFlagsPreset;
    if (input.customJavaFlags !== undefined) data.customJavaFlags = input.customJavaFlags;
    if (input.environment !== undefined) {
      // Container env is a privileged surface: refuse the variables that
      // would let a user redirect the runtime outside its own directory.
      const blocked = ['LD_PRELOAD', 'PATH', 'HOME'];
      for (const key of Object.keys(input.environment)) {
        if (blocked.includes(key.toUpperCase())) {
          throw badRequest(`The environment variable ${key} cannot be changed.`);
        }
      }
      data.environment = input.environment;
    }

    await prisma.server.update({ where: { id: server.id }, data });
    await recordActivity({
      serverId: server.id,
      actorId: user.id,
      actorName: user.displayName,
      action: 'startup.update',
      message: `${user.displayName} changed the startup configuration.`,
    });

    return { ok: true, needsRestart: true };
  });

  app.post('/api/servers/:uid/reinstall', async (request, reply) => {
    const { uid } = request.params as { uid: string };
    const { server, user } = await requireServerAccess(request, uid, 'server.settings');

    if (['installing', 'updating', 'restoring'].includes(server.state)) {
      throw conflict('This server is already busy with another job.');
    }
    if (['running', 'starting'].includes(server.state)) {
      throw conflict('Stop the server before reinstalling it.');
    }

    const body = request.body as { version?: string } | undefined;
    if (body?.version) {
      await prisma.server.update({ where: { id: server.id }, data: { version: body.version } });
    }

    await installQueue().add('install', {
      serverUid: uid,
      mode: 'reinstall',
      startAfter: false,
      actorId: user.id,
    });

    return reply.code(202).send({
      ok: true,
      message: 'Reinstalling. Your world and configuration files are kept.',
    });
  });

  /**
   * Downloads the latest game/server binaries without wiping the world.
   *
   * Steam games re-run `app_update`; Minecraft clears known jars/loaders then
   * reinstalls the chosen version. Optional `version` switches Minecraft
   * builds; Steam servers always track the public branch.
   */
  app.post('/api/servers/:uid/update', async (request, reply) => {
    const { uid } = request.params as { uid: string };
    const { server, user } = await requireServerAccess(request, uid, 'server.settings');

    if (['installing', 'updating', 'restoring', 'creating'].includes(server.state)) {
      throw conflict('This server is already busy with another job.');
    }
    if (['running', 'starting', 'stopping'].includes(server.state)) {
      throw conflict('Stop the server before updating it.');
    }

    const body = (request.body ?? {}) as { version?: string; startAfter?: boolean };
    if (body.version) {
      await prisma.server.update({ where: { id: server.id }, data: { version: body.version } });
    }

    await installQueue().add('install', {
      serverUid: uid,
      mode: 'update',
      startAfter: body.startAfter === true,
      actorId: user.id,
    });

    return reply.code(202).send({
      ok: true,
      message: 'Updating. Your world and configuration files are kept.',
    });
  });

  /** Duplicate settings + files onto a new server with fresh ports. */
  app.post('/api/servers/:uid/clone', async (request, reply) => {
    const { uid } = request.params as { uid: string };
    const { server, user } = await requireServerAccess(request, uid, 'server.settings');
    const input = cloneServerSchema.parse(request.body);

    const cloned = await cloneServer(uid, input, {
      id: user.id,
      displayName: user.displayName,
    });

    return reply.code(201).send({
      server: { uid: cloned.uid, name: cloned.name, state: cloned.state },
      message: `Cloned as "${cloned.name}". It is offline — start it when you are ready.`,
    });
  });

  app.get('/api/servers/:uid/install-log', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.view');
    const entries = await prisma.installLog.findMany({
      where: { serverId: server.id },
      orderBy: { at: 'desc' },
      take: 200,
    });
    return { entries: serializeBigInts(entries).reverse() };
  });

  // ── Network ───────────────────────────────────────────────────────────
  app.patch('/api/servers/:uid/port', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.settings');
    const body = request.body as { port?: number };

    if (typeof body.port !== 'number') throw badRequest('Choose a port number.');
    if (['running', 'starting'].includes(server.state)) {
      throw conflict('Stop the server before changing its port.');
    }

    await changePrimaryPort(server.id, body.port);
    return { ok: true, needsRestart: false };
  });

  // ── Timeline and metrics ──────────────────────────────────────────────
  app.get('/api/servers/:uid/activity', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.view');
    const entries = await prisma.activity.findMany({
      where: { serverId: server.id },
      orderBy: { at: 'desc' },
      take: 50,
    });
    return { entries };
  });

  app.get('/api/servers/:uid/metrics', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.view');
    const query = request.query as { hours?: string };
    const hours = Math.min(Math.max(Number(query.hours ?? 6), 1), 168);

    const samples = await prisma.metricSample.findMany({
      where: { serverId: server.id, at: { gte: new Date(Date.now() - hours * 3600 * 1000) } },
      orderBy: { at: 'asc' },
      take: 2000,
    });

    return { samples: serializeBigInts(samples) };
  });

  // ── Sub-users ─────────────────────────────────────────────────────────
  app.get('/api/servers/:uid/subusers', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.subusers');
    const subusers = await prisma.serverUser.findMany({
      where: { serverId: server.id },
      include: {
        user: { select: { uid: true, username: true, displayName: true, avatarColor: true } },
      },
    });
    return { subusers };
  });

  app.post('/api/servers/:uid/subusers', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.subusers');
    const body = request.body as { username?: string; permissions?: ServerPermission[] };
    const handle = body.username?.trim().toLowerCase();

    if (!handle || !body.permissions?.length) {
      throw badRequest('Choose a person and at least one permission.');
    }

    const target = await prisma.user.findUnique({ where: { username: handle } });
    if (!target) {
      throw badRequest(
        'Nobody with that username has an account here yet.',
        'They need an account first — then you can add them.',
      );
    }
    if (target.id === server.ownerId) throw conflict('That person already owns this server.');

    const membership = await prisma.serverUser.upsert({
      where: { serverId_userId: { serverId: server.id, userId: target.id } },
      create: { serverId: server.id, userId: target.id, permissions: body.permissions },
      update: { permissions: body.permissions },
    });

    return { subuser: membership };
  });

  app.delete('/api/servers/:uid/subusers/:userUid', async (request) => {
    const { uid, userUid } = request.params as { uid: string; userUid: string };
    const { server } = await requireServerAccess(request, uid, 'server.subusers');

    const target = await prisma.user.findUnique({ where: { uid: userUid } });
    if (!target) throw badRequest('That person could not be found.');

    await prisma.serverUser.deleteMany({ where: { serverId: server.id, userId: target.id } });
    return { ok: true };
  });
}

/** Builds the copy-paste join address shown on the server card. */
function connectAddress(host: string, port?: number): string | null {
  if (!port) return null;
  return `${host}:${port}`;
}

/**
 * The caller's effective permissions on a server.
 *
 * Mirrors `requireServerAccess`: the server's owner and panel administrators
 * hold every permission; everyone else holds exactly what their sub-user
 * record grants. Keeping this in one place means the UI cannot disagree with
 * what the API will enforce.
 */
function effectivePermissions(
  user: { id: string; role: string },
  server: { ownerId: string; subusers: { permissions: string[] }[] },
): ServerPermission[] {
  const isOwner = server.ownerId === user.id;
  const isAdmin = user.role === 'owner' || user.role === 'admin';
  if (isOwner || isAdmin) return [...OWNER_PERMISSIONS];

  return (server.subusers[0]?.permissions ?? []) as ServerPermission[];
}
