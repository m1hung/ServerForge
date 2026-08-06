import path from 'node:path';

/**
 * Path containment for the file manager.
 *
 * The file browser takes user-supplied paths straight from the URL. Every
 * one of them goes through `resolveWithin`, which is the only place allowed
 * to turn an untrusted string into a real filesystem path.
 */

export class PathEscapeError extends Error {
  constructor(readonly attempted: string) {
    super('That path is outside the server directory.');
    this.name = 'PathEscapeError';
  }
}

/**
 * Resolves `relative` inside `root`, throwing if the result escapes.
 *
 * Handles `..`, absolute inputs, backslashes, redundant separators, and
 * NUL bytes. Symlinks are *not* resolved here — that requires I/O and is
 * handled separately by the file service, which lstat's each component.
 */
export function resolveWithin(root: string, relative: string): string {
  if (relative.includes('\u0000')) throw new PathEscapeError(relative);

  const normalizedRoot = path.resolve(root);
  // Treat the input as always-relative: a leading "/" means "server root",
  // which is what users expect from a file browser breadcrumb.
  const cleaned = relative.replace(/\\/g, '/').replace(/^\/+/, '');
  const candidate = path.resolve(normalizedRoot, cleaned);

  if (candidate !== normalizedRoot && !candidate.startsWith(normalizedRoot + path.sep)) {
    throw new PathEscapeError(relative);
  }
  return candidate;
}

/** Inverse of `resolveWithin`: an absolute path back to a display path. */
export function relativeTo(root: string, absolute: string): string {
  const rel = path.relative(path.resolve(root), absolute);
  return rel === '' ? '/' : '/' + rel.split(path.sep).join('/');
}

// Control characters plus separators and Windows-reserved characters.
// Matching them is the entire purpose: a filename containing a control
// character is exactly what this exists to reject.
// Dots, spaces and dashes stay legal — `server.properties` must pass.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME = /[\u0000-\u001f/\\:*?"<>|]/;

/** Validates a single path segment for create/rename operations. */
export function isSafeFileName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name === '.' || name === '..') return false;
  if (UNSAFE_NAME.test(name)) return false;
  if (name.trim() !== name) return false;
  return true;
}

/**
 * Guards archive extraction (modpacks, backups, uploaded zips) against
 * zip-slip. Returns the destination path or throws.
 */
export function safeExtractTarget(root: string, entryName: string): string {
  if (path.isAbsolute(entryName) || entryName.includes('\u0000')) {
    throw new PathEscapeError(entryName);
  }
  return resolveWithin(root, entryName);
}
