import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  listMods,
  modSupport,
  MOD_UPLOAD_LIMIT,
  requireStopped,
  setModEnabled,
  uploadMod,
} from '../services/mods.js';
import { emitServerEvent } from '../services/server-events.js';
import { withServerLock, isServerBusy } from '../services/server-lock.js';
import { streamConsole } from '../services/console-stream.js';
import { saveServerPack, SERVER_PACK_UPLOAD_LIMIT } from '../services/server-pack-upload.js';
import { prepareServerOwnership } from '../lib/server-files.js';
import type { FastifyInstance } from 'fastify';
import {
  createServerSchema,
  powerActionSchema,
  consoleCommandSchema,
  settingsPatchSchema,
  updateServerSchema,
  canAccessServer,
  validateSettings,
  defaultsFor,
  notFound,
  badRequest,
  conflict,
  brand,
  type SettingValues,
  type UpdateServerInput,
  type ServerPermission,
  effectiveServerPermissions,
} from '@serverforge/core';
import { getAdapter, type ServerContext } from '@serverforge/adapters';
import { prisma, uid, serializeBigInts, type ServerWithAccess } from '@serverforge/db';
import { requireUser, type AuthUser } from '../plugins/auth.js';
import { config, runningInContainer } from '../lib/config.js';
import { hostDataPath, localDataPath } from '../lib/storage-paths.js';
import { mapPorts } from '../services/ports.js';
import { installToolsFor } from '../services/install-tools.js';
import { DockerRuntime } from '../runtime/docker.js';
import { logger } from '../lib/logger.js';
import { rconCommand } from '../lib/rcon.js';
import { resolveRconTarget } from '../lib/rcon-target.js';

export const runtime = new DockerRuntime();

export function accessInput(user: AuthUser, server: ServerWithAccess) {
  const membership = server.subusers.find((row) => row.userId === user.id);
  return {
    panelRole: user.role,
    isServerOwner: server.ownerId === user.id,
    directGrants: membership?.permissions ?? [],
    roles: (membership?.roles ?? []).map((role) => ({
      name: role.name,
      permissions: role.permissions as Record<string, 'allow' | 'deny'>,
    })),
  };
}

export async function loadServer(
  uidValue: string,
  user: AuthUser,
  permission: ServerPermission = 'server.view',
): Promise<ServerWithAccess> {
  const server = await prisma.server.findUnique({
    where: { uid: uidValue },
    include: { allocations: true, node: true, owner: true, subusers: { include: { roles: true } } },
  });
  if (!server) throw notFound('That server');
  if (user.scopes && !user.scopes.includes('*') && !user.scopes.includes(permission))
    throw notFound('That server');
  if (!canAccessServer(accessInput(user, server), permission)) throw notFound('That server');
  return server;
}

export function containerName(serverUid: string) {
  return `${brand.resourcePrefix}-${serverUid}`;
}

export function contextOf(server: Awaited<ReturnType<typeof loadServer>>): ServerContext {
  return {
    serverUid: server.uid,
    name: server.name,
    dataPath: server.dataPath,
    version: server.version,
    build: server.build,
    runtimeMajor: server.javaMajor,
    variantId: server.variantId,
    settings: (server.settings ?? {}) as Record<string, string | number | boolean>,
    memoryMib: server.memoryMib,
    cpuCores: server.cpuCores,
    allocations: server.allocations,
    environment: (server.environment ?? {}) as Record<string, string>,
    javaFlagsPreset: server.javaFlagsPreset,
    customJavaFlags: server.customJavaFlags,
  };
}

function publicServer(server: Record<string, unknown>) {
  const {
    settings: _settings,
    environment: _environment,
    owner: _owner,
    subusers: _subusers,
    ...visible
  } = server;
  return serializeBigInts(visible);
}

async function updateConfiguration(serverUid: string, user: AuthUser, body: UpdateServerInput) {
  return withServerLock(serverUid, async () => {
    const server = await loadServer(serverUid, user, 'server.settings');
    if (!['running', 'offline', 'crashed', 'install_failed'].includes(server.state))
      throw conflict(
        'Wait for the current server operation to finish before saving configuration.',
      );
    let settings: SettingValues | undefined;
    if (body.settings !== undefined) {
      const schema = getAdapter(server.gameId).settingsSchema(server.variantId);
      const current = (server.settings ?? {}) as SettingValues;
      for (const field of schema) {
        if (
          field.installOnly &&
          body.settings[field.key] !== undefined &&
          body.settings[field.key] !== current[field.key]
        )
          throw badRequest(
            `${field.label} is chosen during installation. Deploy a new server to change it.`,
          );
      }
      const known: SettingValues = {};
      for (const field of schema) {
        const value = current[field.key];
        if (value !== undefined) known[field.key] = value;
      }
      const checked = validateSettings(schema, { ...known, ...body.settings });
      if (!checked.ok)
        throw badRequest(
          checked.issues
            .map(
              (issue) =>
                `${schema.find((field) => field.key === issue.key)?.label ?? issue.key}: ${issue.message}`,
            )
            .join(' '),
          checked.issues,
        );
      // Keep hidden values (including saved passwords) when their parent switch is off.
      settings = { ...known, ...body.settings, ...checked.values };
    }
    const updated = await prisma.server.update({
      where: { id: server.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.limits?.memoryMib !== undefined ? { memoryMib: body.limits.memoryMib } : {}),
        ...(body.limits?.cpuCores !== undefined ? { cpuCores: body.limits.cpuCores } : {}),
        ...(body.limits?.diskMib !== undefined ? { diskMib: body.limits.diskMib } : {}),
        ...(body.limits?.swapMib !== undefined ? { swapMib: body.limits.swapMib } : {}),
        ...(body.limits?.ioWeight !== undefined ? { ioWeight: body.limits.ioWeight ?? 500 } : {}),
        ...(settings !== undefined ? { settings } : {}),
      },
      include: { allocations: true, node: true },
    });
    return { server: publicServer(updated), restartRequired: server.state === 'running' };
  });
}

async function allocatePorts(nodeId: string, serverId: string, purposes: { purpose: string }[]) {
  for (const [index, entry] of purposes.entries()) {
    const row = await prisma.allocation.findFirst({
      where: { nodeId, serverId: null },
      orderBy: { port: 'asc' },
    });
    if (!row) throw conflict('This machine has no free ports left.');
    const claimed = await prisma.allocation.updateMany({
      where: { id: row.id, serverId: null },
      data: { serverId, purpose: entry.purpose, primary: index === 0 },
    });
    if (claimed.count !== 1) throw conflict('This machine has no free ports left.');
  }
}

export async function serverRoutes(app: FastifyInstance) {
  app.get('/servers', async (request) => {
    const user = requireUser(request);
    const servers = await prisma.server.findMany({
      where:
        user.role === 'user'
          ? { OR: [{ ownerId: user.id }, { subusers: { some: { userId: user.id } } }] }
          : {},
      include: { allocations: true, node: true },
      orderBy: { createdAt: 'desc' },
    });
    return { servers: servers.map(publicServer) };
  });

  app.post('/servers', async (request, reply) => {
    const user = requireUser(request);
    const parts = request.isMultipart?.()
      ? request.parts({
          limits: {
            files: 1,
            fields: 1,
            parts: 2,
            fieldSize: 128 * 1024,
            fileSize: SERVER_PACK_UPLOAD_LIMIT,
          },
        })
      : null;
    let input = request.body;
    if (parts) {
      const first = await parts.next();
      if (
        first.done ||
        first.value.type !== 'field' ||
        first.value.fieldname !== 'configuration' ||
        first.value.valueTruncated
      )
        throw badRequest('Send the server configuration before the ZIP file.');
      try {
        input = JSON.parse(String(first.value.value));
      } catch {
        throw badRequest('The server configuration is not valid JSON.');
      }
    }
    const body = createServerSchema.parse(input);
    if (parts && (body.gameId !== 'minecraft-java' || body.variantId !== 'custom-modpack'))
      throw badRequest('ZIP uploads require Minecraft’s Modpack from a .zip edition.');
    const adapter = getAdapter(body.gameId);
    const variant = adapter.variants.find((item) => item.id === body.variantId);
    if (!variant) throw badRequest('That game option does not exist.');
    const eula = adapter.eula?.(body.variantId);
    if (eula && body.acceptedEula !== eula.key)
      throw badRequest('Accept the game EULA before creating a server.');
    if (
      body.variantId === 'custom-modpack' &&
      !parts &&
      !String(body.settings.modpack_zip_url ?? '').trim()
    ) {
      throw badRequest('Upload a server pack ZIP or enter a public HTTPS download URL.');
    }
    if (parts) body.settings.modpack_zip_url = '';
    const schema = adapter.settingsSchema(body.variantId);
    const settings = { ...defaultsFor(schema), ...body.settings };
    const checked = validateSettings(schema, settings);
    if (!checked.ok) throw badRequest('Some settings are not valid.', checked.issues);

    const node = body.nodeId
      ? await prisma.node.findUnique({ where: { id: body.nodeId } })
      : await prisma.node.findFirst({ where: { transport: 'docker' } });
    if (!node) throw badRequest('No machine is available to run this server.');

    const dataPath = path.join(config.dataRoot, uid());
    await fs.mkdir(localDataPath(dataPath), { recursive: true });
    let createdServer = false;
    try {
      if (parts) {
        const next = await parts.next();
        if (next.done || next.value.type !== 'file')
          throw badRequest('Choose a server pack ZIP to upload.');
        await saveServerPack(localDataPath(dataPath), next.value);
        if (!(await parts.next()).done) throw badRequest('Upload one ZIP file at a time.');
      }
      const purposes = adapter.requiredPorts(body.variantId);
      const server = await prisma.server.create({
        data: {
          uid: path.basename(dataPath),
          name: body.name,
          description: body.description,
          ownerId: user.id,
          nodeId: node.id,
          gameId: body.gameId,
          variantId: body.variantId,
          version: body.version,
          settings: checked.values,
          memoryMib: body.limits.memoryMib,
          cpuCores: body.limits.cpuCores,
          diskMib: body.limits.diskMib,
          swapMib: body.limits.swapMib ?? null,
          ioWeight: body.limits.ioWeight ?? 500,
          dataPath: hostDataPath(dataPath),
          state: 'installing',
        },
      });
      createdServer = true;
      await allocatePorts(node.id, server.id, purposes);
      const created = await prisma.server.findUniqueOrThrow({
        where: { id: server.id },
        include: { allocations: true, node: true },
      });

      void installServer(created.id).catch((error) =>
        logger.error('install failed', { message: String(error) }),
      );
      return reply.status(202).send({ server: publicServer(created) });
    } finally {
      if (!createdServer) await fs.rm(localDataPath(dataPath), { recursive: true, force: true });
    }
  });

  app.get('/servers/:uid', async (request) => {
    const user = requireUser(request);
    const { uid: serverUid } = request.params as { uid: string };
    const server = await loadServer(serverUid, user);
    const glossary = getAdapter(server.gameId).consoleGlossary?.(server.variantId);
    return {
      server: publicServer({
        ...server,
        busy: isServerBusy(server.uid),
        permissions: effectiveServerPermissions(accessInput(user, server)).filter(
          (permission) =>
            !user.scopes || user.scopes.includes('*') || user.scopes.includes(permission),
        ),
        canConfigure: canAccessServer(accessInput(user, server), 'server.settings'),
        console: {
          canRead: canAccessServer(accessInput(user, server), 'server.console'),
          acceptsCommands: glossary?.acceptsCommands ?? true,
          note: glossary?.note,
        },
      }),
    };
  });

  app.get('/servers/:uid/settings', async (request, reply) => {
    const user = requireUser(request);
    const { uid: serverUid } = request.params as { uid: string };
    const server = await loadServer(serverUid, user, 'server.settings');
    const schema = getAdapter(server.gameId)
      .settingsSchema(server.variantId)
      .filter((field) => !field.installOnly);
    const current = { ...defaultsFor(schema), ...(server.settings as SettingValues) };
    const values: SettingValues = {};
    const configuredSecrets: string[] = [];
    for (const field of schema) {
      if (field.type === 'string' && field.secret) {
        if (current[field.key]) configuredSecrets.push(field.key);
      } else values[field.key] = current[field.key]!;
    }
    reply.header('Cache-Control', 'no-store');
    return { schema, values, configuredSecrets, server: publicServer(server) };
  });

  app.get('/servers/:uid/resources', async (request, reply) => {
    const user = requireUser(request);
    const { uid: serverUid } = request.params as { uid: string };
    const server = await loadServer(serverUid, user);
    reply.header('Cache-Control', 'no-store');
    return {
      containerId: server.containerId,
      usage: server.containerId ? await runtime.stats(server.containerId) : null,
    };
  });

  app.get('/servers/:uid/console/stream', async (request, reply) => {
    const user = requireUser(request);
    const { uid: serverUid } = request.params as { uid: string };
    const server = await loadServer(serverUid, user, 'server.console');
    streamConsole(reply, server, runtime);
  });

  app.patch('/servers/:uid', async (request) => {
    const user = requireUser(request);
    const { uid: serverUid } = request.params as { uid: string };
    const body = updateServerSchema.parse(request.body);
    return updateConfiguration(serverUid, user, body);
  });

  app.post('/servers/:uid/power', async (request) => {
    const user = requireUser(request);
    const { uid: serverUid } = request.params as { uid: string };
    return withServerLock(serverUid, async () => {
      const server = await loadServer(serverUid, user, 'server.power');
      const { action } = powerActionSchema.parse(request.body);
      if (action === 'start') await startServer(server.id);
      else if (action === 'stop') await stopServer(server.id);
      else if (action === 'restart') {
        await stopServer(server.id);
        await startServer(server.id);
      } else {
        if (!['running', 'starting'].includes(server.state))
          throw conflict('The server is not running.');
        await runtime.kill(server.containerId ?? containerName(server.uid));
        await prisma.server.update({ where: { id: server.id }, data: { state: 'offline' } });
      }
      const updated = await prisma.server.findUniqueOrThrow({ where: { id: server.id } });
      return { server: publicServer(updated) };
    });
  });

  app.post('/servers/:uid/console', async (request) => {
    const user = requireUser(request);
    const { uid: serverUid } = request.params as { uid: string };
    const server = await loadServer(serverUid, user, 'server.console');
    const { command } = consoleCommandSchema.parse(request.body);
    return { output: await sendServerCommand(server, command) };
  });

  app.patch('/servers/:uid/settings', async (request) => {
    const user = requireUser(request);
    const { uid: serverUid } = request.params as { uid: string };
    const { values } = settingsPatchSchema.parse(request.body);
    const result = await updateConfiguration(serverUid, user, { settings: values });
    return { ok: true, restartRequired: result.restartRequired };
  });

  app.get('/servers/:uid/mods', async (request) => {
    const user = requireUser(request);
    const { uid: serverUid } = request.params as { uid: string };
    const server = await loadServer(serverUid, user);
    const support = modSupport(server.gameId, server.variantId);
    const canManage = canAccessServer(accessInput(user, server), 'server.mods');
    const files =
      support.directory && canManage
        ? await listMods(localDataPath(server.dataPath), support.directory, support.extensions)
        : [];
    return { ...support, canManage, files };
  });

  app.post('/servers/:uid/mods', async (request, reply) => {
    const user = requireUser(request);
    const { uid: serverUid } = request.params as { uid: string };
    return withServerLock(serverUid, async () => {
      const server = await loadServer(serverUid, user, 'server.mods');
      requireStopped(server.state);
      const support = modSupport(server.gameId, server.variantId);
      if (!support.directory) throw badRequest('This edition does not support mods.');
      const file = await request.file({
        limits: { fileSize: MOD_UPLOAD_LIMIT, files: 1, fields: 0 },
      });
      if (!file) throw badRequest('Choose a mod file to upload.');
      try {
        await uploadMod(
          localDataPath(server.dataPath),
          support.directory,
          support.extensions,
          file.filename,
          file.file,
        );
      } finally {
        file.file.resume();
      }
      return reply.status(201).send({ ok: true });
    });
  });

  app.patch('/servers/:uid/mods', async (request) => {
    const user = requireUser(request);
    const { uid: serverUid } = request.params as { uid: string };
    const { name, enabled } = z
      .object({ name: z.string().min(1).max(1024), enabled: z.boolean() })
      .parse(request.body);
    return withServerLock(serverUid, async () => {
      const server = await loadServer(serverUid, user, 'server.mods');
      requireStopped(server.state);
      const support = modSupport(server.gameId, server.variantId);
      if (!support.directory) throw badRequest('This edition does not support mods.');
      await setModEnabled(
        localDataPath(server.dataPath),
        support.directory,
        support.extensions,
        name,
        enabled,
      );
      return { ok: true };
    });
  });
}

async function installServer(id: string) {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id },
    include: { allocations: true, node: true, owner: true, subusers: { include: { roles: true } } },
  });
  const adapter = getAdapter(server.gameId);
  try {
    const resolved = await adapter.resolveVersion(server.variantId, server.version);
    const javaMajor = (await adapter.detectRuntime?.(server.variantId, resolved.id)) ?? null;
    await prisma.server.update({
      where: { id },
      data: { version: resolved.id, build: resolved.build ?? null, javaMajor },
    });
    const tools = installToolsFor(server.dataPath);
    await adapter.install(
      contextOf({ ...server, version: resolved.id, build: resolved.build ?? null, javaMajor }),
      tools,
      {
        async phase(phase, message) {
          await prisma.installLog.create({ data: { serverId: id, phase, message } });
        },
        async runtime(detected) {
          await prisma.server.update({
            where: { id },
            data: {
              ...(detected.javaMajor ? { javaMajor: detected.javaMajor } : {}),
              ...(detected.version ? { version: detected.version } : {}),
            },
          });
        },
        async log(message) {
          await prisma.installLog.create({ data: { serverId: id, phase: 'log', message } });
        },
      },
    );
    await adapter.applySettings(contextOf({ ...server, version: resolved.id }), tools);
    await prepareServerOwnership(localDataPath(server.dataPath));
    await prisma.server.update({
      where: { id },
      data: { state: 'offline', installedAt: new Date() },
    });
  } catch (error) {
    await prisma.server.update({
      where: { id },
      data: { state: 'install_failed' },
    });
    await prisma.installLog.create({
      data: {
        serverId: id,
        phase: 'failed',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export async function startServer(id: string, automatic = false) {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id },
    include: { allocations: true, node: true, owner: true, subusers: { include: { roles: true } } },
  });
  requireStopped(server.state);
  const adapter = getAdapter(server.gameId);
  if (server.gameId === 'valheim' && server.variantId === 'valheim-bepinex') {
    const files = installToolsFor(server.dataPath);
    if (
      !(await files.exists('BepInEx/core/BepInEx.Preloader.dll')) ||
      !(await files.exists('doorstop_libs/libdoorstop_x64.so'))
    ) {
      throw badRequest(
        'BepInEx is missing from this older server. Install BepInExPack Valheim in the server folder, or deploy a new BepInEx edition.',
      );
    }
  }
  const plan = adapter.startup(contextOf(server));
  await runtime.ensureImage(plan.image, () => undefined);
  const name = containerName(server.uid);
  const existing = await runtime.status(name);
  if (existing.exists) await runtime.remove(name, { force: true });
  // Settings saved in the panel are materialised only after the old process stops.
  await adapter.applySettings(contextOf(server), installToolsFor(server.dataPath));
  await prepareServerOwnership(localDataPath(server.dataPath));
  const containerId = await runtime.create({
    name,
    image: plan.image,
    command: server.startupOverride ? server.startupOverride.split(/\s+/) : plan.command,
    entrypoint: plan.entrypoint,
    workingDir: plan.workingDir,
    env: { ...plan.env, ...(server.environment as Record<string, string>) },
    dataPath: server.dataPath,
    limits: {
      memoryMib: server.memoryMib,
      cpuCores: server.cpuCores,
      diskMib: server.diskMib,
      swapMib: server.swapMib,
      ioWeight: server.ioWeight,
    },
    ports: mapPorts(plan.ports, server.allocations),
    network: config.dockerNetwork,
    labels: {
      [`${brand.labelNamespace}/managed`]: 'true',
      [`${brand.labelNamespace}/server`]: server.uid,
    },
  });
  await runtime.start(containerId);
  const started = await prisma.server.update({
    where: { id },
    data: {
      containerId,
      state: 'running',
      lastStartAt: new Date(),
      ...(automatic ? {} : { crashCount: 0 }),
    },
  });
  const { observeServer } = await import('../services/telemetry.js');
  await observeServer(started, true).catch(() => undefined);
}

export async function stopServer(id: string) {
  const server = await prisma.server.findUniqueOrThrow({ where: { id } });
  if (!['running', 'starting', 'offline', 'crashed'].includes(server.state))
    throw conflict('Wait for the current operation before stopping.');
  const adapter = getAdapter(server.gameId);
  const plan = adapter.startup({
    serverUid: server.uid,
    name: server.name,
    dataPath: server.dataPath,
    version: server.version,
    variantId: server.variantId,
    settings: server.settings as Record<string, string | number | boolean>,
    memoryMib: server.memoryMib,
    cpuCores: server.cpuCores,
    allocations: [],
    environment: {},
    javaFlagsPreset: server.javaFlagsPreset,
  });
  if (server.containerId) {
    await runtime.stop(server.containerId, {
      stopCommand: plan.stopCommand,
      timeoutSeconds: plan.stopTimeoutSeconds,
    });
  }
  await prisma.server.update({ where: { id }, data: { state: 'offline' } });
  emitServerEvent({ serverUid: server.uid, type: 'server.stopped', at: Date.now() });
}

export async function sendServerCommand(
  server: Awaited<ReturnType<typeof loadServer>>,
  command: string,
): Promise<string> {
  const adapter = getAdapter(server.gameId);
  const glossary = adapter.consoleGlossary?.(server.variantId);
  if (glossary?.acceptsCommands === false)
    throw badRequest(glossary.note ?? 'This game provides a read-only console.');
  if (server.state !== 'running' || !server.containerId)
    throw conflict('Start the server before sending a command.');
  const plan = adapter.startup(contextOf(server));
  const target = resolveRconTarget({
    plan,
    containerName: containerName(server.uid),
    allocations: server.allocations,
    settings: server.settings as Record<string, unknown>,
    inContainer: runningInContainer(),
  });
  if (target) {
    const password = String(
      (server.settings as Record<string, unknown>)[plan.console!.passwordSetting] ?? '',
    );
    const output = await rconCommand({ ...target, password }, command);
    return output;
  }
  if (server.containerId) await runtime.writeStdin(server.containerId, `${command}\n`);
  return '';
}
