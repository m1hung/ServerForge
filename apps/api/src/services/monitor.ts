import { stripAnsi, truncateLine, type ConsoleLine } from '@serverforge/core';
import { getAdapter } from '@serverforge/adapters';
import { prisma } from '@serverforge/db';
import { logger } from '../lib/logger.js';
import {
  publishConsoleLine,
  publishServerEvent,
  publishStats,
  recordActivity,
  setServerState,
} from '../lib/events.js';
import { keys, redis } from '../lib/redis.js';
import { getRuntime } from '../runtime/index.js';
import type { LogStreamHandle } from '../runtime/types.js';
import { localDataPath } from '../lib/storage-paths.js';
import { directorySize } from './install-tools.js';

/**
 * The supervisor.
 *
 * Holds one log stream per running container, turns raw output into console
 * events, detects "ready" and crashes, samples resources, and enforces the
 * disk quota. This is the component that makes the dashboard feel live.
 */

interface Attachment {
  serverUid: string;
  containerId: string;
  handle: LogStreamHandle;
  seq: number;
  playersOnline: Set<string>;
  ready: boolean;
}

const attachments = new Map<string, Attachment>();

const STATS_INTERVAL_MS = 5_000;
const DISK_INTERVAL_MS = 60_000;
const RECONCILE_INTERVAL_MS = 15_000;
const LEADER_RENEW_MS = 10_000;
const LEADER_TTL_MS = 30_000;
/** Long enough to survive a slow stats tick, short enough that a dead worker's
    player list disappears rather than going stale on screen. */
const PLAYER_TTL_SECONDS = 300;

/**
 * Only one supervisor may run at a time.
 *
 * Two instances both attach to every container, so every console line is
 * published twice and every stat sample is doubled — a confusing failure that
 * looks like a game bug rather than a deployment mistake. A short-lived Redis
 * lock makes the second instance stand by instead, and take over within
 * `LEADER_TTL_MS` if the leader dies.
 */
const LEADER_KEY = 'sf:leader:monitor';
const instanceId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

let timers: NodeJS.Timeout[] = [];
let isLeader = false;

async function acquireLeadership(): Promise<boolean> {
  // SET NX PX is atomic: exactly one instance can win.
  const won = await redis.set(LEADER_KEY, instanceId, 'PX', LEADER_TTL_MS, 'NX');
  if (won === 'OK') return true;

  // Already ours? Renew rather than fight over it.
  const holder = await redis.get(LEADER_KEY);
  if (holder === instanceId) {
    await redis.pexpire(LEADER_KEY, LEADER_TTL_MS);
    return true;
  }
  return false;
}

async function releaseLeadership(): Promise<void> {
  const holder = await redis.get(LEADER_KEY).catch(() => null);
  if (holder === instanceId) await redis.del(LEADER_KEY).catch(() => undefined);
}

export async function startMonitor(): Promise<void> {
  isLeader = await acquireLeadership().catch(() => false);

  if (isLeader) {
    await reconcile();
    logger.info('monitor started');
  } else {
    logger.info('another instance is supervising servers; standing by');
  }

  timers = [
    // Leadership is re-checked on a timer so a standby instance takes over
    // automatically if the leader goes away.
    setInterval(() => void maintainLeadership().catch(logError('leadership')), LEADER_RENEW_MS),
    setInterval(() => void whenLeading(reconcile).catch(logError('reconcile')), RECONCILE_INTERVAL_MS),
    setInterval(() => void whenLeading(sampleStats).catch(logError('stats')), STATS_INTERVAL_MS),
    setInterval(() => void whenLeading(sampleDisk).catch(logError('disk')), DISK_INTERVAL_MS),
  ];
}

async function maintainLeadership(): Promise<void> {
  const held = await acquireLeadership();

  if (held && !isLeader) {
    logger.info('took over supervision');
    isLeader = true;
    await reconcile();
    return;
  }

  if (!held && isLeader) {
    // Lost the lock — most likely a Redis blip. Drop every attachment so the
    // new leader is the only one publishing.
    logger.warn('lost supervision lock; detaching');
    isLeader = false;
    for (const attachment of attachments.values()) attachment.handle.close();
    attachments.clear();
  }
}

const whenLeading = async (task: () => Promise<void>) => {
  if (isLeader) await task();
};

export function stopMonitor(): void {
  for (const timer of timers) clearInterval(timer);
  timers = [];
  for (const attachment of attachments.values()) attachment.handle.close();
  attachments.clear();
  if (isLeader) void releaseLeadership();
  isLeader = false;
}

const logError = (what: string) => (error: unknown) => logger.error({ error }, `monitor ${what} failed`);

/**
 * Brings our view in line with reality.
 *
 * Runs on boot and on a timer, which is what makes the panel survive its own
 * restart: containers keep running, and we simply re-attach to them rather
 * than showing every server as offline.
 */
async function reconcile(): Promise<void> {
  const servers = await prisma.server.findMany({
    where: { containerId: { not: null }, state: { notIn: ['deleting', 'suspended'] } },
    include: { node: true },
  });

  const live = new Set<string>();

  for (const server of servers) {
    if (!server.containerId) continue;
    live.add(server.uid);

    const runtime = getRuntime(server.node);
    const status = await runtime.status(server.containerId).catch(() => null);
    if (!status) continue;

    if (!status.exists) {
      detach(server.uid);
      if (server.state !== 'offline') await setServerState(server.uid, 'offline', { containerId: null });
      continue;
    }

    if (!status.running) {
      detach(server.uid);
      if (['running', 'starting', 'stopping'].includes(server.state)) {
        // A container that dies during boot never produces a log stream to
        // attach to, so its output would be lost entirely and the user would
        // see "crashed" above an empty console. Capture the tail first.
        await captureFinalOutput(server, runtime);
        await handleExit(server, status.exitCode ?? 0, status.oomKilled ?? false);
      }
      continue;
    }

    if (!attachments.has(server.uid)) {
      await attach(server);
    }
  }

  // Drop attachments for servers that vanished (deleted while we watched).
  for (const uid of attachments.keys()) {
    if (!live.has(uid)) detach(uid);
  }
}

async function attach(server: {
  id: string;
  uid: string;
  gameId: string;
  containerId: string | null;
  node: { id: string; transport: string; agentUrl: string | null };
}): Promise<void> {
  if (!server.containerId) return;

  const runtime = getRuntime(server.node);
  const adapter = getAdapter(server.gameId);

  const attachment: Attachment = {
    serverUid: server.uid,
    containerId: server.containerId,
    handle: { close: () => undefined },
    seq: 0,
    playersOnline: new Set(),
    ready: false,
  };
  attachments.set(server.uid, attachment);

  // The in-memory set starts empty, so Redis has to as well. Without this a
  // worker restart would leave whoever was online before the restart listed
  // forever, since their "left" line was consumed by the previous process.
  await redis.del(keys.players(server.uid)).catch(() => undefined);

  attachment.handle = await runtime.streamLogs(
    server.containerId,
    {
      onLine: (raw, stream) => {
        const text = truncateLine(stripAnsi(raw));
        if (text.trim() === '') return;

        const line: ConsoleLine = {
          seq: attachment.seq++,
          at: Date.now(),
          stream,
          text,
        };
        void publishConsoleLine(server.uid, line);

        const insight = adapter.inspectLog?.(text);
        if (!insight) return;

        if (insight.ready && !attachment.ready) {
          attachment.ready = true;
          void setServerState(server.uid, 'running');
        }

        if (insight.playerEvent) {
          const { type, name } = insight.playerEvent;
          if (type === 'join') attachment.playersOnline.add(name);
          else attachment.playersOnline.delete(name);
          void syncPlayers(server.uid, attachment.playersOnline);
          void publishServerEvent({
            serverUid: server.uid,
            type: type === 'join' ? 'player.join' : 'player.leave',
            at: Date.now(),
            playerName: name,
          });
        }
      },
      onEnd: () => detach(server.uid),
    },
    { tail: 100 },
  );

  logger.debug({ serverUid: server.uid }, 'attached to container logs');
}

function detach(serverUid: string): void {
  const attachment = attachments.get(serverUid);
  if (!attachment) return;
  attachment.handle.close();
  attachments.delete(serverUid);
  // A server nobody is watching has nobody connected to it.
  void redis.del(keys.players(serverUid)).catch(() => undefined);
}

/**
 * Mirrors the worker's player set into Redis.
 *
 * The whole set is rewritten rather than the one name that changed, so the two
 * cannot drift after a dropped command — player counts are small enough that
 * correctness is worth more than the saved round trip. The TTL means a worker
 * that dies stops claiming people are online a few minutes later; `sampleStats`
 * refreshes it while the worker is alive.
 */
async function syncPlayers(serverUid: string, players: Set<string>): Promise<void> {
  const key = keys.players(serverUid);
  try {
    if (players.size === 0) {
      // SADD with no members is an error, so an empty set is just a delete.
      await redis.del(key);
      return;
    }
    await redis.multi().del(key).sadd(key, ...players).expire(key, PLAYER_TTL_SECONDS).exec();
  } catch (error) {
    logger.debug({ error, serverUid }, 'could not sync the player list');
  }
}

/**
 * Publishes whatever a short-lived container printed before dying.
 *
 * The normal path streams logs from a running container, so a process that
 * exits during boot — the wrong Java version, a corrupt jar, a bad flag —
 * leaves nothing behind. Those are exactly the failures a user most needs the
 * text for, so the tail is replayed into the console as if it had streamed.
 */
async function captureFinalOutput(
  server: { id: string; uid: string; containerId: string | null; gameId: string },
  runtime: ReturnType<typeof getRuntime>,
): Promise<void> {
  if (!server.containerId) return;

  const existing = attachments.get(server.uid);
  if (existing) return; // already streamed live; nothing was missed

  const adapter = getAdapter(server.gameId);
  const lines: string[] = [];

  try {
    const handle = await runtime.streamLogs(
      server.containerId,
      { onLine: (raw) => lines.push(raw) },
      { tail: 60 },
    );
    // `follow` returns immediately for a stopped container, but give the
    // stream a moment to drain before closing it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    handle.close();
  } catch (error) {
    logger.debug({ error, serverUid: server.uid }, 'could not read final container output');
    return;
  }

  let seq = 0;
  for (const raw of lines) {
    const text = truncateLine(stripAnsi(raw));
    if (text.trim() === '') continue;
    await publishConsoleLine(server.uid, { seq: seq++, at: Date.now(), stream: 'stderr', text });

    // Surface the adapter's explanation for the line that actually mattered.
    const insight = adapter.inspectLog?.(text);
    if (insight?.hint && insight.level === 'error') {
      await publishConsoleLine(server.uid, {
        seq: seq++,
        at: Date.now(),
        stream: 'system',
        text: insight.hint,
      });
    }
  }
}

/**
 * Turns a container exit into a state the user can act on.
 *
 * The distinction that matters: exit 0 after a stop request is normal, an
 * OOM kill needs a memory message, and a non-zero exit while we thought it
 * was running is a crash worth auto-restarting.
 */
async function handleExit(
  server: { id: string; uid: string; state: string; autoRestart: boolean; crashCount: number },
  exitCode: number,
  oomKilled: boolean,
): Promise<void> {
  if (server.state === 'stopping' || exitCode === 0) {
    await setServerState(server.uid, 'offline');
    return;
  }

  const reason = oomKilled
    ? 'The server ran out of memory and was stopped by the system. Give it more memory in Settings.'
    : `The server stopped unexpectedly (exit code ${exitCode}). The last lines of the console usually say why.`;

  await setServerState(server.uid, 'crashed', { message: reason });
  await prisma.server.update({
    where: { id: server.id },
    data: { crashCount: { increment: 1 }, lastCrashAt: new Date() },
  });
  await recordActivity({
    serverId: server.id,
    action: 'server.crash',
    message: reason,
    metadata: { exitCode, oomKilled },
  });

  // Auto-restart, but with a crash-loop guard: restarting a server that is
  // failing on boot just fills the console with the same error forever.
  const crashCount = server.crashCount + 1;
  if (server.autoRestart && crashCount <= 3 && !oomKilled) {
    logger.info({ serverUid: server.uid, crashCount }, 'auto-restarting crashed server');
    const { startServer } = await import('./servers.js');
    await startServer(server.uid).catch((error) =>
      logger.error({ error, serverUid: server.uid }, 'auto-restart failed'),
    );
  } else if (crashCount > 3) {
    await recordActivity({
      serverId: server.id,
      action: 'server.crash_loop',
      message:
        'Auto-restart is paused after three crashes in a row. Fix the problem shown in the console, then start the server manually.',
    });
  }
}

async function sampleStats(): Promise<void> {
  for (const attachment of attachments.values()) {
    const server = await prisma.server.findUnique({
      where: { uid: attachment.serverUid },
      include: { node: true },
    });
    if (!server?.containerId) continue;

    const runtime = getRuntime(server.node);
    const usage = await runtime.stats(server.containerId).catch(() => null);
    if (!usage) continue;

    const diskBytes = Number((await redis.get(keys.diskUsage(server.uid))) ?? 0);

    // Doubles as the heartbeat for the player list: while this worker is alive
    // the key keeps being refreshed, and when it is not the TTL takes over.
    await syncPlayers(server.uid, attachment.playersOnline);
    const players = attachment.playersOnline.size;
    const uptimeSeconds = server.lastStartAt
      ? Math.floor((Date.now() - server.lastStartAt.getTime()) / 1000)
      : 0;

    await publishStats(server.uid, {
      ...usage,
      diskBytes,
      uptimeSeconds,
      players: { online: players, max: 0 },
    });
  }
}

/**
 * Disk usage is sampled on a slow timer because walking a 20 GB modpack is
 * expensive. Over-quota servers are stopped rather than left to fill the host
 * disk, which would take every other server down with them.
 */
async function sampleDisk(): Promise<void> {
  const servers = await prisma.server.findMany({
    where: { state: { in: ['running', 'starting'] } },
    include: { node: true },
  });

  for (const server of servers) {
    const bytes = await directorySize(localDataPath(server.dataPath)).catch(() => 0);
    await redis.set(keys.diskUsage(server.uid), bytes, 'EX', 300);

    await prisma.metricSample.create({
      data: {
        serverId: server.id,
        cpuPercent: 0,
        memoryBytes: BigInt(0),
        diskBytes: BigInt(bytes),
      },
    });

    if (server.diskMib > 0 && bytes > server.diskMib * 1024 * 1024) {
      logger.warn({ serverUid: server.uid, bytes }, 'server exceeded disk quota');
      await recordActivity({
        serverId: server.id,
        action: 'server.disk_limit',
        message:
          'The server hit its disk limit and was stopped. Delete some files or raise the limit, then start it again.',
      });
      const { stopServer } = await import('./servers.js');
      await stopServer(server.uid, { force: false }).catch(() => undefined);
    }
  }
}

/** Live player count for the dashboard card. */
export async function playerCount(serverUid: string): Promise<number> {
  return redis.scard(keys.players(serverUid)).catch(() => 0);
}

/**
 * Who is connected right now, alphabetically.
 *
 * Derived from console output, so it is as good as the adapter's log parsing:
 * accurate while the supervisor has been watching from the start, and a best
 * effort after a restart, where only the replayed tail is available. Callers
 * are expected to say so rather than present it as authoritative.
 */
export async function playersOnline(serverUid: string): Promise<string[]> {
  const names = await redis.smembers(keys.players(serverUid)).catch(() => []);
  return names.sort((a, b) => a.localeCompare(b));
}

/** True while this process is the supervisor that has been watching a server. */
export function isWatching(serverUid: string): boolean {
  return attachments.has(serverUid);
}
