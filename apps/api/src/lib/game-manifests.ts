import { loadManifestsFrom, type ManifestLoadResult } from '@serverforge/adapters';
import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Games added by the operator, as JSON files in `GAMES_ROOT`.
 *
 * The reading, validating and registering all live in the adapters package —
 * this is the part that knows where the directory is and how this process
 * reports things. See `manifest/load.ts` for why a bad file is skipped rather
 * than fatal.
 */

export async function loadGameManifests(): Promise<ManifestLoadResult> {
  return loadManifestsFrom(config.gamesRoot);
}

/** Writes the outcome to the log in a shape someone can act on. */
export function reportManifestLoad(result: ManifestLoadResult): void {
  for (const { id, file } of result.loaded) {
    logger.info({ game: id, file }, `loaded game manifest "${id}"`);
  }

  if (result.failed.length === 0) return;

  const count = result.failed.length;
  logger.error(
    `\n${count} game manifest${count === 1 ? '' : 's'} in ${config.gamesRoot} could not be loaded ` +
      `and ${count === 1 ? 'was' : 'were'} skipped.\n` +
      `Games defined in ${count === 1 ? 'it' : 'them'} will not appear in the deploy wizard.\n\n` +
      result.failed.map(({ file, message }) => `  • ${file}: ${message}`).join('\n') +
      '\n',
  );
}
