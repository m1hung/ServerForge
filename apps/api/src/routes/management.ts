import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { openServerFile } from '../lib/server-files.js';
import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma, uid, serializeBigInts } from '@serverforge/db';
import {
  badRequest,
  conflict,
  notFound,
  effectiveServerPermissions,
  subuserSchema,
  filePathQuerySchema,
  renameFileSchema,
  isSafeFileName,
  type ServerPermission,
} from '@serverforge/core';
import { getAdapter } from '@serverforge/adapters';
import { requireUser } from '../plugins/auth.js';
import { loadServer, accessInput, sendServerCommand, runtime } from './servers.js';
import { beginServerOperation, isServerBusy, withServerLock } from '../services/server-lock.js';
import { localDataPath } from '../lib/storage-paths.js';
import { prepareServerOwnership } from '../lib/server-files.js';
import {
  listFiles,
  readTextFile,
  writeTextFile,
  uploadFile,
  managedFile,
  unpackFile,
  FILE_LIMIT,
  TEXT_LIMIT,
} from '../services/file-manager.js';
import { createBackup, restoreBackup, backupFile } from '../services/backups.js';
import { prepareUpdate, readUpdate, applyUpdate } from '../services/updates.js';
import {
  validateSchedule,
  nextRun,
  actionPermissions,
  runSchedule,
} from '../services/schedules.js';
import { observations, acceptTickOutput } from '../services/telemetry.js';
import { activity } from '../services/server-events.js';
import { logger } from '../lib/logger.js';
import { closeConsoleStreams } from '../services/console-stream.js';

function serverUid(request: FastifyRequest) {
  return z.object({ uid: z.string().min(1).max(64) }).parse(request.params).uid;
}
function background(
  server: { uid: string; id: string },
  action: string,
  work: () => Promise<unknown>,
) {
  const promise = beginServerOperation(server.uid, work);
  void promise.catch(async (error) => {
    const message = error instanceof Error ? error.message : 'Operation failed.';
    logger.warn('server operation failed', { uid: server.uid, action, message });
    await activity(server.id, `${action}.failed`, message).catch(() => undefined);
  });
}
async function permissions(request: FastifyRequest, required: ServerPermission[]) {
  const user = requireUser(request),
    id = serverUid(request);
  const server = await loadServer(id, user, required[0]);
  for (const permission of required.slice(1)) await loadServer(id, user, permission);
  return server;
}
async function stopped(request: FastifyRequest) {
  // Recheck inside the operation lock: a start can finish after the route's
  // initial permission lookup. Never write files beside a running game.
  const server = await permissions(request, ['server.files']);
  if (!['offline', 'crashed'].includes(server.state) ||
      (server.containerId && (await runtime.status(server.containerId)).running))
    throw conflict('Stop the server before changing its files.');
}

export async function managementRoutes(app: FastifyInstance) {
  app.get('/servers/:uid/management', async (request) => {
    const server = await permissions(request, ['server.view']);
    return {
      busy: isServerBusy(server.uid),
      autoRestart: server.autoRestart,
      crashCount: server.crashCount,
    };
  });
  app.get('/servers/:uid/files', async (request) => {
    const server = await permissions(request, ['server.files']);
    return listFiles(localDataPath(server.dataPath), filePathQuerySchema.parse(request.query).path);
  });
  app.get('/servers/:uid/files/content', async (request, reply) => {
    const server = await permissions(request, ['server.files']);
    reply.header('Cache-Control', 'no-store');
    return readTextFile(
      localDataPath(server.dataPath),
      filePathQuerySchema.parse(request.query).path,
    );
  });
  app.get('/servers/:uid/files/download', async (request, reply) => {
    const server = await permissions(request, ['server.files']);
    const target = await managedFile(
      localDataPath(server.dataPath),
      filePathQuerySchema.parse(request.query).path,
    );
    const file = await openServerFile(localDataPath(server.dataPath), filePathQuerySchema.parse(request.query).path);
    return reply
      .type('application/octet-stream')
      .header('Cache-Control', 'no-store')
      .header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`,
      )
      .send(file.createReadStream());
  });
  app.put('/servers/:uid/files/content', { bodyLimit: TEXT_LIMIT + 65536 }, async (request) => {
    const server = await permissions(request, ['server.files']);
    const body = z
      .object({
        path: z.string().min(1).max(4096),
        content: z.string().max(TEXT_LIMIT),
        revision: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(request.body);
    return withServerLock(server.uid, async () => {
      await stopped(request);
      const result = await writeTextFile(
        localDataPath(server.dataPath),
        body.path,
        body.content,
        body.revision,
      );
      await prepareServerOwnership(localDataPath(server.dataPath));
      await activity(server.id, 'file.saved', `Saved ${body.path}`, requireUser(request).id);
      return result;
    });
  });
  app.post('/servers/:uid/files/upload', async (request) => {
    const server = await permissions(request, ['server.files']);
    const directory = filePathQuerySchema.parse(request.query).path;
    return withServerLock(server.uid, async () => {
      await stopped(request);
      const file = await request.file({ limits: { fileSize: FILE_LIMIT, files: 1, fields: 0 } });
      if (!file || !isSafeFileName(file.filename))
        throw badRequest('Choose a file with a valid name.');
      try {
        await uploadFile(
          localDataPath(server.dataPath),
          `${directory}/${file.filename}`,
          file.file,
        );
        await prepareServerOwnership(localDataPath(server.dataPath));
      } finally {
        file.file.resume();
      }
      await activity(
        server.id,
        'file.uploaded',
        `Uploaded ${file.filename}`,
        requireUser(request).id,
      );
      return { ok: true };
    });
  });
  app.post('/servers/:uid/files/folder', async (request) => {
    const server = await permissions(request, ['server.files']);
    const body = z.object({ path: z.string().min(1).max(4096) }).parse(request.body);
    return withServerLock(server.uid, async () => {
      await stopped(request);
      await fs.mkdir(await managedFile(localDataPath(server.dataPath), body.path));
      await prepareServerOwnership(localDataPath(server.dataPath));
      return { ok: true };
    });
  });
  app.post('/servers/:uid/files/rename', async (request) => {
    const server = await permissions(request, ['server.files']),
      body = renameFileSchema.parse(request.body),
      root = localDataPath(server.dataPath);
    return withServerLock(server.uid, async () => {
      await stopped(request);
      const from = await managedFile(root, body.from),
        to = await managedFile(root, body.to);
      if (from === root || to === root) throw badRequest('The server root cannot be renamed.');
      if (await fs.lstat(to).catch(() => null)) throw conflict('The destination already exists.');
      await fs.rename(from, to);
      await activity(
        server.id,
        'file.renamed',
        `${body.from} → ${body.to}`,
        requireUser(request).id,
      );
      return { ok: true };
    });
  });
  app.post('/servers/:uid/files/extract', async (request) => {
    const server = await permissions(request, ['server.files']),
      body = z
        .object({ path: z.string().min(1).max(4096), destination: z.string().min(1).max(4096) })
        .parse(request.body);
    return withServerLock(server.uid, async () => {
      await stopped(request);
      await unpackFile(localDataPath(server.dataPath), body.path, body.destination);
      await prepareServerOwnership(localDataPath(server.dataPath));
      await activity(
        server.id,
        'file.extracted',
        `Extracted ${body.path} into ${body.destination}`,
        requireUser(request).id,
      );
      return { ok: true };
    });
  });
  app.get('/servers/:uid/backups', async (request) => {
    const server = await permissions(request, ['server.backups']);
    const backups = await prisma.backup.findMany({
      where: { serverId: server.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      busy: isServerBusy(server.uid),
      lastOperation: await prisma.activity.findFirst({
        where: { serverId: server.id, action: { in: ['backup.completed', 'backup.restored', 'backup.failed', 'restore.failed'] } },
        orderBy: { at: 'desc' },
        select: { action: true, message: true, at: true },
      }),
      backups: serializeBigInts(
        backups.map(({ configuration: _configuration, filePath: _path, ...backup }) => backup),
      ),
    };
  });
  app.post('/servers/:uid/backups', async (request, reply) => {
    const server = await permissions(request, ['server.backups', 'server.power']);
    const { name } = z.object({ name: z.string().trim().max(64).optional() }).parse(request.body);
    if (!['running', 'offline', 'crashed'].includes(server.state))
      throw conflict('Wait for the current operation.');
    background(server, 'backup', () => createBackup(server, name));
    return reply.code(202).send({ ok: true });
  });
  async function selectedBackup(request: FastifyRequest) {
    const server = await permissions(request, ['server.backups']);
    const backupUid = z.object({ backup: z.string().max(64) }).parse(request.params).backup;
    const backup = await prisma.backup.findFirst({
      where: { uid: backupUid, serverId: server.id },
    });
    if (!backup) throw notFound('That backup');
    return { server, backup };
  }
  app.get('/servers/:uid/backups/:backup/download', async (request, reply) => {
    const { backup } = await selectedBackup(request);
    if (backup.state !== 'completed') throw conflict('This backup is not ready.');
    return reply
      .type('application/gzip')
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="${backup.uid}.tar.gz"`)
      .send(createReadStream(await backupFile(backup)));
  });
  app.post('/servers/:uid/backups/:backup/restore', async (request, reply) => {
    await permissions(request, ['server.power', 'server.files', 'server.settings']);
    const { server, backup } = await selectedBackup(request);
    if (!['running', 'offline', 'crashed'].includes(server.state))
      throw conflict('Wait for the current operation.');
    background(server, 'restore', () => restoreBackup(server, backup));
    return reply.code(202).send({ ok: true });
  });
  app.delete('/servers/:uid/backups/:backup', async (request) => {
    const { server, backup } = await selectedBackup(request);
    return withServerLock(server.uid, async () => {
      if (['pending', 'running'].includes(backup.state))
        throw conflict('Wait for this backup to finish.');
      if (backup.filePath) await fs.rm(await backupFile(backup), { force: true });
      await prisma.backup.delete({ where: { id: backup.id } });
      return { ok: true };
    });
  });
  app.get('/servers/:uid/updates', async (request) => {
    const server = await permissions(request, ['server.settings', 'server.mods']);
    const plan = await readUpdate(server.uid);
    if (!plan) return { plan: null, busy: isServerBusy(server.uid) };
    const { configuration: _private, ...visible } = plan;
    return { plan: visible, busy: isServerBusy(server.uid) };
  });
  app.post('/servers/:uid/updates/prepare', async (request, reply) => {
    const server = await permissions(request, ['server.settings', 'server.mods']);
    if (!['minecraft-java', 'minecraft-bedrock', 'valheim', 'palworld'].includes(server.gameId))
      throw badRequest('Staged updates are supported for Minecraft, Valheim, and Palworld.');
    if (request.isMultipart()) {
      return withServerLock(server.uid, async () => {
        const file = await request.file({ limits: { fileSize: FILE_LIMIT, files: 1, fields: 0 } });
        if (!file) throw badRequest('Choose the new server pack ZIP.');
        try {
          await prepareUpdate(server, server.version, file);
        } finally {
          file.file.resume();
        }
        return { ok: true };
      });
    }
    const body = z
      .object({ version: z.string().min(1).max(64), packVersion: z.string().max(128).optional() })
      .parse(request.body);
    if (server.variantId === 'custom-modpack')
      throw badRequest('Upload a server pack ZIP for this edition.');
    background(server, 'update.prepare', () =>
      prepareUpdate(server, body.version, undefined, body.packVersion),
    );
    return reply.code(202).send({ ok: true });
  });
  app.post('/servers/:uid/updates/apply', async (request, reply) => {
    const server = await permissions(request, [
      'server.settings',
      'server.mods',
      'server.backups',
      'server.power',
    ]);
    const body = z.object({ startAfter: z.boolean().default(false) }).parse(request.body);
    if ((await readUpdate(server.uid))?.state !== 'ready')
      throw conflict('Prepare an update first.');
    background(server, 'update', () => applyUpdate(server, body.startAfter));
    return reply.code(202).send({ ok: true });
  });
  app.get('/servers/:uid/diagnostics', async (request, reply) => {
    const server = await permissions(request, ['server.view']);
    const { hours } = z
      .object({ hours: z.coerce.number().int().min(1).max(168).default(1) })
      .parse(request.query);
    const samples = await prisma.metricSample.findMany({
      where: { serverId: server.id, at: { gte: new Date(Date.now() - hours * 3600000) } },
      orderBy: { at: 'asc' },
      take: 20160,
    });
    const stride = Math.max(1, Math.ceil(samples.length / 300));
    const history = samples.filter((_s, i) => i % stride === 0 || i === samples.length - 1);
    const timeline = await prisma.activity.findMany({
      where: { serverId: server.id },
      orderBy: { at: 'desc' },
      take: 40,
    });
    reply.header('Cache-Control', 'no-store');
    return serializeBigInts({
      autoRestart: server.autoRestart,
      crashCount: server.crashCount,
      observations: observations(server),
      history,
      timeline: timeline.map(({ metadata: _metadata, ...entry }) => entry),
    });
  });
  app.patch('/servers/:uid/recovery', async (request) => {
    const server = await permissions(request, ['server.settings']);
    const { autoRestart } = z.object({ autoRestart: z.boolean() }).parse(request.body);
    return withServerLock(server.uid, async () => {
      await prisma.server.update({ where: { id: server.id }, data: { autoRestart } });
      await activity(
        server.id,
        'recovery.changed',
        autoRestart ? 'Automatic crash recovery enabled.' : 'Automatic crash recovery disabled.',
        requireUser(request).id,
      );
      return { ok: true };
    });
  });
  app.post('/servers/:uid/diagnostics/ticks', async (request) => {
    const server = await permissions(request, ['server.console']);
    if (server.gameId !== 'minecraft-java')
      throw badRequest('Tick diagnostics are available for Minecraft Java with Spark installed.');
    const output = await sendServerCommand(server, 'spark tps');
    acceptTickOutput(server.uid, output);
    return {
      output,
      note: 'Spark reports tick metrics through the console. If Spark is unavailable, install its matching plugin or mod first.',
    };
  });
  app.get('/servers/:uid/players', async (request) => {
    const server = await permissions(request, ['server.view']);
    return {
      ...observations(server),
      commands:
        getAdapter(server.gameId)
          .consoleGlossary?.(server.variantId)
          ?.commands.filter((c) =>
            /player|kick|ban|whitelist|allowlist|operator/i.test(`${c.command} ${c.summary}`),
          ) ?? [],
    };
  });
  app.post('/servers/:uid/players/action', async (request) => {
    const server = await permissions(request, ['server.console']);
    const body = z
      .object({
        player: server.gameId === 'minecraft-bedrock'
          ? z.string().trim().regex(/^[\p{L}\p{N}_ -]{1,32}$/u, 'Enter a gamertag using letters, numbers, spaces, underscores or hyphens.')
          : z.string().regex(/^[a-zA-Z0-9_]{1,16}$/),
        action: z.enum([
          'whitelist-add',
          'whitelist-remove',
          'kick',
          'ban',
          'pardon',
          'op',
          'deop',
        ]),
      })
      .parse(request.body);
    if (!['minecraft-java', 'minecraft-bedrock'].includes(server.gameId))
      throw badRequest('Use this game’s supported admin commands in the console.');
    const bedrock = server.gameId === 'minecraft-bedrock';
    if (bedrock && ['ban', 'pardon'].includes(body.action))
      throw badRequest('Bedrock uses an allowlist instead of Java ban commands. Enable Invite-only game and remove the player from the allowlist.');
    const prefix = {
      'whitelist-add': bedrock ? 'allowlist add' : 'whitelist add',
      'whitelist-remove': bedrock ? 'allowlist remove' : 'whitelist remove',
      kick: 'kick',
      ban: 'ban',
      pardon: 'pardon',
      op: 'op',
      deop: 'deop',
    }[body.action];
    const output = await sendServerCommand(server, `${prefix} ${bedrock ? `"${body.player}"` : body.player}`);
    await activity(
      server.id,
      'player.action',
      `${body.action}: ${body.player}`,
      requireUser(request).id,
    );
    return { output };
  });
  app.get('/servers/:uid/schedules', async (request) => {
    const server = await permissions(request, ['server.schedules']);
    return {
      schedules: await prisma.schedule.findMany({
        where: { serverId: server.id },
        orderBy: { createdAt: 'desc' },
      }),
    };
  });
  app.post('/servers/:uid/schedules', async (request) => {
    const server = await permissions(request, ['server.schedules']),
      body = validateSchedule(request.body);
    await permissions(request, actionPermissions(body.actions));
    return {
      schedule: await prisma.schedule.create({
        data: {
          ...body,
          cron: body.cron ?? null,
          triggerType: body.triggerType ?? null,
          uid: uid(),
          creatorId: requireUser(request).id,
          serverId: server.id,
          nextRunAt: body.cron ? nextRun(body.cron, body.timezone) : null,
        },
      }),
    };
  });
  async function selectedSchedule(request: FastifyRequest) {
    const server = await permissions(request, ['server.schedules']);
    const id = z.object({ schedule: z.string().max(64) }).parse(request.params).schedule;
    const schedule = await prisma.schedule.findFirst({ where: { uid: id, serverId: server.id } });
    if (!schedule) throw notFound('That schedule');
    return { server, schedule };
  }
  app.put('/servers/:uid/schedules/:schedule', async (request) => {
    const { server, schedule } = await selectedSchedule(request),
      body = validateSchedule(request.body);
    await permissions(request, actionPermissions(body.actions));
    return withServerLock(server.uid, async () => ({
      schedule: await prisma.schedule.update({
        where: { id: schedule.id },
        data: {
          ...body,
          cron: body.cron ?? null,
          triggerType: body.triggerType ?? null,
          creatorId: requireUser(request).id,
          nextRunAt: body.cron ? nextRun(body.cron, body.timezone) : null,
        },
      }),
    }));
  });
  app.delete('/servers/:uid/schedules/:schedule', async (request) => {
    const { server, schedule } = await selectedSchedule(request);
    return withServerLock(server.uid, async () => {
      await prisma.schedule.delete({ where: { id: schedule.id } });
      return { ok: true };
    });
  });
  app.post('/servers/:uid/schedules/:schedule/run', async (request, reply) => {
    const { server, schedule } = await selectedSchedule(request);
    await permissions(request, actionPermissions(validateSchedule(schedule).actions));
    background(server, 'schedule', async () => {
      await prisma.schedule.update({
        where: { id: schedule.id },
        data: { lastRunAt: new Date(), lastRunOk: null, lastRunError: null },
      });
      await runSchedule(schedule, server);
    });
    return reply.code(202).send({ ok: true });
  });
  app.get('/servers/:uid/access', async (request) => {
    const server = await permissions(request, ['server.subusers']);
    const members = await prisma.serverUser.findMany({
      where: { serverId: server.id },
      include: { user: { select: { uid: true, username: true, displayName: true } } },
    });
    return {
      members: members.map((m) => ({
        username: m.user.username,
        displayName: m.user.displayName,
        permissions: m.permissions,
      })),
      available: effectiveServerPermissions(accessInput(requireUser(request), server)).filter(
        (p) =>
          !requireUser(request).scopes ||
          requireUser(request).scopes!.includes('*') ||
          requireUser(request).scopes!.includes(p),
      ),
    };
  });
  app.put('/servers/:uid/access', async (request) => {
    const server = await permissions(request, ['server.subusers']),
      body = subuserSchema.parse(request.body);
    await permissions(request, ['server.view', ...body.permissions]);
    const member = await prisma.user.findUnique({ where: { username: body.username } });
    if (!member || member.suspended)
      throw badRequest('That person needs an active panel account first.');
    if (
      member.id === server.ownerId ||
      ['owner', 'admin'].includes(member.role) ||
      member.id === requireUser(request).id
    )
      throw badRequest(
        'Panel administrators, the server owner, and your own access cannot be changed here.',
      );
    const grants = [...new Set(['server.view', ...body.permissions])];
    await prisma.serverUser.upsert({
      where: { serverId_userId: { serverId: server.id, userId: member.id } },
      create: { serverId: server.id, userId: member.id, permissions: grants },
      // This editor sets the complete grant; do not leave hidden inherited roles behind.
      update: { permissions: grants, roles: { set: [] } },
    });
    await activity(
      server.id,
      'access.changed',
      `Updated server access for ${member.username}.`,
      requireUser(request).id,
    );
    closeConsoleStreams();
    return { ok: true };
  });
  app.delete('/servers/:uid/access/:username', async (request) => {
    const server = await permissions(request, ['server.subusers']);
    const username = z.object({ username: z.string().max(32) }).parse(request.params).username;
    const member = await prisma.user.findUnique({ where: { username } });
    if (!member || member.id === server.ownerId || member.id === requireUser(request).id)
      throw badRequest('That membership cannot be removed here.');
    await prisma.serverUser.deleteMany({ where: { serverId: server.id, userId: member.id } });
    await activity(
      server.id,
      'access.removed',
      `Removed server access for ${username}.`,
      requireUser(request).id,
    );
    closeConsoleStreams();
    return { ok: true };
  });
}
