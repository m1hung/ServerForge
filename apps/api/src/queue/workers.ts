import { Worker } from 'bullmq';
import parser from 'cron-parser';
import { prisma } from '@serverforge/db';
import { queueConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { recordActivity } from '../lib/events.js';
import { createBackupRecord, pruneScheduleBackups, runBackup, runRestore } from '../services/backups.js';
import { restartServer, sendConsoleCommand, startServer, stopServer } from '../services/servers.js';
import { createInstallWorker } from './install-worker.js';
import {
  backupQueue,
  installQueue,
  restoreQueue,
  scheduleQueue,
  type BackupJob,
  type RestoreJob,
  type ScheduleJob,
} from './index.js';

/**
 * Worker registration.
 *
 * All workers live in one process (`WORKER=1 npm start`), which is the right
 * default for a self-hosted panel: one fewer thing to run, and the install
 * concurrency limits already prevent a small box from being overwhelmed.
 */

export interface ScheduleAction {
  type: 'power' | 'command' | 'backup' | 'update';
  action?: 'start' | 'stop' | 'restart';
  command?: string;
  retain?: number;
  startAfter?: boolean;
}

export function createWorkers(): Worker[] {
  const workers: Worker[] = [createInstallWorker()];

  workers.push(
    new Worker<BackupJob>(
      'backup',
      async (job) => {
        await runBackup({
          serverUid: job.data.serverUid,
          backupUid: job.data.backupUid,
          ignore: job.data.ignore,
        });
        if (job.data.scheduleId && job.data.retain) {
          const pruned = await pruneScheduleBackups(job.data.scheduleId, job.data.retain);
          if (pruned > 0) logger.info({ pruned, scheduleId: job.data.scheduleId }, 'pruned old backups');
        }
      },
      // Backups are I/O heavy. One at a time keeps game servers playable
      // while a backup runs, which matters more than backup throughput.
      { connection: queueConnection, concurrency: 1 },
    ),
  );

  workers.push(
    new Worker<RestoreJob>(
      'restore',
      async (job) => runRestore({ serverUid: job.data.serverUid, backupUid: job.data.backupUid }),
      { connection: queueConnection, concurrency: 1 },
    ),
  );

  workers.push(
    new Worker<ScheduleJob>('schedule', async (job) => runSchedule(job.data.scheduleId), {
      connection: queueConnection,
      concurrency: 4,
    }),
  );

  for (const worker of workers) {
    worker.on('failed', (job, error) => {
      logger.error({ queue: worker.name, jobId: job?.id, error: error.message }, 'job failed');
    });
  }

  return workers;
}

async function runSchedule(scheduleId: string): Promise<void> {
  const schedule = await prisma.schedule.findUnique({
    where: { id: scheduleId },
    include: { server: true },
  });
  if (!schedule || !schedule.enabled) return;

  const server = schedule.server;
  const isOnline = ['running', 'starting'].includes(server.state);

  if (schedule.onlyWhenOnline && !isOnline) {
    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { lastRunAt: new Date(), lastRunOk: true, lastRunError: null, nextRunAt: nextRun(schedule.cron, schedule.timezone) },
    });
    return;
  }

  const actions = schedule.actions as unknown as ScheduleAction[];

  try {
    for (const action of actions) {
      switch (action.type) {
        case 'power':
          if (action.action === 'start') await startServer(server.uid);
          else if (action.action === 'stop') await stopServer(server.uid, {});
          else if (action.action === 'restart') await restartServer(server.uid);
          break;

        case 'command':
          if (action.command) await sendConsoleCommand(server.uid, action.command);
          break;

        case 'backup': {
          const backup = await createBackupRecord(server.id, {
            name: `${schedule.name} — ${new Date().toISOString().slice(0, 10)}`,
            scheduleId: schedule.id,
          });
          await backupQueue().add('backup', {
            serverUid: server.uid,
            backupUid: backup.uid,
            ignore: [],
            scheduleId: schedule.id,
            retain: action.retain ?? 5,
          });
          break;
        }

        case 'update': {
          if (['running', 'starting'].includes(server.state)) {
            await stopServer(server.uid, {});
          }
          await installQueue().add('install', {
            serverUid: server.uid,
            mode: 'update',
            startAfter: action.startAfter !== false,
          });
          break;
        }
      }
    }

    await prisma.schedule.update({
      where: { id: schedule.id },
      data: {
        lastRunAt: new Date(),
        lastRunOk: true,
        lastRunError: null,
        nextRunAt: nextRun(schedule.cron, schedule.timezone),
      },
    });
    await recordActivity({
      serverId: server.id,
      action: 'schedule.run',
      message: `Scheduled task "${schedule.name}" ran.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await prisma.schedule.update({
      where: { id: schedule.id },
      data: {
        lastRunAt: new Date(),
        lastRunOk: false,
        lastRunError: message,
        nextRunAt: nextRun(schedule.cron, schedule.timezone),
      },
    });
    await recordActivity({
      serverId: server.id,
      action: 'schedule.failed',
      message: `Scheduled task "${schedule.name}" failed: ${message}`,
    });
    throw error;
  }
}

export function nextRun(cron: string, timezone: string): Date | null {
  try {
    return parser.parseExpression(cron, { tz: timezone }).next().toDate();
  } catch {
    return null;
  }
}

/**
 * The scheduler tick.
 *
 * A single interval enqueues due schedules rather than one BullMQ repeatable
 * job per schedule: repeatable jobs are awkward to keep in sync with rows a
 * user edits, and this stays correct after any edit without cleanup.
 */
export function startScheduler(): NodeJS.Timeout {
  const tick = async () => {
    const due = await prisma.schedule.findMany({
      where: { enabled: true, OR: [{ nextRunAt: null }, { nextRunAt: { lte: new Date() } }] },
      take: 50,
    });

    for (const schedule of due) {
      if (schedule.nextRunAt === null) {
        // First sight of this schedule: just compute when it should run.
        await prisma.schedule.update({
          where: { id: schedule.id },
          data: { nextRunAt: nextRun(schedule.cron, schedule.timezone) },
        });
        continue;
      }

      await scheduleQueue().add('run', { scheduleId: schedule.id }, { jobId: `${schedule.id}:${schedule.nextRunAt.getTime()}` });
      await prisma.schedule.update({
        where: { id: schedule.id },
        data: { nextRunAt: nextRun(schedule.cron, schedule.timezone) },
      });
    }
  };

  void tick().catch((error) => logger.error({ error }, 'scheduler tick failed'));
  return setInterval(() => void tick().catch((error) => logger.error({ error }, 'scheduler tick failed')), 30_000);
}

export { restoreQueue };
