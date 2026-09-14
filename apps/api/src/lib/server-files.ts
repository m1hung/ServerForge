import fs from 'node:fs/promises';
import path from 'node:path';
import { PathEscapeError, resolveWithin } from '@serverforge/core';

/** Reject links as well as traversal, including links in parent directories. */
export async function serverFile(root: string, relative: string): Promise<string> {
  const target = resolveWithin(root, relative);
  let current = path.resolve(root);
  for (const part of ['', ...path.relative(current, target).split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new PathEscapeError(relative);
  }
  return target;
}

/** Install containers run as root; game containers run as uid 1000. */
export async function prepareServerOwnership(root: string): Promise<void> {
  if (process.getuid?.() !== 0) return;
  async function visit(file: string) {
    const stat = await fs.lstat(file);
    await fs.lchown(file, 1000, 1000);
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(file)) await visit(path.join(file, entry));
    }
  }
  await visit(root);
}
