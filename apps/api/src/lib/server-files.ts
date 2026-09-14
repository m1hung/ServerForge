import fs from 'node:fs/promises';
import { constants } from 'node:fs';
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

/** A game can rename directories while the panel reads them. Verify the open
 * descriptor itself before reading bytes, closing the path-check/open race. */
export async function openServerFile(root: string, relative: string) {
  const target = await serverFile(root, relative);
  const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actualRoot = await fs.realpath(root);
    const actual = await fs.realpath(`/proc/self/fd/${file.fd}`);
    const within = path.relative(actualRoot, actual);
    if (!within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within) || !(await file.stat()).isFile())
      throw new PathEscapeError(relative);
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Game files belong to uid 1000; installation ownership is handled separately. */
export async function prepareServerOwnership(root: string): Promise<void> {
  if (process.getuid?.() !== 0) return;
  const { DockerRuntime } = await import('../runtime/docker.js');
  await new DockerRuntime().repairOwnership(root, '1000:1000');
}
