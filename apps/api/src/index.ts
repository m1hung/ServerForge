import fs from 'node:fs/promises';
import { brand } from '@serverforge/core';
import { prisma } from '@serverforge/db';
import { buildApp } from './app.js';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { closeRedis } from './lib/redis.js';
import { describeMountMismatch } from './lib/storage-paths.js';
import { closeQueues } from './queue/index.js';
import { createWorkers, startScheduler, startTriggerListener } from './queue/workers.js';
import { startMonitor, stopMonitor } from './services/monitor.js';
import { startPortForwarding, stopPortForwarding } from './services/upnp.js';
import { startDdns, stopDdns } from './services/ddns.js';
import { localRuntime } from './runtime/index.js';
import { pruneSessions } from './lib/auth.js';

/**
 * Entry point.
 *
 * One process runs the HTTP API, the workers and the supervisor by default —
 * the right shape for a self-hosted panel. Set `WORKER=0` to run an API-only
 * replica behind a load balancer once one machine stops being enough.
 */

const runWorkers = process.env.WORKER !== '0';

async function main(): Promise<void> {
  await preflight();

  const app = await buildApp();
  const workers = runWorkers ? createWorkers() : [];
  let scheduler: NodeJS.Timeout | null = null;
  let stopTriggers: (() => void) | null = null;
  let sessionPrune: NodeJS.Timeout | null = null;

  if (runWorkers) {
    await startMonitor();
    await startPortForwarding();
    await startDdns();
    scheduler = startScheduler();
    stopTriggers = startTriggerListener();
    sessionPrune = setInterval(
      () => void pruneSessions().catch((error) => logger.warn({ error }, 'session prune failed')),
      3_600_000,
    );
  }

  await app.listen({ host: config.API_HOST, port: config.API_PORT });

  logger.info(
    { port: config.API_PORT, workers: runWorkers },
    `${brand.name} API ready — ${brand.tagline}`,
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    // Order matters: stop accepting work, finish what is in flight, then
    // close connections. A backup killed mid-tar leaves a corrupt archive.
    if (scheduler) clearInterval(scheduler);
    if (stopTriggers) stopTriggers();
    if (sessionPrune) clearInterval(sessionPrune);
    stopMonitor();
    // Mappings are left in place on purpose: a panel restart should not drop
    // players out of a server that is still running.
    stopPortForwarding();
    stopDdns();

    await app.close().catch(() => undefined);
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await closeQueues();
    await closeRedis();
    await prisma.$disconnect();

    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/**
 * Fail fast with actionable messages.
 *
 * Every check here corresponds to a support question someone would otherwise
 * have to ask: "why can't it start?", "why does deploying fail?".
 */
async function preflight(): Promise<void> {
  const problems: string[] = [];

  const dbOk = await prisma
    .$queryRaw`SELECT 1`
    .then(() => true)
    .catch(() => false);
  if (!dbOk) {
    problems.push(
      'Cannot reach PostgreSQL. Is the database running? Try: npm run stack:up\n' +
        `    DATABASE_URL points at: ${redact(config.DATABASE_URL)}`,
    );
  }

  const { redis } = await import('./lib/redis.js');
  const redisOk = await redis
    .ping()
    .then(() => true)
    .catch(() => false);
  if (!redisOk) {
    problems.push(
      'Cannot reach Redis. Installs, backups and the live console all need it.\n' +
        '    Try: npm run stack:up',
    );
  }

  for (const [label, dir] of [
    ['DATA_ROOT', config.dataRoot],
    ['BACKUP_ROOT', config.backupRoot],
    ['CACHE_ROOT', config.cacheRoot],
    ['THEMES_ROOT', config.themesRoot],
  ] as const) {
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.access(dir, fs.constants.W_OK);
    } catch {
      problems.push(`${label} (${dir}) does not exist or is not writable by this process.`);
    }
  }

  const dockerOk = await localRuntime().ping();
  if (!dockerOk) {
    problems.push(
      `Cannot reach the Docker daemon at ${config.DOCKER_SOCKET}.\n` +
        '    Game servers cannot be deployed until this works.\n' +
        '    On Linux: sudo usermod -aG docker $USER, then log out and back in.',
    );
  }

  const hostRoots = dockerOk ? await checkHostRoots() : { blocking: null, warnings: [] };
  if (hostRoots.blocking) problems.push(hostRoots.blocking);
  problems.push(...hostRoots.warnings);

  if (problems.length > 0) {
    // A disproved HOST_DATA_ROOT is fatal on purpose. The panel would come up
    // looking healthy and then break every single deploy, in a way whose
    // symptom (a Java error about a missing jar) points nowhere near the
    // cause. Refusing to start is the only honest signal.
    const fatal = !dbOk || !redisOk || hostRoots.blocking !== null;
    const heading = fatal ? 'Startup blocked:' : 'Startup warnings:';
    logger.error(`\n${heading}\n${problems.map((p) => `  • ${p}`).join('\n')}\n`);
    if (fatal) process.exit(1);
  }

  const userCount = await prisma.user.count().catch(() => -1);
  if (userCount === 0) {
    logger.info('No accounts yet — open the dashboard to create the first one.');
  }
}

/**
 * Confirms the host paths handed to the Docker daemon are real.
 *
 * Only the mount table proves it, and only that proof blocks startup: it says
 * outright where DATA_ROOT comes from, so a HOST_DATA_ROOT that disagrees is
 * wrong and every deploy from this process would be broken.
 *
 * Without one — running natively, or in a container this process could not
 * identify over the socket — a missing directory is merely suspicious: from
 * inside a container the host path is not expected to exist. That warns.
 *
 * Backups never block. A wrong HOST_BACKUP_ROOT misreports where archives are,
 * but they still land on the mounted BACKUP_ROOT.
 */
async function checkHostRoots(): Promise<{ blocking: string | null; warnings: string[] }> {
  const mounts = await localRuntime().selfMounts();

  if (mounts) {
    const backup = describeMountMismatch(mounts, {
      containerRoot: config.backupRoot,
      hostRoot: config.HOST_BACKUP_ROOT,
      localKey: 'BACKUP_ROOT',
      hostKey: 'HOST_BACKUP_ROOT',
    });

    return {
      blocking: describeMountMismatch(mounts, {
        containerRoot: config.dataRoot,
        hostRoot: config.HOST_DATA_ROOT,
        localKey: 'DATA_ROOT',
        hostKey: 'HOST_DATA_ROOT',
      }),
      warnings: backup ? [backup] : [],
    };
  }

  const warnings: string[] = [];
  for (const [key, dir] of [
    ['HOST_DATA_ROOT', config.HOST_DATA_ROOT],
    ['HOST_BACKUP_ROOT', config.HOST_BACKUP_ROOT],
  ] as const) {
    const reachable = await fs
      .access(dir)
      .then(() => true)
      .catch(() => false);
    if (reachable) continue;

    warnings.push(
      `${key} (${dir}) cannot be reached from this process.\n` +
        '    If the panel runs on the host, Docker will create that path empty for every\n' +
        '    game container and servers will fail with "Unable to access jarfile\n' +
        '    server.jar" — re-run npm run bootstrap. If the panel runs in a container,\n' +
        '    check it against the host path DATA_ROOT is bind-mounted from.',
    );
  }

  return { blocking: null, warnings };
}

function redact(url: string): string {
  return url.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
}

main().catch((error) => {
  logger.fatal({ error }, 'failed to start');
  process.exit(1);
});
