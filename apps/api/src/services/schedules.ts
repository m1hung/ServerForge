import { CronExpressionParser } from 'cron-parser';
import { prisma, type Schedule } from '@serverforge/db';
import {
  scheduleSchema,
  scheduleTimingIsValid,
  badRequest,
  type ScheduleInput,
  type ServerEvent,
  type ServerPermission,
} from '@serverforge/core';
import { createBackup, backupFile } from './backups.js';
import { applyUpdate } from './updates.js';
import { startServer, stopServer, sendServerCommand, loadServer } from '../routes/servers.js';
import { deliverWebhook } from './webhooks.js';
import { checkWebhookUrl } from '../lib/ssrf.js';
import { activity } from './server-events.js';
import fs from 'node:fs/promises';

export function nextRun(cron: string, timezone: string, now = new Date()): Date {
  if (cron.trim().split(/\s+/).length !== 5) throw badRequest('Use a five-field cron expression.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return CronExpressionParser.parse(cron, { tz: timezone, currentDate: now }).next().toDate();
  } catch {
    throw badRequest(
      'Enter a valid cron expression and IANA timezone, such as America/Los_Angeles.',
    );
  }
}
export function validateSchedule(input: unknown) {
  const body = scheduleSchema.parse(input);
  if (!scheduleTimingIsValid(body))
    throw badRequest('Choose either a clock schedule or one server event.');
  if (body.cron) nextRun(body.cron, body.timezone);
  for (const action of body.actions) if (action.type === 'webhook') checkWebhookUrl(action.url);
  return body;
}
export function actionPermissions(actions: ScheduleInput['actions']): ServerPermission[] {
  return [
    ...new Set<ServerPermission>(
      actions.flatMap((a) =>
        a.type === 'backup'
          ? ['server.backups', 'server.power']
          : a.type === 'update'
            ? ['server.settings', 'server.mods', 'server.backups', 'server.power']
            : a.type === 'command'
              ? ['server.console']
              : a.type === 'power'
                ? ['server.power']
                : ['server.schedules'],
      ),
    ),
  ];
}
export async function runSchedule(
  schedule: Schedule,
  server: Awaited<ReturnType<typeof loadServer>>,
  event?: ServerEvent,
) {
  const input = validateSchedule(schedule);
  const active = server.state === 'running';
  if (schedule.onlyWhenOnline && !active) {
    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { lastRunOk: true, lastRunError: 'Skipped because the server is offline.' },
    });
    return;
  }
  try {
    for (const action of input.actions) {
      const current = await prisma.server.findUniqueOrThrow({
        where: { id: server.id },
        include: {
          allocations: true,
          node: true,
          owner: true,
          subusers: { include: { roles: true } },
        },
      });
      if (action.type === 'power') {
        if (action.action === 'start') await startServer(server.id);
        if (action.action === 'stop') await stopServer(server.id);
        if (action.action === 'restart') {
          if (
            current.state === 'running' &&
            action.warningSeconds &&
            ['minecraft-java', 'minecraft-bedrock', 'palworld'].includes(current.gameId)
          ) {
            await sendServerCommand(
              current,
              ['minecraft-java', 'minecraft-bedrock'].includes(current.gameId)
                ? `say Server restarting in ${action.warningSeconds} seconds.`
                : current.gameId === 'palworld'
                  ? `Broadcast Server_restart_in_${action.warningSeconds}_seconds`
                  : '',
            );
            await new Promise((resolve) => setTimeout(resolve, action.warningSeconds * 1000));
          }
          await stopServer(server.id);
          await startServer(server.id);
        }
      } else if (action.type === 'command') await sendServerCommand(current, action.command);
      else if (action.type === 'backup') {
        await createBackup(current, schedule.name, schedule.id);
        const old = await prisma.backup.findMany({
          where: { serverId: server.id, scheduleId: schedule.id, state: 'completed' },
          orderBy: { createdAt: 'desc' },
          skip: action.retain,
        });
        for (const backup of old) {
          await fs.rm(await backupFile(backup), { force: true });
          await prisma.backup.delete({ where: { id: backup.id } });
        }
      } else if (action.type === 'update') await applyUpdate(current, action.startAfter);
      else
        await deliverWebhook(action.url, action.format, action.template, {
          serverName: server.name,
          serverUid: server.uid,
          taskName: schedule.name,
          trigger: event?.type ?? null,
          playerName: event?.playerName ?? null,
        });
    }
    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { lastRunOk: true, lastRunError: null },
    });
    await activity(server.id, 'schedule.completed', `Completed: ${schedule.name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Task failed';
    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { lastRunOk: false, lastRunError: message },
    });
    await activity(server.id, 'schedule.failed', `${schedule.name}: ${message}`);
  }
}
