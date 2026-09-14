import fs from 'node:fs/promises';
import path from 'node:path';
import { badRequest } from '@serverforge/core';

export const STORAGE_RESERVE_BYTES = 1024 ** 3;

export async function storageSpace(root: string) {
  let current = root;
  for (;;) {
    try {
      const stat = await fs.statfs(current);
      return { freeBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(current) === current)
        throw error;
      current = path.dirname(current);
    }
  }
}

export async function requireFreeSpace(root: string, additionalBytes = 0) {
  const space = await storageSpace(root);
  if (space.freeBytes < additionalBytes + STORAGE_RESERVE_BYTES)
    throw badRequest(
      'Not enough free storage for this operation while retaining 1 GiB of working space. Free space or choose another storage location.',
    );
  return space;
}
