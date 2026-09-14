import fs from 'node:fs/promises';
import { prisma, type Server } from '@serverforge/db';
import type { ManagedContainer } from '../runtime/types.js';
import type { ServerEvent } from '@serverforge/core';
import { runtime, startServer, loadServer } from '../routes/servers.js';
import { logger } from '../lib/logger.js';
import { beginServerOperation, isServerBusy } from '../services/server-lock.js';
import { activity, emitServerEvent, serverEvents } from '../services/server-events.js';
import {
  observeServer,
  clearObservations,
  closeObservations,
  sampleServer,
} from '../services/telemetry.js';
import { lifecycle } from '../services/lifecycle.js';
import { brand } from '@serverforge/core';
import { hostDataPath } from '../lib/storage-paths.js';
import { recoverSwap, operationRoot, backupFile } from '../services/backups.js';
import {
  nextRun,
  runSchedule,
  actionPermissions,
  validateSchedule,
} from '../services/schedules.js';
import { readUpdate } from '../services/updates.js';
import { recoverInstallation } from '../services/installations.js';

export function crashDecision(
  autoRestart: boolean,
  crashCount: number,
  lastCrashAt: Date | null,
  now = Date.now(),
) {
  const count = lastCrashAt && now - lastCrashAt.getTime() < 10 * 60_000 ? crashCount + 1 : 1;
  return {
    count,
    restart: autoRestart && count <= 3,
    delay: Math.min(120000, 30000 * 2 ** (count - 1)),
  };
}
async function reconcileContainer(server: Server, managed: ManagedContainer[]) {
  if (['installing', 'install_failed', 'creating', 'deleting', 'suspended', 'restoring', 'updating'].includes(server.state)) return false;
  const owned = managed.filter((container) => container.labels[`${brand.labelNamespace}/server`] === server.uid && container.dataPath === hostDataPath(server.dataPath));
  if (owned.length > 1) {
    await prisma.server.update({ where: { id: server.id }, data: { state: 'suspended' } });
    await activity(server.id, 'server.recovery_failed', 'Multiple owned containers claim this server. Inspect them before continuing.');
    return true;
  }
  const found = owned[0];
  if (!found) return false;
  const status = await runtime.status(found.id);
  if (found.id === server.containerId && (!status.running || server.state === 'running')) return false;
  await prisma.server.update({ where: { id: server.id }, data: { containerId: found.id, state: status.running ? 'running' : 'offline' } });
  await activity(server.id, 'server.reconciled', status.running ? 'Reconnected to the owned game container.' : 'An interrupted start was recovered. The server is offline and can be started again.');
  return true;
}
export async function startSupervisor() {
  let stopped = false;
  const managed = await runtime.listManaged();
  // Recover interrupted swaps before accepting any automatic action.
  for (const server of await prisma.server.findMany()) {
    try {
      await recoverSwap(server);
      if (await recoverInstallation(server)) continue;
      if (await reconcileContainer(server, managed)) continue;
      if (server.state === 'stopping') {
        const status = server.containerId ? await runtime.status(server.containerId) : null;
        await prisma.server.update({
          where: { id: server.id },
          data: { state: status?.running ? 'running' : 'offline' },
        });
        await activity(
          server.id,
          'server.reconciled',
          status?.running
            ? 'Shutdown was interrupted. The game is still running; stop it again when ready.'
            : 'The interrupted shutdown completed.',
        );
      }
      if (server.state === 'installing' || server.state === 'creating') {
        await prisma.server.update({ where: { id: server.id }, data: { state: 'install_failed' } });
        await prisma.installLog.create({
          data: {
            serverId: server.id,
            phase: 'failed',
            message:
              'The panel restarted during installation. Review the logs and retry the installation.',
          },
        });
      }
      const plan = await readUpdate(server.uid);
      if (plan && ['preparing', 'applying'].includes(plan.state)) {
        await fs.writeFile(
          `${operationRoot(server.uid)}/update.json`,
          JSON.stringify({
            ...plan,
            state: 'failed',
            error:
              'The panel restarted during this operation. Review the server and prepare again.',
          }),
          { mode: 0o600 },
        );
      }
    } catch (error) {
      await prisma.server.update({ where: { id: server.id }, data: { state: 'suspended' } });
      logger.error('server recovery needs attention', { uid: server.uid, message: String(error) });
    }
  }
  const interruptedBackups = await prisma.backup.findMany({ where: { state: { in: ['pending', 'running'] } }, include: { server: { select: { uid: true } } } });
  for (const backup of interruptedBackups) {
    try {
      const file = await backupFile({ filePath: `${backup.server.uid}/${backup.uid}.tar.gz` });
      await fs.rm(`${file}.partial`, { force: true });
      await fs.rm(file, { force: true });
    } catch (error) {
      await prisma.backup.update({ where: { id: backup.id }, data: { state: 'failed', error: 'The panel restarted. An incomplete archive needs host inspection before removal.', finishedAt: new Date() } });
      logger.warn('Interrupted backup cleanup needs attention', { uid: backup.uid, message: String(error) });
    }
  }
  await prisma.backup.updateMany({
    where: { state: { in: ['pending', 'running'] } },
    data: {
      state: 'failed',
      error: 'The panel restarted before this backup completed.',
      finishedAt: new Date(),
    },
  });
  const interrupted = await prisma.schedule.findMany({
    where: { lastRunAt: { not: null }, lastRunOk: null },
  });
  for (const schedule of interrupted) {
    await prisma.schedule.update({
      where: { id: schedule.id },
      data: {
        lastRunOk: false,
        lastRunError:
          'The panel restarted before this run completed. Review it before retrying; actions were not replayed.',
      },
    });
    await activity(
      schedule.serverId,
      'schedule.interrupted',
      `${schedule.name}: interrupted by a panel restart.`,
    );
  }
  const missed = await prisma.schedule.findMany({
    where: { enabled: true, cron: { not: null }, nextRunAt: { lte: new Date() } },
  });
  for (const schedule of missed) {
    try {
      await prisma.schedule.update({
        where: { id: schedule.id },
        data: {
          nextRunAt: nextRun(schedule.cron!, schedule.timezone),
          lastRunOk: false,
          lastRunError:
            'Missed while the panel was offline. Waiting for the next scheduled occurrence.',
        },
      });
      await activity(
        schedule.serverId,
        'schedule.missed',
        `${schedule.name}: skipped an occurrence missed while the panel was offline.`,
      );
    } catch {
      await prisma.schedule.update({
        where: { id: schedule.id },
        data: {
          enabled: false,
          lastRunOk: false,
          lastRunError:
            'This schedule could not be recovered. Review its timing and enable it again.',
        },
      });
    }
  }
  const events: ServerEvent[] = [];
  const pendingEvents: { scheduleId: string; event: ServerEvent }[] = [];
  const onEvent = (event: ServerEvent) => {
    if (stopped || lifecycle.mode !== 'ready') return;
    if (events.length < 1000) events.push(event);
  };
  serverEvents.on('server', onEvent);
  let ticking = false,
    lastSample = 0,
    lastPrune = 0;
  const report = (error: unknown) =>
    logger.error('supervisor action failed', { message: String(error) });
  const tick = async () => {
    if (ticking || stopped || lifecycle.mode !== 'ready') return;
    ticking = true;
    try {
      const now = Date.now(),
        collect = now - lastSample >= 30000;
      if (collect) lastSample = now;
      const servers = await prisma.server.findMany({
        where: { state: { in: ['running', 'starting', 'crashed'] } },
      });
      const owned = await runtime.listManaged();
      for (const server of servers) {
        if (stopped || lifecycle.mode !== 'ready') break;
        if (isServerBusy(server.uid)) continue;
        try {
          if (await reconcileContainer(server, owned)) continue;
          if (server.state === 'crashed') {
            if (server.containerId && (await runtime.status(server.containerId)).running) {
              await prisma.server.update({ where: { id: server.id }, data: { state: 'running' } });
              continue;
            }

            const delay = Math.min(120000, 30000 * 2 ** Math.max(0, server.crashCount - 1));
            if (
              server.autoRestart &&
              server.crashCount > 0 &&
              server.crashCount <= 3 &&
              server.lastCrashAt &&
              now - server.lastCrashAt.getTime() >= delay
            ) {
              void beginServerOperation(server.uid, async () => {
                try {
                  await startServer(server.id, true);
                  await activity(
                    server.id,
                    'server.restarted',
                    `Automatic recovery attempt ${server.crashCount} of 3.`,
                  );
                } catch (error) {
                  await prisma.server.update({
                    where: { id: server.id },
                    data: {
                      state: 'crashed',
                      crashCount: { increment: 1 },
                      lastCrashAt: new Date(),
                    },
                  });
                  await activity(
                    server.id,
                    'server.recovery_failed',
                    error instanceof Error ? error.message : 'Automatic recovery failed.',
                  );
                }
              }).catch(report);
            }
            continue;
          }
          const status = server.containerId
            ? await runtime.status(server.containerId)
            : { exists: false, running: false };
          if (!status.running) {
            await beginServerOperation(server.uid, async () => {
              const decision = crashDecision(
                server.autoRestart,
                server.crashCount,
                server.lastCrashAt,
                now,
              );
              const reason = status.oomKilled
                ? 'The container ran out of memory.'
                : !status.exists
                  ? 'The server container is missing.'
                  : `Server process exited with code ${status.exitCode ?? 'unknown'}.`;
              await prisma.server.update({
                where: { id: server.id },
                data: { state: 'crashed', lastCrashAt: new Date(now), crashCount: decision.count },
              });
              clearObservations(server.uid);
              await activity(
                server.id,
                'server.crashed',
                `${reason} ${decision.restart ? `Restarting in ${decision.delay / 1000} seconds (attempt ${decision.count}/3).` : 'Automatic recovery is paused. Review the logs before starting again.'}`,
              );
              emitServerEvent({ serverUid: server.uid, type: 'server.crashed', at: now });
            });
          } else {
            await observeServer(server);
            if (collect) await sampleServer(server);
            if (
              server.crashCount &&
              server.lastStartAt &&
              now - server.lastStartAt.getTime() > 600000
            )
              await prisma.server.update({ where: { id: server.id }, data: { crashCount: 0 } });
          }
        } catch (error) {
          report(error);
        }
      }
      const due = await prisma.schedule.findMany({
        where: { enabled: true, cron: { not: null }, nextRunAt: { lte: new Date(now) } },
      });
      const batch = events.splice(0);
      for (const event of batch) {
        if (isServerBusy(event.serverUid)) {
          if (events.length < 1000) events.push(event);
          continue;
        }
        const triggered = await prisma.schedule.findMany({
          where: { enabled: true, triggerType: event.type, server: { uid: event.serverUid } },
        });
        for (const schedule of triggered) {
          if (pendingEvents.length < 1000) pendingEvents.push({ scheduleId: schedule.id, event });
        }
      }
      for (const job of pendingEvents.splice(0)) {
        // Re-read edits/deletions while queued, and retain events while another job holds the lock.
        const schedule = await prisma.schedule.findUnique({ where: { id: job.scheduleId } });
        if (schedule?.enabled && !(await dispatch(schedule, job.event))) pendingEvents.push(job);
      }
      for (const schedule of due) await dispatch(schedule);
      if (now - lastPrune > 3600000) {
        lastPrune = now;
        await prisma.metricSample.deleteMany({
          where: { at: { lt: new Date(now - 7 * 86400000) } },
        });
      }
      lifecycle.lastSupervisorTickAt = Date.now();
    } finally {
      ticking = false;
    }
  };
  async function dispatch(
    schedule: Awaited<ReturnType<typeof prisma.schedule.findMany>>[number],
    event?: ServerEvent,
  ) {
    if (stopped || lifecycle.mode !== 'ready') return false;
    const server = await prisma.server.findUnique({ where: { id: schedule.serverId } });
    if (!server) return true;
    if (isServerBusy(server.uid)) return false;
    if (
      event &&
      schedule.lastRunAt &&
      event.at - schedule.lastRunAt.getTime() < Math.max(1, schedule.cooldownSeconds) * 1000
    )
      return true;
    void beginServerOperation(server.uid, async () => {
      try {
        const next = schedule.cron ? nextRun(schedule.cron, schedule.timezone) : null;
        const claim = await prisma.schedule.updateMany({
          where: { id: schedule.id, enabled: true, lastRunAt: schedule.lastRunAt },
          data: { lastRunAt: new Date(), nextRunAt: next, lastRunOk: null, lastRunError: null },
        });
        if (!claim.count) return;
        const actor = schedule.creatorId
          ? await prisma.user.findUnique({ where: { id: schedule.creatorId } })
          : null;
        if (!actor || actor.suspended)
          throw new Error(
            'The schedule creator no longer has access. Save this schedule with an active account.',
          );
        const input = validateSchedule(schedule);
        const permitted = await loadServer(server.uid, actor, 'server.schedules');
        for (const permission of actionPermissions(input.actions))
          await loadServer(server.uid, actor, permission);
        await runSchedule(schedule, permitted, event);
      } catch (error) {
        await prisma.schedule.update({
          where: { id: schedule.id },
          data: {
            lastRunOk: false,
            lastRunError: error instanceof Error ? error.message : 'Schedule failed.',
          },
        });
      }
    }).catch(report);
    return true;
  }
  lifecycle.lastSupervisorTickAt = Date.now();
  await tick();
  const timer = setInterval(() => {
    void tick().catch(report);
  }, 15000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    serverEvents.off('server', onEvent);
    closeObservations();
    while (ticking) await new Promise((resolve) => setTimeout(resolve, 10));
  };
}
