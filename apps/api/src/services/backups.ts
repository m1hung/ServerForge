import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { conflict, notFound } from '@serverforge/core';
import { prisma, uid as makeUid } from '@serverforge/db';
import { logger } from '../lib/logger.js';
import { chownTreeForGame } from '../lib/ownership.js';
import { recordActivity } from '../lib/events.js';
import { localBackupPath, localDataPath } from '../lib/storage-paths.js';

/**
 * Backups.
 *
 * Plain gzipped tar rather than a bespoke format, deliberately: a user must
 * be able to download a backup and open it with tools they already have,
 * including after they stop using this panel. Lock-in through file format is
 * not a feature.
 */

/** Never worth archiving: regenerated on start, or huge and disposable. */
const DEFAULT_EXCLUDES = [
  './logs',
  './crash-reports',
  './cache',
  './.serverforge',
  './libraries',
  './versions',
  './Pal/Saved/Logs',
  './steamapps',
];

export async function createBackupRecord(
  serverId: string,
  input: { name?: string; scheduleId?: string },
) {
  const running = await prisma.backup.count({
    where: { serverId, state: { in: ['pending', 'running'] } },
  });
  if (running > 0) {
    throw conflict(
      'A backup is already running for this server.',
      'Wait for it to finish — running two at once would slow the server down.',
    );
  }

  return prisma.backup.create({
    data: {
      uid: makeUid(),
      serverId,
      name: input.name?.trim() || `Backup ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      state: 'pending',
      scheduleId: input.scheduleId ?? null,
    },
  });
}

export async function runBackup(input: {
  serverUid: string;
  backupUid: string;
  ignore: string[];
}): Promise<void> {
  const backup = await prisma.backup.findUnique({
    where: { uid: input.backupUid },
    include: { server: { include: { node: true } } },
  });
  if (!backup) throw notFound('That backup');

  const server = backup.server;
  const backupDir = localBackupPath(path.join(server.node.backupRoot, server.uid));
  const dataPath = localDataPath(server.dataPath);
  const fileName = `${backup.uid}.tar.gz`;
  const filePath = path.join(backupDir, fileName);

  await fs.mkdir(backupDir, { recursive: true });
  await prisma.backup.update({
    where: { id: backup.id },
    data: { state: 'running', startedAt: new Date() },
  });

  try {
    const excludes = [...DEFAULT_EXCLUDES, ...input.ignore.map((p) => `./${p.replace(/^\.?\//, '')}`)];
    await tarDirectory(dataPath, filePath, excludes);

    const stat = await fs.stat(filePath);
    const checksum = await sha256Of(filePath);

    await prisma.backup.update({
      where: { id: backup.id },
      data: {
        state: 'completed',
        filePath: path.join(server.uid, fileName),
        sizeBytes: BigInt(stat.size),
        checksum,
        finishedAt: new Date(),
      },
    });

    await recordActivity({
      serverId: server.id,
      action: 'backup.create',
      message: `Backup "${backup.name}" completed.`,
      metadata: { sizeBytes: stat.size },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error, backupUid: backup.uid }, 'backup failed');

    await fs.rm(filePath, { force: true }).catch(() => undefined);
    await prisma.backup.update({
      where: { id: backup.id },
      data: { state: 'failed', error: message, finishedAt: new Date() },
    });
    throw error;
  }
}

/**
 * Restores in place after stopping the server.
 *
 * The existing directory is moved aside rather than deleted until the restore
 * succeeds — a failed restore that also destroyed the current world would be
 * the worst possible outcome of a "restore" button.
 */
export async function runRestore(input: { serverUid: string; backupUid: string }): Promise<void> {
  const backup = await prisma.backup.findUnique({
    where: { uid: input.backupUid },
    include: { server: { include: { node: true } } },
  });
  if (!backup || backup.state !== 'completed' || !backup.filePath) {
    throw conflict('That backup cannot be restored because it did not finish successfully.');
  }

  const server = backup.server;
  const archivePath = localBackupPath(path.join(server.node.backupRoot, backup.filePath));
  const dataPath = localDataPath(server.dataPath);
  const staging = `${dataPath}.restoring`;
  const previous = `${dataPath}.previous`;

  const { stopServer } = await import('./servers.js');
  const { setServerState } = await import('../lib/events.js');

  if (['running', 'starting'].includes(server.state)) {
    await stopServer(server.uid, { force: false });
  }
  await setServerState(server.uid, 'restoring');

  try {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });
    await untarInto(archivePath, staging);

    await fs.rm(previous, { recursive: true, force: true });
    await fs.rename(dataPath, previous);
    await fs.rename(staging, dataPath);
    await fs.rm(previous, { recursive: true, force: true });

    await chownTreeForGame(dataPath);

    await recordActivity({
      serverId: server.id,
      action: 'backup.restore',
      message: `Restored from backup "${backup.name}".`,
    });
    await setServerState(server.uid, 'offline');
  } catch (error) {
    logger.error({ error, serverUid: server.uid }, 'restore failed');
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    // Put the original back if we got as far as moving it.
    if (await exists(previous)) {
      await fs.rm(dataPath, { recursive: true, force: true }).catch(() => undefined);
      await fs.rename(previous, dataPath).catch(() => undefined);
    }
    await setServerState(server.uid, 'offline', { message: 'Restore failed — nothing was changed.' });
    throw error;
  }
}

export async function deleteBackup(backupUid: string): Promise<void> {
  const backup = await prisma.backup.findUnique({
    where: { uid: backupUid },
    include: { server: { include: { node: true } } },
  });
  if (!backup) throw notFound('That backup');

  if (backup.filePath) {
    const full = localBackupPath(path.join(backup.server.node.backupRoot, backup.filePath));
    await fs.rm(full, { force: true }).catch((error) =>
      logger.warn({ error, backupUid }, 'could not remove backup file'),
    );
  }
  await prisma.backup.delete({ where: { id: backup.id } });
}

/** Keeps the newest `retain` backups from a schedule, deleting the rest. */
export async function pruneScheduleBackups(scheduleId: string, retain: number): Promise<number> {
  const backups = await prisma.backup.findMany({
    where: { scheduleId, state: 'completed' },
    orderBy: { createdAt: 'desc' },
    skip: retain,
  });

  for (const backup of backups) await deleteBackup(backup.uid);
  return backups.length;
}

export async function backupFilePath(backupUid: string): Promise<string> {
  const backup = await prisma.backup.findUnique({
    where: { uid: backupUid },
    include: { server: { include: { node: true } } },
  });
  if (!backup?.filePath) throw notFound('That backup file');
  return localBackupPath(path.join(backup.server.node.backupRoot, backup.filePath));
}

// ────────────────────────────────────────────────────────────────── helpers ──

function tarDirectory(source: string, dest: string, excludes: string[]): Promise<void> {
  const args = [
    '--create',
    '--gzip',
    // Errors on individual files (a world file being rewritten mid-backup)
    // should warn, not abort a 10 GB archive at 99%.
    '--warning=no-file-changed',
    '--warning=no-file-removed',
    ...excludes.map((pattern) => `--exclude=${pattern}`),
    '--file',
    dest,
    '--directory',
    source,
    '.',
  ];
  return runProcess('tar', args, [0, 1]);
}

function untarInto(archive: string, dest: string): Promise<void> {
  return runProcess('tar', ['--extract', '--gzip', '--file', archive, '--directory', dest], [0]);
}

function runProcess(command: string, args: string[], okExitCodes: number[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      // tar exits 1 for "some files changed while reading", which is normal
      // on a live server and not a reason to fail the backup.
      if (okExitCodes.includes(code ?? -1)) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function sha256Of(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
