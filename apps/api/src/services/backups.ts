import fs from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { z } from 'zod';
import { prisma, uid, type Server, type Backup } from '@serverforge/db';
import { badRequest, conflict, safeExtractTarget, portableGameLink, validateArchivePaths, type ArchivePath } from '@serverforge/core';
import { config } from '../lib/config.js';
import { localDataPath } from '../lib/storage-paths.js';
import { serverFile, prepareServerOwnership } from '../lib/server-files.js';
import { fileChecksum } from './file-manager.js';
import { runtime, startServer, stopServer } from '../routes/servers.js';
import { activity } from './server-events.js';
import { requireFreeSpace } from '../lib/storage-space.js';

export const savedConfigurationSchema = z.object({
  gameId: z.string(),
  variantId: z.string(),
  version: z.string(),
  build: z.string().nullable(),
  javaMajor: z.number().nullable(),
  settings: z.record(z.union([z.string(), z.number(), z.boolean()])),
  environment: z.record(z.string()),
  startupOverride: z.string().nullable(),
  javaFlagsPreset: z.string(),
  customJavaFlags: z.string().nullable(),
  memoryMib: z.number(),
  cpuCores: z.number(),
  diskMib: z.number(),
  swapMib: z.number().nullable(),
  ioWeight: z.number(),
});
export type SavedConfiguration = z.infer<typeof savedConfigurationSchema>;
export function savedConfiguration(server: Server) {
  return savedConfigurationSchema.parse(server);
}
export function operationRoot(serverUid: string) {
  return path.join(config.dataRoot, '.operations', serverUid);
}
export async function backupFile(backup: Pick<Backup, 'filePath'>) {
  if (!backup.filePath) throw badRequest('This backup has no archive.');
  return serverFile(config.backupRoot, backup.filePath);
}
export async function archiveDirectory(root: string, destination: string) {
  let count = 0;
  let invalid: unknown;
  const entries: ArchivePath[] = [];
  await tar.c(
    {
      cwd: root,
      file: destination,
      gzip: true,
      portable: true,
      strict: true,
      onWriteEntry(entry) {
        try { if (entry.type === 'SymbolicLink') entry.linkpath = portableGameLink(entry.path, entry.linkpath || ''); }
        catch (error) { invalid ||= error; }
        entries.push({ path: entry.path, type: entry.type || '', linkpath: entry.linkpath });
      },
      filter(entry, stat) {
        if (invalid) return false;
        try {
          safeExtractTarget(root, entry);
          if (
            !('isFile' in stat) ||
            (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink())
          )
            throw badRequest(`Backup cannot include special files: ${entry}`);
          if (++count > 500000) throw badRequest('Backup exceeds the 500,000-entry limit.');
          return true;
        } catch (error) {
          invalid = error;
          return false;
        }
      },
    },
    ['.'],
  );
  if (invalid) throw invalid;
  validateArchivePaths(entries);
}
export async function extractBackup(archive: string, destination: string) {
  let bytes = 0,
    count = 0;
  let invalid: unknown;
  const entries: ArchivePath[] = [];
  await fs.mkdir(destination, { recursive: true });
  const disk = await fs.statfs(destination);
  const available = Number(disk.bavail) * Number(disk.bsize);
  // Tar invokes callbacks from its stream. Throw only after the stream settles.
  await tar.t({
    file: archive,
    strict: true,
    onReadEntry(entry) {
      if (invalid) return;
      try {
        safeExtractTarget(destination, entry.path);
        entries.push({ path: entry.path, type: entry.type, linkpath: entry.linkpath });
        bytes += entry.size;
        if (++count > 500000 || bytes > available - 64 * 1024 ** 2)
          throw badRequest('Not enough free disk space to restore this archive.');
      } catch (error) {
        invalid = error;
      }
    },
  });
  if (invalid) throw invalid;
  validateArchivePaths(entries);
  await tar.x({ file: archive, cwd: destination, strict: true, noChmod: true, noMtime: true });
}
export async function createBackup(
  server: Server,
  name = '',
  scheduleId?: string,
  resume = true,
): Promise<Backup> {
  if (!['running', 'offline', 'crashed'].includes(server.state))
    throw conflict('Wait for the current operation before making a backup.');
  await requireFreeSpace(config.backupRoot);
  const record = await prisma.backup.create({
    data: {
      uid: uid(),
      serverId: server.id,
      name: name || `Backup ${new Date().toLocaleString('en-US')}`,
      state: 'running',
      startedAt: new Date(),
      scheduleId,
      configuration: savedConfiguration(server),
    },
  });
  const relative = `${server.uid}/${record.uid}.tar.gz`;
  const file = await serverFile(config.backupRoot, relative);
  const running = server.state === 'running';
  let stopped = false;
  try {
    if (running) {
      await stopServer(server.id, { forceAfterTimeout: false });
      stopped = true;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await archiveDirectory(localDataPath(server.dataPath), `${file}.partial`);
    const checksum = await fileChecksum(`${file}.partial`);
    const stat = await fs.stat(`${file}.partial`);
    await fs.rename(`${file}.partial`, file);
    const completed = await prisma.backup.update({
      where: { id: record.id },
      data: {
        state: 'completed',
        filePath: relative,
        checksum,
        sizeBytes: stat.size,
        finishedAt: new Date(),
      },
    });
    await activity(server.id, 'backup.completed', `Backup ready: ${completed.name}`);
    return completed;
  } catch (error) {
    await fs.rm(`${file}.partial`, { force: true });
    await prisma.backup.update({
      where: { id: record.id },
      data: {
        state: 'failed',
        error: error instanceof Error ? error.message : 'Backup failed',
        finishedAt: new Date(),
      },
    });
    throw error;
  } finally {
    if (stopped && resume) await startServer(server.id);
  }
}

/** Journal the swap so a process restart can restore the original files and settings. */
export async function replaceServerFiles(
  server: Server,
  staged: string,
  configuration: SavedConfiguration,
  operation: 'restoring' | 'updating' | 'installing' = 'restoring',
) {
  const work = operationRoot(server.uid),
    live = localDataPath(server.dataPath),
    previous = path.join(work, 'previous');
  const journal = path.join(work, 'swap.json');
  if (await fs.lstat(previous).catch(() => null))
    throw conflict('A previous operation needs recovery before another restore or update.');
  // Finish ownership work while the directory still has its staging name.
  // No helper bind mount should survive into the atomic replacement.
  await prepareServerOwnership(staged);
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(
    journal,
    JSON.stringify({ original: savedConfiguration(server), committed: false }),
    { flag: 'wx', mode: 0o600 },
  );
  try {
    await prisma.server.update({ where: { id: server.id }, data: { state: operation } });
    if (server.containerId) await runtime.remove(server.containerId, { force: false });
    await fs.rename(live, previous);
    await fs.rename(staged, live);
    await prisma.server.update({
      where: { id: server.id },
      data: { ...configuration, state: 'offline', containerId: null },
    });
    await fs.writeFile(`${journal}.tmp`, JSON.stringify({ committed: true }), { mode: 0o600 });
    await fs.rename(`${journal}.tmp`, journal);
  } catch (error) {
    await recoverSwap(server);
    throw error;
  }
  await recoverSwap(server);
}
export async function recoverSwap(server: Server) {
  const work = operationRoot(server.uid),
    live = localDataPath(server.dataPath),
    previous = path.join(work, 'previous');
  const journal = path.join(work, 'swap.json');
  const text = await fs.readFile(journal, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!text) return;
  const state = JSON.parse(text) as { committed: boolean; original?: unknown };
  if (!state.committed) {
    const original = savedConfigurationSchema.parse(state.original);
    if (server.containerId) await runtime.stop(server.containerId);
    if (await fs.lstat(previous).catch(() => null)) {
      await fs.rm(live, { recursive: true, force: true });
      await fs.rename(previous, live);
    }
    await prisma.server.update({
      where: { id: server.id },
      data: { ...original, state: 'offline', containerId: null },
    });
  } else await fs.rm(previous, { recursive: true, force: true });
  await fs.rm(journal, { force: true });
}
export async function restoreBackup(server: Server, backup: Backup) {
  if (backup.serverId !== server.id || backup.state !== 'completed' || !backup.checksum)
    throw badRequest('Choose a completed backup for this server.');
  const configuration = savedConfigurationSchema.parse(backup.configuration);
  const archive = await backupFile(backup);
  if ((await fileChecksum(archive)) !== backup.checksum)
    throw badRequest('Backup checksum failed. No server files have been changed.');
  const staged = path.join(operationRoot(server.uid), `restore-${uid()}`);
  try {
    await extractBackup(archive, staged);
    await createBackup(server, `Before restore: ${backup.name}`, undefined, false);
    await replaceServerFiles(server, staged, configuration);
    await activity(
      server.id,
      'backup.restored',
      `Restored ${backup.name}. Server left offline for review.`,
    );
  } finally {
    await fs.rm(staged, { recursive: true, force: true });
  }
}
