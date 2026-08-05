import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { badRequest, notFound } from '@serverforge/core';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Temporary holding area for server-pack zips chosen in the deploy wizard
 * before a server row exists. Consumed once during install, then deleted.
 */

const STAGING_TTL_MS = 2 * 60 * 60 * 1000;

function stagingRoot(): string {
  return path.join(config.cacheRoot, 'modpack-staging');
}

function stagingPath(stagingId: string): string {
  if (!/^[a-f0-9]{24}$/.test(stagingId)) {
    throw badRequest('That upload reference is not valid.');
  }
  return path.join(stagingRoot(), `${stagingId}.zip`);
}

export async function saveStagedModpack(input: {
  stream: Readable;
  filename: string;
}): Promise<{ stagingId: string; filename: string }> {
  const filename = path.basename(input.filename);
  if (!/\.(zip|mrpack)$/i.test(filename)) {
    throw badRequest('Upload a .zip (or .mrpack) server pack.');
  }

  const stagingId = randomBytes(12).toString('hex');
  const dest = stagingPath(stagingId);
  await fs.mkdir(path.dirname(dest), { recursive: true });

  const temp = `${dest}.partial`;
  await pipeline(input.stream, createWriteStream(temp));
  await fs.rename(temp, dest);

  // Best-effort sidecar so we can show the original name in the wizard.
  await fs.writeFile(`${dest}.name`, filename, 'utf8').catch(() => undefined);

  return { stagingId, filename };
}

export async function stagedModpackExists(stagingId: string): Promise<boolean> {
  try {
    await fs.access(stagingPath(stagingId));
    return true;
  } catch {
    return false;
  }
}

/** Copies the staged archive into the server folder and deletes the staging file. */
export async function materializeStagedModpack(
  stagingId: string,
  serverDataPath: string,
  destRelative = '.serverforge/pack.zip',
): Promise<string> {
  const source = stagingPath(stagingId);
  try {
    await fs.access(source);
  } catch {
    throw notFound('That uploaded modpack');
  }

  const dest = path.join(serverDataPath, destRelative);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(source, dest);
  await fs.rm(source, { force: true });
  await fs.rm(`${source}.name`, { force: true }).catch(() => undefined);
  return destRelative;
}

/** Drop uploads older than the TTL so abandoned wizard sessions do not fill the disk. */
export async function purgeExpiredStagedModpacks(): Promise<number> {
  const root = stagingRoot();
  const entries = await fs.readdir(root).catch(() => [] as string[]);
  const cutoff = Date.now() - STAGING_TTL_MS;
  let removed = 0;

  for (const entry of entries) {
    if (!entry.endsWith('.zip')) continue;
    const full = path.join(root, entry);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || stat.mtimeMs > cutoff) continue;
    await fs.rm(full, { force: true }).catch((error) => {
      logger.warn({ error, full }, 'could not purge staged modpack');
    });
    await fs.rm(`${full}.name`, { force: true }).catch(() => undefined);
    removed += 1;
  }

  return removed;
}
