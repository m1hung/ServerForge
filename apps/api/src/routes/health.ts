import type { FastifyInstance } from 'fastify';
import { config } from '../lib/config.js';
import { DockerRuntime } from '../runtime/docker.js';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { prisma } from '@serverforge/db';
import { requireAdmin } from '../plugins/auth.js';
import { activeServerOperations } from '../services/server-lock.js';
import { lifecycle } from '../services/lifecycle.js';
import { storageSpace } from '../lib/storage-space.js';
import { z } from 'zod';
import { forbidden, brand, redactDiagnostic } from '@serverforge/core';
import { configurationFingerprint } from '../services/configuration-state.js';
import { proofSchema, withAccountProof, audit } from '../services/account-security.js';

const runtime = new DockerRuntime(config.dockerSocket, 2500);
async function probe(action: () => Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 2500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function checks() {
  const [database, schema, collation, docker, storage] = await Promise.all([
    probe(() => prisma.$queryRaw`SELECT 1`),
    probe(async () => {
      await prisma.$queryRaw`SELECT u."totpLastCounter", s."publicAccess", a."state", i."tokenHash" FROM "User" u CROSS JOIN "Server" s CROSS JOIN "InstallationAttempt" a CROSS JOIN "Invitation" i LIMIT 0`;
      const applied = await prisma.$queryRaw<{ migration_name: string }[]>`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY started_at DESC LIMIT 1`;
      if (applied[0]?.migration_name !== '202609140003_release_candidate') throw new Error('Expected database migrations are not applied.');
    }),
    probe(async () => {
      const rows = await prisma.$queryRaw<{ current: boolean }[]>`SELECT datcollversion IS NOT DISTINCT FROM pg_database_collation_actual_version(oid) AS current FROM pg_database WHERE datname=current_database()`;
      if (!rows[0]?.current) throw new Error('Database sorting requires a backed-up index rebuild.');
    }),
    runtime.ping(),
    probe(() =>
      Promise.all(
        [config.dataRoot, config.backupRoot, config.cacheRoot].map((root) =>
          fs.access(root, constants.R_OK | constants.W_OK),
        ),
      ),
    ),
  ]);
  return { database, schema, collation, docker, storage };
}
let cached: { at: number; promise: ReturnType<typeof checks> } | undefined;
export async function readiness() {
  if (!cached || Date.now() - cached.at > 1000) cached = { at: Date.now(), promise: checks() };
  const dependencies = await cached.promise;
  const supervisor =
    !lifecycle.supervisorRequired ||
    (lifecycle.lastSupervisorTickAt !== null &&
      Date.now() - lifecycle.lastSupervisorTickAt < 45000);
  const result = { ...dependencies, supervisor, acceptingMutations: lifecycle.mode === 'ready' };
  return {
    ok: Object.values(result).every(Boolean),
    docker: dependencies.docker,
    brand: config.brand.name,
    checks: result,
  };
}

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health/live', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { ok: true };
  });
  for (const url of ['/health', '/health/ready'])
    app.get(url, async (_request, reply) => {
      const result = await readiness();
      reply.header('Cache-Control', 'no-store').code(result.ok ? 200 : 503);
      return result;
    });
  app.get('/api/system/status', async (request, reply) => {
    requireAdmin(request);
    reply.header('Cache-Control', 'no-store');
    const [servers, managed] = await Promise.all([
      prisma.server.findMany({ where: { state: { not: 'deleting' } }, take: 500 }).catch(() => []),
      runtime.listManaged().catch(() => []),
    ]);
    const attention = servers.flatMap((server) => {
      const reasons: string[] = [];
      if (server.state === 'suspended') reasons.push('Server suspended. Review its activity log before resuming.');
      if (server.ioWeight < 10 || server.ioWeight > 1000) reasons.push('The saved I/O weight is invalid. Set a value between 10 and 1,000.');
      if (server.state === 'running') {
        const container = managed.find((entry) => entry.id === server.containerId);
        if (!container) reasons.push('The owned game container could not be verified.');
        else if (container.labels[`${brand.labelNamespace}/configuration`] !== configurationFingerprint(server))
          reasons.push('Restart pending: saved settings, allocation, or release protections have not been applied.');
      }
      return reasons.length ? [{ uid: server.uid, name: server.name, reasons }] : [];
    });
    const report = {
      measuredAt: new Date().toISOString(),
      processMetrics: { rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed, uptimeSeconds: process.uptime() },
      attention,
      ...(await readiness()),
      mode: lifecycle.mode,
      activeOperations: activeServerOperations(),
      lastSupervisorTickAt: lifecycle.lastSupervisorTickAt,
      capabilities: await runtime.capabilities().catch(() => null),
      storage: await Promise.all(
        (
          [
            ['Games', config.dataRoot],
            ['Backups', config.backupRoot],
          ] as const
        ).map(async ([name, directory]) => ({
          name,
          ...(await storageSpace(directory).catch(() => ({ freeBytes: null, totalBytes: null }))),
        })),
      ),
      recovery: redactDiagnostic(await prisma.setting
        .findMany({
          where: {
            key: {
              in: [
                'recovery.lastSuccess',
                'recovery.lastFailure',
                'recovery.schedule',
                'maintenance.attention',
              ],
            },
          },
          select: { key: true, value: true },
        })
        .catch(() => [])),
      installations: await prisma.installationAttempt
        .findMany({
          where: { state: { in: ['failed', 'cancelled'] }, server: { state: 'install_failed' } },
          distinct: ['serverId'],
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            uid: true,
            server: { select: { uid: true, name: true } },
            state: true,
            error: true,
            updatedAt: true,
          },
        })
        .catch(() => []),
      interruptedSchedules: await prisma.schedule
        .findMany({
          where: { lastRunOk: false },
          take: 20,
          orderBy: { updatedAt: 'desc' },
          select: {
            uid: true,
            name: true,
            lastRunError: true,
            server: { select: { uid: true, name: true } },
          },
        })
        .catch(() => []),
    };
    if ((request.query as { download?: string }).download === '1')
      reply.header('Content-Disposition', 'attachment; filename="serverforge-diagnostics.json"');
    const secrets = Object.entries(process.env).filter(([key]) => /SECRET|TOKEN|PASSWORD|KEY|DATABASE_URL/.test(key)).map(([, value]) => value || '');
    return redactDiagnostic(report, secrets);
  });
  app.put('/api/system/backup-policy', async (request) => {
    const user = requireAdmin(request);
    if (user.role !== 'owner')
      throw forbidden('Only workspace owners can schedule downtime for full recovery bundles.');
    const body = proofSchema
      .extend({ fullEnabled: z.boolean(), fullHourUtc: z.number().int().min(0).max(23) })
      .parse(request.body);
    await withAccountProof(request, body, async (tx) => {
      const existing = await tx.setting.findUnique({ where: { key: 'recovery.schedule' } });
      const value = {
        ...((existing?.value as Record<string, number | boolean>) || {}),
        fullEnabled: body.fullEnabled,
        fullHourUtc: body.fullHourUtc,
      };
      await tx.setting.upsert({
        where: { key: 'recovery.schedule' },
        create: { key: 'recovery.schedule', value },
        update: { value },
      });
      await audit(tx, request, 'recovery.policy_changed', 'system', undefined, {
        fullEnabled: body.fullEnabled,
        fullHourUtc: body.fullHourUtc,
      });
    });
    return { ok: true };
  });
}
