import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  conflict,
  createBackupSchema,
  scheduleSchema,
  scheduleTimingIsValid,
  scheduleUpdateSchema,
} from '@serverforge/core';
import { prisma, serializeBigInts, uid as makeUid } from '@serverforge/db';
import { requireServerAccess } from '../lib/auth.js';
import { backupQueue, restoreQueue } from '../queue/index.js';
import { backupFilePath, createBackupRecord, deleteBackup } from '../services/backups.js';
import { nextRun } from '../queue/workers.js';
import { checkWebhookUrl } from '../lib/ssrf.js';

/** Triggers that fire only when the server is not running. */
const OFFLINE_TRIGGERS = new Set(['server.crashed', 'server.stopped']);

/**
 * Rejects a webhook address that could never be allowed.
 *
 * Only the checks that need no network happen here, so saving a schedule never
 * waits on DNS and never fails because a resolver blipped. Whether the host
 * currently points somewhere private is decided at send time, where the answer
 * is still true — see `lib/ssrf.ts`.
 */
function checkActions(actions: { type: string; url?: string }[] | undefined): void {
  for (const action of actions ?? []) {
    if (action.type === 'webhook' && action.url) checkWebhookUrl(action.url);
  }
}

/**
 * Validates when a schedule runs, and works out its next run.
 *
 * The last check is the one worth having: "back up when the server crashes"
 * combined with "only while the server is online" is a schedule that can never
 * fire, and silently never firing is the worst way for that to be discovered.
 */
function checkTiming(input: {
  cron: string | null | undefined;
  triggerType: string | null | undefined;
  timezone: string;
  onlyWhenOnline: boolean;
}): { nextRunAt: Date | null } {
  if (!scheduleTimingIsValid(input)) {
    throw conflict(
      'A schedule needs either a repeating time or an event, and not both.',
      'Pick a time under "When", or choose something the server does to react to.',
    );
  }

  if (input.triggerType) {
    if (input.onlyWhenOnline && OFFLINE_TRIGGERS.has(input.triggerType)) {
      throw conflict(
        'That combination can never run.',
        `"${input.triggerType}" only happens when the server is not running, so "only while the server is online" would block it every time. Turn that toggle off.`,
      );
    }
    return { nextRunAt: null };
  }

  const next = nextRun(input.cron, input.timezone);
  if (!next) {
    throw conflict(
      'That schedule is not a valid repeating time.',
      'Use the presets, or a five-field cron expression like "0 4 * * *" for 4am daily.',
    );
  }
  return { nextRunAt: next };
}

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:uid/backups', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.backups');

    const backups = await prisma.backup.findMany({
      where: { serverId: server.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return { backups: serializeBigInts(backups) };
  });

  app.post('/api/servers/:uid/backups', async (request, reply) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.backups');
    const input = createBackupSchema.parse(request.body);

    const backup = await createBackupRecord(server.id, {
      ...(input.name ? { name: input.name } : {}),
    });
    await backupQueue().add('backup', {
      serverUid: uid,
      backupUid: backup.uid,
      ignore: input.ignore,
    });

    return reply.code(202).send({
      backup: { uid: backup.uid, name: backup.name, state: backup.state },
      message: 'Backup started. It runs in the background — you can keep playing.',
    });
  });

  app.get('/api/servers/:uid/backups/:backupUid/download', async (request, reply) => {
    const { uid, backupUid } = request.params as { uid: string; backupUid: string };
    const { server } = await requireServerAccess(request, uid, 'server.backups');

    const backup = await prisma.backup.findUnique({ where: { uid: backupUid } });
    if (!backup || backup.serverId !== server.id) throw conflict('That backup is not on this server.');
    if (backup.state !== 'completed') throw conflict('That backup has not finished yet.');

    const absolutePath = await backupFilePath(backupUid);
    const safeName = `${server.name.replace(/[^\w.-]+/g, '-')}-${backup.uid}.tar.gz`;

    reply
      .header('Content-Disposition', `attachment; filename="${safeName}"`)
      .header('Content-Type', 'application/gzip')
      .header('Content-Length', String(backup.sizeBytes))
      .header('X-Content-Type-Options', 'nosniff');

    return reply.send(createReadStream(absolutePath));
  });

  app.post('/api/servers/:uid/backups/:backupUid/restore', async (request, reply) => {
    const { uid, backupUid } = request.params as { uid: string; backupUid: string };
    const { server } = await requireServerAccess(request, uid, 'server.backups');

    const backup = await prisma.backup.findUnique({ where: { uid: backupUid } });
    if (!backup || backup.serverId !== server.id) throw conflict('That backup is not on this server.');

    await restoreQueue().add('restore', { serverUid: uid, backupUid });
    return reply.code(202).send({
      ok: true,
      message: 'Restoring. The server will stop, restore the files, then stay offline until you start it.',
    });
  });

  app.delete('/api/servers/:uid/backups/:backupUid', async (request) => {
    const { uid, backupUid } = request.params as { uid: string; backupUid: string };
    const { server } = await requireServerAccess(request, uid, 'server.backups');

    const backup = await prisma.backup.findUnique({ where: { uid: backupUid } });
    if (!backup || backup.serverId !== server.id) throw conflict('That backup is not on this server.');

    await deleteBackup(backupUid);
    return { ok: true };
  });

  // ── Schedules ─────────────────────────────────────────────────────────
  app.get('/api/servers/:uid/schedules', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.schedules');
    const schedules = await prisma.schedule.findMany({
      where: { serverId: server.id },
      orderBy: { createdAt: 'asc' },
    });
    return { schedules };
  });

  app.post('/api/servers/:uid/schedules', async (request, reply) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.schedules');
    const input = scheduleSchema.parse(request.body);

    const timing = checkTiming({
      cron: input.cron,
      triggerType: input.triggerType,
      timezone: input.timezone,
      onlyWhenOnline: input.onlyWhenOnline,
    });
    checkActions(input.actions);

    const schedule = await prisma.schedule.create({
      data: {
        uid: makeUid(),
        serverId: server.id,
        name: input.name,
        cron: input.cron ?? null,
        triggerType: input.triggerType ?? null,
        cooldownSeconds: input.cooldownSeconds,
        timezone: input.timezone,
        enabled: input.enabled,
        onlyWhenOnline: input.onlyWhenOnline,
        actions: input.actions as never,
        nextRunAt: timing.nextRunAt,
      },
    });

    return reply.code(201).send({ schedule });
  });

  app.patch('/api/servers/:uid/schedules/:scheduleUid', async (request) => {
    const { uid, scheduleUid } = request.params as { uid: string; scheduleUid: string };
    const { server } = await requireServerAccess(request, uid, 'server.schedules');
    const input = scheduleUpdateSchema.parse(request.body);

    const existing = await prisma.schedule.findUnique({ where: { uid: scheduleUid } });
    if (!existing || existing.serverId !== server.id) {
      throw conflict('That schedule is not on this server.');
    }

    // Switching a schedule between timed and triggered means clearing the other
    // field, so an explicit null in the patch has to survive the merge — hence
    // `!== undefined` rather than `??` on cron and triggerType.
    const cron = input.cron !== undefined ? (input.cron ?? null) : existing.cron;
    const triggerType =
      input.triggerType !== undefined ? (input.triggerType ?? null) : existing.triggerType;
    const timezone = input.timezone ?? existing.timezone;
    const onlyWhenOnline = input.onlyWhenOnline ?? existing.onlyWhenOnline;

    const timing = checkTiming({ cron, triggerType, timezone, onlyWhenOnline });
    checkActions(input.actions);

    const schedule = await prisma.schedule.update({
      where: { id: existing.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        cron,
        triggerType,
        ...(input.cooldownSeconds !== undefined
          ? { cooldownSeconds: input.cooldownSeconds }
          : {}),
        timezone,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.onlyWhenOnline !== undefined ? { onlyWhenOnline: input.onlyWhenOnline } : {}),
        ...(input.actions !== undefined ? { actions: input.actions as never } : {}),
        nextRunAt: timing.nextRunAt,
      },
    });

    return { schedule };
  });

  app.delete('/api/servers/:uid/schedules/:scheduleUid', async (request) => {
    const { uid, scheduleUid } = request.params as { uid: string; scheduleUid: string };
    const { server } = await requireServerAccess(request, uid, 'server.schedules');

    const existing = await prisma.schedule.findUnique({ where: { uid: scheduleUid } });
    if (!existing || existing.serverId !== server.id) {
      throw conflict('That schedule is not on this server.');
    }

    await prisma.schedule.delete({ where: { id: existing.id } });
    return { ok: true };
  });
}
