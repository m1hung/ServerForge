import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { prisma, type Prisma } from '@serverforge/db';
import { conflict, unauthorized } from '@serverforge/core';
import { config } from '../lib/config.js';
import { lifecycle } from './lifecycle.js';
import { drainServerOperations } from './server-lock.js';
import { runtime, startServer, stopServer } from '../routes/servers.js';
import { logger } from '../lib/logger.js';

const key = 'maintenance.active';
type Maintenance = {
  id: string;
  kind: 'panel' | 'full';
  runningIds: string[];
  startedAt: number;
  heartbeatAt: number;
  error?: string;
};
let current: Maintenance | null = null;
let changing = false;
let finishing: { id: string; promise: Promise<{ ok: boolean; failedServerIds: string[] }> } | null =
  null;
export function authorizeMaintenance(token: string | undefined) {
  const expected = createHmac('sha256', config.encryptionKey)
    .update('serverforge-maintenance-v1')
    .digest('hex');
  const supplied = Buffer.from(token?.replace(/^Bearer /, '') ?? '');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, Buffer.from(expected)))
    throw unauthorized();
}
async function persist() {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: current as unknown as Prisma.InputJsonValue },
    update: { value: current as unknown as Prisma.InputJsonValue },
  });
}
export async function beginMaintenance(kind: 'panel' | 'full') {
  if (current || changing || lifecycle.mode !== 'ready')
    throw conflict('Another maintenance operation is active.');
  changing = true;
  lifecycle.mode = 'maintenance';
  current = {
    id: randomUUID(),
    kind,
    runningIds: [],
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
  };
  try {
    if (!(await drainServerOperations(30000)))
      throw conflict(
        'Active server operations did not finish within 30 seconds. Let them finish before retrying.',
      );
    if (kind === 'full')
      current.runningIds = (
        await prisma.server.findMany({ where: { state: 'running' }, select: { id: true } })
      ).map((server) => server.id);
    await persist();
    for (const id of current.runningIds) await stopServer(id, { forceAfterTimeout: false });
    return current;
  } catch (error) {
    await finishMaintenance(current.id).catch((resumeError) =>
      logger.error('maintenance recovery needs attention', { message: String(resumeError) }),
    );
    throw error;
  } finally {
    changing = false;
  }
}
export async function heartbeatMaintenance(id?: string) {
  if (!current || (id && current.id !== id)) throw conflict('This maintenance session has ended.');
  current.heartbeatAt = Date.now();
  await persist();
  return current;
}
export function finishMaintenance(id: string) {
  if (finishing?.id === id) return finishing.promise;
  const promise = resumeMaintenance(id).finally(() => {
    if (finishing?.id === id) finishing = null;
  });
  finishing = { id, promise };
  return promise;
}
async function resumeMaintenance(id: string) {
  if (!current || current.id !== id) throw conflict('This maintenance session has ended.');
  const failures: string[] = [];
  for (const serverId of current.runningIds) {
    try {
      const server = await prisma.server.findUnique({ where: { id: serverId } });
      if (!server) continue;
      if (server.containerId && (await runtime.status(server.containerId)).running) continue;
      if (!['offline', 'crashed'].includes(server.state))
        await prisma.server.update({ where: { id: serverId }, data: { state: 'offline' } });
      await startServer(serverId);
    } catch (error) {
      logger.error('Game could not resume after maintenance', { serverId, message: String(error) });
      failures.push(serverId);
    }
  }
  if (failures.length) {
    await prisma.setting.upsert({
      where: { key: 'maintenance.attention' },
      create: {
        key: 'maintenance.attention',
        value: {
          serverIds: failures,
          message:
            'These games could not resume after maintenance. Inspect their console logs and start them manually.',
          at: new Date().toISOString(),
        },
      },
      update: {
        value: {
          serverIds: failures,
          message: 'Games could not resume after maintenance. Inspect their logs.',
          at: new Date().toISOString(),
        },
      },
    });
  }
  await prisma.setting.deleteMany({ where: { key } });
  current = null;
  if (lifecycle.mode !== 'stopping') lifecycle.mode = 'ready';
  return { ok: failures.length === 0, failedServerIds: failures };
}
export async function startMaintenanceRecovery() {
  const saved = await prisma.setting.findUnique({ where: { key } });
  if (saved) {
    current = saved.value as unknown as Maintenance;
    lifecycle.mode = 'maintenance';
  }
  const timer = setInterval(() => {
    if (!current || changing || Date.now() - current.heartbeatAt < 90000) return;
    changing = true;
    void finishMaintenance(current.id)
      .catch((error) => logger.error('maintenance recovery failed', { message: String(error) }))
      .finally(() => {
        changing = false;
      });
  }, 5000);
  timer.unref();
  return () => clearInterval(timer);
}
