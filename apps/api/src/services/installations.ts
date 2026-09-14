import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma, uid, type Server, type InstallationAttempt } from '@serverforge/db';
import { getAdapter, type InstallTools } from '@serverforge/adapters';
import { conflict, notFound } from '@serverforge/core';
import { localDataPath } from '../lib/storage-paths.js';
import { serverFile } from '../lib/server-files.js';
import { requireFreeSpace } from '../lib/storage-space.js';
import { installToolsFor } from './install-tools.js';
import { operationRoot, replaceServerFiles, savedConfiguration } from './backups.js';
import { contextOf, runtime } from '../routes/servers.js';
import { beginServerOperation } from './server-lock.js';
import { selectGamePlatform } from './platform.js';
import { logger } from '../lib/logger.js';

const active = new Map<string, AbortController>();
const terminal = ['completed', 'failed', 'cancelled'];
export const latestInstallation = (serverId: string): Promise<InstallationAttempt | null> =>
  prisma.installationAttempt.findFirst({ where: { serverId }, orderBy: { createdAt: 'desc' } });
export function publicInstallation(attempt: Awaited<ReturnType<typeof latestInstallation>>) {
  if (!attempt) return null;
  const { stagingPath: _staging, sourcePackPath, ...visible } = attempt;
  return { ...visible, hasUploadedPack: !!sourcePackPath };
}

export async function queueInstallation(server: Server) {
  if (server.installedAt || !['installing', 'install_failed', 'creating'].includes(server.state))
    throw conflict('Only an unfinished initial installation can be retried.');
  const previous = await latestInstallation(server.id);
  if (previous && !terminal.includes(previous.state))
    throw conflict('An installation is already active.');
  const attemptUid = uid();
  const work = operationRoot(server.uid);
  const staged = path.join(work, `install-${attemptUid}`);
  const uploaded = path.join(work, 'uploaded-pack.zip');
  await fs.mkdir(work, { recursive: true, mode: 0o700 });
  const original = await serverFile(localDataPath(server.dataPath), '.serverforge/pack.zip');
  if (!(await fs.stat(uploaded).catch(() => null)) && (await fs.stat(original).catch(() => null))) {
    await fs.copyFile(original, `${uploaded}.partial`);
    await fs.rename(`${uploaded}.partial`, uploaded);
    await fs.chmod(uploaded, 0o600);
  }
  const sourcePackPath = await fs.stat(uploaded).then(
    () => uploaded,
    () => null,
  );
  if (sourcePackPath) await fs.rm(original, { force: true });
  const attempt = await prisma.installationAttempt.create({
    data: { uid: attemptUid, serverId: server.id, stagingPath: staged, sourcePackPath },
  });
  await prisma.server.update({ where: { id: server.id }, data: { state: 'installing' } });
  const controller = new AbortController();
  active.set(attempt.id, controller);
  try {
    await runInstallation(server.id, attempt.id, controller);
  } finally {
    active.delete(attempt.id);
  }
  return attempt;
}

async function runInstallation(serverId: string, attemptId: string, controller: AbortController) {
  const attempt = await prisma.installationAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  const signal = controller.signal;
  let committed = false;
  try {
    await prisma.installationAttempt.update({
      where: { id: attemptId },
      data: { state: 'running', startedAt: new Date() },
    });
    const server = await prisma.server.findUniqueOrThrow({
      where: { id: serverId },
      include: {
        allocations: true,
        node: true,
        owner: true,
        subusers: { include: { roles: true } },
      },
    });
    const adapter = getAdapter(server.gameId);
    const check = () => signal.throwIfAborted();
    check();
    await requireFreeSpace(attempt.stagingPath);
    await fs.mkdir(attempt.stagingPath, { recursive: true });
    if (attempt.sourcePackPath) {
      await fs.mkdir(path.join(attempt.stagingPath, '.serverforge'));
      await fs.copyFile(
        attempt.sourcePackPath,
        path.join(attempt.stagingPath, '.serverforge/pack.zip'),
      );
    }
    const resolved = await adapter.resolveVersion(server.variantId, server.version);
    const javaMajor = (await adapter.detectRuntime?.(server.variantId, resolved.id)) ?? null;
    const installing = {
      ...server,
      dataPath: attempt.stagingPath,
      version: resolved.id,
      build: resolved.build ?? null,
      javaMajor,
    };
    const platform = await selectGamePlatform(
      server.gameId,
      server.environment as Record<string, string>,
    );
    const base = installToolsFor(attempt.stagingPath, signal, platform);
    // Cooperative cancellation surrounds every adapter primitive; the final
    // journaled replacement deliberately runs without an abort signal.
    const tools = Object.fromEntries(
      Object.entries(base).map(([key, action]) => [
        key,
        async (...args: unknown[]) => {
          check();
          const result = await (action as (...args: unknown[]) => Promise<unknown>)(...args);
          check();
          return result;
        },
      ]),
    ) as unknown as InstallTools;
    await adapter.install(contextOf(installing), tools, {
      async phase(phase, message, percent) {
        check();
        await prisma.installationAttempt.update({
          where: { id: attemptId },
          data: {
            phase,
            message,
            ...(percent === undefined
              ? {}
              : { progress: Math.max(0, Math.min(99, Math.round(percent))) }),
          },
        });
        await prisma.installLog.create({ data: { serverId, phase, message } });
      },
      async runtime(detected) {
        check();
        if (detected.version) installing.version = detected.version;
        if (detected.javaMajor) installing.javaMajor = detected.javaMajor;
      },
      async log(message) {
        check();
        await prisma.installLog.create({ data: { serverId, phase: 'log', message } });
      },
    });
    await adapter.applySettings(contextOf(installing), tools);
    check();
    const finalized = await prisma.installationAttempt.updateMany({
      where: { id: attemptId, cancelRequestedAt: null, state: 'running' },
      data: {
        state: 'finalizing',
        phase: 'finalizing',
        progress: 99,
        message: 'Committing the installation safely…',
      },
    });
    if (!finalized.count) throw new Error('Installation cancelled.');
    await base.writeFile(
      '.serverforge/installation.json',
      JSON.stringify({ attemptUid: attempt.uid }),
    );
    await replaceServerFiles(
      server,
      attempt.stagingPath,
      savedConfiguration(installing),
      'installing',
    );
    committed = true;
    await completeInstallation(serverId, attemptId);
    await discardUploadedPack(server.id, server.uid);
  } catch (error) {
    logger.error('Installation attempt failed', { attempt: attempt.uid, error: error instanceof Error ? error.stack : String(error) });
    if (committed) throw error; // A restart can recover completion from the committed marker.
    const message = signal.aborted
      ? 'Installation cancelled. The uploaded pack is kept for retry.'
      : error instanceof Error
        ? error.message
        : String(error);
    await prisma.installationAttempt.update({
      where: { id: attemptId },
      data: {
        state: signal.aborted ? 'cancelled' : 'failed',
        error: message,
        finishedAt: new Date(),
      },
    });
    await prisma.server.update({ where: { id: serverId }, data: { state: 'install_failed' } });
    await prisma.installLog.create({ data: { serverId, phase: 'failed', message } });
  } finally {
    await fs.rm(attempt.stagingPath, { recursive: true, force: true });
  }
}

async function completeInstallation(serverId: string, attemptId: string) {
  await prisma.$transaction([
    prisma.server.update({
      where: { id: serverId },
      data: { state: 'offline', installedAt: new Date() },
    }),
    prisma.installationAttempt.update({
      where: { id: attemptId },
      data: {
        state: 'completed',
        progress: 100,
        error: null,
        message: 'Installation complete. The server is ready to start.',
        finishedAt: new Date(),
      },
    }),
  ]);
}

export async function cancelInstallation(serverId: string) {
  const attempt = await latestInstallation(serverId);
  if (!attempt) throw notFound('Installation');
  const result = await prisma.installationAttempt.updateMany({
    where: { id: attempt.id, state: { in: ['queued', 'running'] } },
    data: { cancelRequestedAt: new Date(), message: 'Cancelling at the next safe step…' },
  });
  if (!result.count)
    throw conflict(
      'Installation is finishing or has already ended. The final file replacement cannot be interrupted.',
    );
  active.get(attempt.id)?.abort(new Error('Installation cancelled.'));
}

export async function recoverInstallation(server: Server) {
  const attempt = await latestInstallation(server.id);
  if (attempt?.state === 'completed') await discardUploadedPack(server.id, server.uid);
  if (!attempt || terminal.includes(attempt.state)) return false;
  if (
    attempt.stagingPath !== path.join(operationRoot(server.uid), `install-${attempt.uid}`) ||
    (attempt.sourcePackPath &&
      attempt.sourcePackPath !== path.join(operationRoot(server.uid), 'uploaded-pack.zip'))
  )
    throw conflict('Installation paths need inspection before recovery.');
  await runtime.cleanupTemporary(attempt.stagingPath);
  const markerPath = await serverFile(
    localDataPath(server.dataPath),
    '.serverforge/installation.json',
  );
  const marker = await fs.readFile(markerPath, 'utf8').then(
    (text) => JSON.parse(text),
    () => null,
  );
  if (attempt.state === 'finalizing' && marker?.attemptUid === attempt.uid) {
    await completeInstallation(server.id, attempt.id);
    await discardUploadedPack(server.id, server.uid);
  } else {
    const message =
      'The panel restarted during installation. The uploaded pack is kept; retry starts with fresh files.';
    await prisma.installationAttempt.update({
      where: { id: attempt.id },
      data: { state: 'failed', error: message, finishedAt: new Date() },
    });
    await prisma.server.update({ where: { id: server.id }, data: { state: 'install_failed' } });
    await prisma.installLog.create({ data: { serverId: server.id, phase: 'failed', message } });
  }
  await fs.rm(attempt.stagingPath, { recursive: true, force: true });
  return true;
}

export async function removeFailedInstallation(server: Server) {
  const attempt = await latestInstallation(server.id);
  if (!attempt || !['failed', 'cancelled'].includes(attempt.state))
    throw conflict('Only a failed or cancelled attempt can be removed.');
  if (
    attempt.stagingPath !== path.join(operationRoot(server.uid), `install-${attempt.uid}`) ||
    (attempt.sourcePackPath &&
      attempt.sourcePackPath !== path.join(operationRoot(server.uid), 'uploaded-pack.zip'))
  )
    throw conflict('Installation paths need inspection before removal.');
  await discardUploadedPack(server.id, server.uid);
  await fs.rm(attempt.stagingPath, { recursive: true, force: true });
}

async function discardUploadedPack(serverId: string, serverUid: string) {
  await fs.rm(path.join(operationRoot(serverUid), 'uploaded-pack.zip'), { force: true });
  await prisma.installationAttempt.updateMany({ where: { serverId }, data: { sourcePackPath: null } });
}

export function startInstallation(server: Server) {
  return beginServerOperation(server.uid, async () => {
    try {
      return await queueInstallation(server);
    } catch (error) {
      const latest = await latestInstallation(server.id);
      if (latest?.state === 'finalizing') throw error;
      await prisma.server.update({ where: { id: server.id }, data: { state: 'install_failed' } });
      await prisma.installLog.create({
        data: {
          serverId: server.id,
          phase: 'failed',
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  });
}
