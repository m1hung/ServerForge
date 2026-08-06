import fs from 'node:fs/promises';
import path from 'node:path';
import { registerAdapter } from '../registry.js';
import type { GameAdapter } from '../types.js';
import { compileManifest } from './compile.js';
import { ManifestError } from './validate.js';
import type { GameManifest } from './types.js';

/**
 * Reads game manifests from a directory.
 *
 * This is what makes adding a game *data* rather than a rebuild: drop a
 * `.json` file in the games directory, restart, and it is in the deploy
 * wizard.
 *
 * Loading is deliberately not fatal. A panel that refuses to start because one
 * manifest has a typo takes management of every running server with it, which
 * is a wildly disproportionate response to a bad file. Each failure is
 * collected and that file is skipped.
 *
 * The compensating rule is that failures must be *loud*. The result names each
 * file and every problem in it, and the caller is expected to report that at
 * startup — a game silently missing from the wizard is the outcome worth
 * designing against.
 */

export interface ManifestLoadResult {
  loaded: { id: string; file: string }[];
  failed: { file: string; message: string }[];
}

export interface LoadManifestsOptions {
  /** Defaults to the real registry. Injectable so tests need no global state. */
  register?: (adapter: GameAdapter) => void;
}

export async function loadManifestsFrom(
  dir: string,
  options: LoadManifestsOptions = {},
): Promise<ManifestLoadResult> {
  const register = options.register ?? registerAdapter;
  const result: ManifestLoadResult = { loaded: [], failed: [] };

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    // No directory is the normal case for a panel nobody has added a game to.
    return result;
  }

  // Sorted so two manifests colliding on an id fail the same way on every
  // boot, rather than depending on the order the filesystem hands them back.
  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith('.json')) continue;

    try {
      const manifest = await readManifest(path.join(dir, entry));
      // compileManifest validates; register rejects a duplicate id.
      register(compileManifest(manifest));
      result.loaded.push({ id: manifest.id, file: entry });
    } catch (error) {
      result.failed.push({ file: entry, message: describeFailure(error) });
    }
  }

  return result;
}

async function readManifest(file: string): Promise<GameManifest> {
  const text = await fs.readFile(file, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`not valid JSON — ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the file must contain a single JSON object describing one game.');
  }

  return parsed as GameManifest;
}

/** One problem per line, indented, because most failures have several. */
export function describeFailure(error: unknown): string {
  if (error instanceof ManifestError) {
    return error.issues.map((issue) => `\n      - ${issue}`).join('');
  }
  return error instanceof Error ? error.message : String(error);
}
