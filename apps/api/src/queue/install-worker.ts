import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'bullmq';
import type { InstallPhase } from '@serverforge/core';
import { getAdapter } from '@serverforge/adapters';
import { prisma } from '@serverforge/db';
import { queueConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { publishInstallProgress, recordActivity, setServerState } from '../lib/events.js';
import { getRuntime } from '../runtime/index.js';
import { chownTreeForGame } from '../lib/ownership.js';
import { localDataPath } from '../lib/storage-paths.js';
import { createInstallTools } from '../services/install-tools.js';
import { materializeStagedModpack } from '../services/modpack-staging.js';
import { buildContext, loadServer, startServer } from '../services/servers.js';
import type { InstallJob } from './index.js';

/**
 * The install worker.
 *
 * Progress is written to two places: Redis (live UI) and Postgres (the
 * transcript). The transcript is what lets someone diagnose a failed install
 * an hour later, which is exactly when they are most likely to ask for help.
 */
export function createInstallWorker(): Worker<InstallJob> {
  return new Worker<InstallJob>(
    'install',
    async (job) => {
      const { serverUid, mode, startAfter } = job.data;
      const server = await loadServer(serverUid);
      const adapter = getAdapter(server.gameId);
      const runtime = getRuntime(server.node);

      const report = async (phase: InstallPhase, message: string, percent = 0) => {
        await publishInstallProgress({ serverId: serverUid, phase, percent, message, at: Date.now() });
        await prisma.installLog.create({ data: { serverId: server.id, phase, message } });
        await job.updateProgress(percent);
      };

      const verb =
        mode === 'update' ? 'Updating' : mode === 'reinstall' ? 'Reinstalling' : 'Installing';

      await setServerState(serverUid, mode === 'update' ? 'updating' : 'installing');
      await report('queued', `${verb}…`, 0);

      try {
        // Worlds and configs are the user's data. Reinstall/update replace
        // known server binaries only — SteamCMD games update in place and
        // those paths are not in the clear list, so saves survive either way.
        if (mode === 'reinstall' || mode === 'update') {
          await report('preparing', 'Preparing the existing installation…', 3);
          await clearInstallArtifacts(localDataPath(server.dataPath));
        }

        // Resolve "latest" to something concrete and record it, so the server
        // does not silently change version on the next restart.
        const resolved = await adapter.resolveVersion(server.variantId, server.version);

        // Ask the publisher which runtime this version needs, once, here —
        // startup is synchronous and would otherwise have to guess forever.
        const runtimeMajor = adapter.detectRuntime
          ? await adapter.detectRuntime(server.variantId, resolved.id)
          : null;
        if (runtimeMajor) await report('resolving_version', `Needs Java ${runtimeMajor}.`, 12);

        await prisma.server.update({
          where: { id: server.id },
          data: { version: resolved.id, build: resolved.build ?? null, javaMajor: runtimeMajor },
        });

        const settings = { ...((server.settings ?? {}) as Record<string, unknown>) };
        const stagingId =
          typeof settings.modpack_staging_id === 'string' ? settings.modpack_staging_id.trim() : '';
        if (server.variantId === 'custom-modpack' && stagingId) {
          await report('preparing', 'Attaching the modpack you uploaded…', 4);
          await materializeStagedModpack(stagingId, localDataPath(server.dataPath));
          // Staging is single-use; clear the id so a reinstall does not look for it.
          settings.modpack_staging_id = '';
          await prisma.server.update({
            where: { id: server.id },
            data: { settings: settings as never },
          });
        }

        const ctx = buildContext({
          ...server,
          settings,
          version: resolved.id,
          build: resolved.build ?? null,
          javaMajor: runtimeMajor,
        });
        const tools = createInstallTools({
          dataPath: localDataPath(server.dataPath),
          runtime,
          onLine: (line) => {
            void publishInstallProgress({
              serverId: serverUid,
              phase: 'downloading',
              percent: -1,
              message: line,
              at: Date.now(),
            });
          },
        });

        await adapter.install(ctx, tools, {
          phase: (phase, message, percent) => report(phase, message, percent ?? 0),
          log: (message) => report('downloading', message, -1),
        });

        // Install writes as the API user (often root). The game container runs
        // as uid 1000 — without this, mods fail to rewrite config/* on boot.
        await report('configuring', 'Setting file permissions…', 97);
        await chownTreeForGame(localDataPath(server.dataPath));

        await prisma.server.update({
          where: { id: server.id },
          data: { installedAt: new Date(), crashCount: 0 },
        });

        await report('done', `${verb} finished.`, 100);
        await setServerState(serverUid, 'offline');

        const action =
          mode === 'update'
            ? 'server.update'
            : mode === 'reinstall'
              ? 'server.reinstall'
              : 'server.install';
        await recordActivity({
          serverId: server.id,
          action,
          message: `${verb} ${adapter.name} ${resolved.label}.`,
        });

        if (startAfter) {
          await startServer(serverUid);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, serverUid }, 'install failed');

        await publishInstallProgress({
          serverId: serverUid,
          phase: 'failed',
          percent: 0,
          message: `${verb} failed.`,
          error: message,
          at: Date.now(),
        });
        await prisma.installLog.create({
          data: { serverId: server.id, phase: 'failed', message },
        });
        await setServerState(serverUid, 'install_failed', { message });

        throw error;
      }
    },
    {
      connection: queueConnection,
      // Installs are disk and network bound; two at once keeps a modest box
      // responsive while still overlapping a download with an extraction.
      concurrency: 2,
    },
  );
}

/**
 * Removes server binaries and loader artifacts while preserving anything the
 * player created. The allowlist approach (delete known artifacts) is safer
 * than a denylist: an unrecognised folder survives a reinstall.
 *
 * Steam game files are intentionally absent — SteamCMD updates them in place
 * and wiping them would only force a full re-download.
 */
async function clearInstallArtifacts(dataPath: string): Promise<void> {
  const disposable = [
    'server.jar',
    'libraries',
    'versions',
    'run.sh',
    'run.bat',
    'user_jvm_args.txt',
    'unix_args.txt',
    '.serverforge',
  ];

  for (const entry of disposable) {
    await fs.rm(path.join(dataPath, entry), { recursive: true, force: true }).catch(() => undefined);
  }
}
