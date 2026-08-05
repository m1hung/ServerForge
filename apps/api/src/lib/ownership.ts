import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * UID/GID the game containers run as (`User: '1000:1000'` in the Docker driver).
 *
 * The API process typically runs as root and writes install artifacts as root;
 * without a matching chown the JVM cannot update configs under `config/`.
 */
export const GAME_UID = 1000;
export const GAME_GID = 1000;

/** Chown a single path; warn (don't throw) when the panel is unprivileged. */
export async function chownForGame(target: string): Promise<void> {
  await fs.chown(target, GAME_UID, GAME_GID).catch((error) => {
    logger.warn({ error, target }, 'could not chown path for game user — running as non-root?');
  });
}

/**
 * Recursively chown a server data tree to the game container user.
 *
 * Symlinks are skipped so a pack cannot trick the walk into touching host paths.
 */
export async function chownTreeForGame(root: string): Promise<void> {
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    await chownForGame(current);

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      await chownForGame(full);
    }
  }
}
