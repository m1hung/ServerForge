import type { ConsoleLine, InstallProgress, ResourceUsage, ServerState } from '@serverforge/core';
import { prisma } from '@serverforge/db';
import { CONSOLE_BUFFER_LINES, channels, keys, publisher, redis } from './redis.js';
import { logger } from './logger.js';

/**
 * Event fan-out.
 *
 * The worker process installs and monitors; the API process holds the
 * WebSockets. Redis pub/sub is what joins them, which also means a second API
 * replica behind a load balancer works with no extra code.
 */

export async function publishConsoleLine(serverUid: string, line: ConsoleLine): Promise<void> {
  const payload = JSON.stringify(line);
  await Promise.all([
    publisher.publish(channels.console(serverUid), payload),
    // Ring buffer so a page load shows recent history instantly instead of
    // an empty console until the next line arrives.
    redis
      .multi()
      .rpush(keys.consoleBuffer(serverUid), payload)
      .ltrim(keys.consoleBuffer(serverUid), -CONSOLE_BUFFER_LINES, -1)
      .expire(keys.consoleBuffer(serverUid), 60 * 60 * 24)
      .exec(),
  ]);
}

export async function readConsoleBuffer(serverUid: string, limit = 200): Promise<ConsoleLine[]> {
  const raw = await redis.lrange(keys.consoleBuffer(serverUid), -limit, -1);
  return raw
    .map((entry) => {
      try {
        return JSON.parse(entry) as ConsoleLine;
      } catch {
        return null;
      }
    })
    .filter((line): line is ConsoleLine => line !== null);
}

export async function clearConsoleBuffer(serverUid: string): Promise<void> {
  await redis.del(keys.consoleBuffer(serverUid));
}

/**
 * Single writer for server state.
 *
 * Every state change goes through here so the DB row, the per-server channel
 * and the fleet channel can never disagree — a split between them is what
 * produces a dashboard stuck on "Starting…" forever.
 */
export async function setServerState(
  serverUid: string,
  state: ServerState,
  extra: { message?: string; containerId?: string | null } = {},
): Promise<void> {
  const data: Record<string, unknown> = { state };
  if (extra.containerId !== undefined) data.containerId = extra.containerId;
  if (state === 'running') data.lastStartAt = new Date();
  if (state === 'crashed') data.lastCrashAt = new Date();

  await prisma.server.update({ where: { uid: serverUid }, data }).catch((error) => {
    logger.error({ error, serverUid, state }, 'failed to persist server state');
  });

  const payload = JSON.stringify({ serverUid, state, message: extra.message, at: Date.now() });
  await Promise.all([
    publisher.publish(channels.state(serverUid), payload),
    publisher.publish(channels.fleet(), payload),
  ]);
}

export async function publishStats(serverUid: string, usage: ResourceUsage): Promise<void> {
  await publisher.publish(channels.stats(serverUid), JSON.stringify(usage));
}

export async function publishInstallProgress(progress: InstallProgress): Promise<void> {
  await publisher.publish(channels.install(progress.serverId), JSON.stringify(progress));
}

/** Writes a line to the server's human-readable activity timeline. */
export async function recordActivity(input: {
  serverId: string;
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  message: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await prisma.activity
    .create({
      data: {
        serverId: input.serverId,
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? null,
        action: input.action,
        message: input.message,
        metadata: (input.metadata ?? undefined) as never,
      },
    })
    .catch((error) => logger.warn({ error }, 'failed to record activity'));
}

export async function recordAudit(input: {
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string;
}): Promise<void> {
  await prisma.auditLog
    .create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        metadata: (input.metadata ?? undefined) as never,
        ip: input.ip ?? null,
      },
    })
    .catch((error) => logger.warn({ error }, 'failed to record audit entry'));
}
