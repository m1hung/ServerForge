import fs from 'node:fs/promises';
import path from 'node:path';
import {
  badRequest,
  conflict,
  isSafeFileName,
  notFound,
  PathEscapeError,
  relativeTo,
  resolveWithin,
  unprocessable,
} from '@serverforge/core';

/**
 * The file manager.
 *
 * Two rules govern this whole module:
 *   1. Every path comes from the user and is resolved through `resolveWithin`.
 *   2. Symlinks are never followed out of the server directory — `lstat` is
 *      used everywhere `stat` would be tempting, because a symlink to /etc
 *      would otherwise be readable through the browser.
 */

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: number;
  /** Best-effort text/binary hint so the UI knows whether to offer the editor. */
  editable: boolean;
}

/** Files we refuse to serve through the editor regardless of extension. */
const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.properties', '.yml', '.yaml', '.json', '.json5', '.toml', '.ini', '.cfg', '.conf',
  '.log', '.md', '.sh', '.bat', '.xml', '.csv', '.tsv', '.env', '.lua', '.js', '.mcmeta', '.snbt',
]);

function wrapPathError(error: unknown): never {
  if (error instanceof PathEscapeError) throw badRequest('That path is not inside this server.');
  throw error;
}

export async function listDirectory(root: string, relative: string): Promise<FileEntry[]> {
  let target: string;
  try {
    target = resolveWithin(root, relative);
  } catch (error) {
    wrapPathError(error);
  }

  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) throw notFound('That folder');
  if (!stat.isDirectory()) throw badRequest('That path is a file, not a folder.');

  const entries = await fs.readdir(target, { withFileTypes: true });

  const results = await Promise.all(
    entries.map(async (entry): Promise<FileEntry> => {
      const full = path.join(target, entry.name);
      const entryStat = await fs.lstat(full).catch(() => null);
      const isSymlink = entry.isSymbolicLink();
      const isDirectory = entry.isDirectory();
      const size = entryStat?.size ?? 0;

      return {
        name: entry.name,
        path: relativeTo(root, full),
        isDirectory,
        isSymlink,
        size,
        modifiedAt: entryStat?.mtimeMs ?? 0,
        editable: !isDirectory && !isSymlink && size <= MAX_EDITABLE_BYTES && looksTextual(entry.name),
      };
    }),
  );

  // Folders first, then alphabetical — the ordering people expect from a
  // file browser, and stable regardless of what the filesystem returns.
  return results.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

export async function readFileContents(root: string, relative: string): Promise<string> {
  let target: string;
  try {
    target = resolveWithin(root, relative);
  } catch (error) {
    wrapPathError(error);
  }

  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) throw notFound('That file');
  if (stat.isSymbolicLink()) throw badRequest('Links cannot be opened in the editor.');
  if (stat.isDirectory()) throw badRequest('That is a folder, not a file.');
  if (stat.size > MAX_EDITABLE_BYTES) {
    throw unprocessable(
      'That file is too large to open in the editor.',
      { sizeBytes: stat.size, limitBytes: MAX_EDITABLE_BYTES },
    );
  }

  return fs.readFile(target, 'utf8');
}

export async function writeFileContents(
  root: string,
  relative: string,
  contents: string,
): Promise<void> {
  let target: string;
  try {
    target = resolveWithin(root, relative);
  } catch (error) {
    wrapPathError(error);
  }

  const stat = await fs.lstat(target).catch(() => null);
  if (stat?.isDirectory()) throw badRequest('That is a folder, not a file.');
  if (stat?.isSymbolicLink()) throw badRequest('Links cannot be edited.');

  await fs.mkdir(path.dirname(target), { recursive: true });
  // Write-then-rename: a crash mid-save must not truncate a working config.
  const temp = `${target}.sf-tmp`;
  await fs.writeFile(temp, contents, 'utf8');
  await fs.chown(temp, 1000, 1000).catch(() => undefined);
  await fs.rename(temp, target);
}

export async function createDirectory(root: string, relative: string, name: string): Promise<void> {
  if (!isSafeFileName(name)) throw badRequest('That folder name contains characters that are not allowed.');
  try {
    const target = resolveWithin(root, path.posix.join(relative, name));
    await fs.mkdir(target, { recursive: false });
    await fs.chown(target, 1000, 1000).catch(() => undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw conflict('Something with that name already exists here.');
    }
    wrapPathError(error);
  }
}

export async function renameEntry(root: string, from: string, to: string): Promise<void> {
  const target = path.posix.basename(to);
  if (!isSafeFileName(target)) throw badRequest('That name contains characters that are not allowed.');

  try {
    const source = resolveWithin(root, from);
    const destination = resolveWithin(root, to);

    if (await pathExists(destination)) {
      throw conflict('Something with that name already exists here.');
    }
    await fs.rename(source, destination);
  } catch (error) {
    if (error instanceof PathEscapeError) wrapPathError(error);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('That file');
    throw error;
  }
}

export async function deleteEntries(root: string, paths: string[]): Promise<number> {
  let deleted = 0;
  for (const relative of paths) {
    try {
      const target = resolveWithin(root, relative);
      // Deleting the server root itself would leave an unstartable server
      // with a row in the database pointing at nothing.
      if (path.resolve(target) === path.resolve(root)) {
        throw badRequest('The server folder itself cannot be deleted here.');
      }
      await fs.rm(target, { recursive: true, force: true });
      deleted++;
    } catch (error) {
      if (error instanceof PathEscapeError) wrapPathError(error);
      throw error;
    }
  }
  return deleted;
}

/** Resolves a path for download, ensuring it is a regular file. */
export async function resolveDownload(
  root: string,
  relative: string,
): Promise<{ absolutePath: string; fileName: string; size: number }> {
  let target: string;
  try {
    target = resolveWithin(root, relative);
  } catch (error) {
    wrapPathError(error);
  }

  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) throw notFound('That file');
  if (!stat.isFile()) throw badRequest('Only files can be downloaded.');

  return { absolutePath: target, fileName: path.basename(target), size: stat.size };
}

/** Destination for an upload, with the name sanitised. */
export function resolveUploadTarget(root: string, relative: string, fileName: string): string {
  const safe = path.basename(fileName);
  if (!isSafeFileName(safe)) throw badRequest('That file name contains characters that are not allowed.');
  try {
    return resolveWithin(root, path.posix.join(relative, safe));
  } catch (error) {
    wrapPathError(error);
  }
}

function looksTextual(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  // Extensionless config files are common (eula.txt is not, but banned-ips is).
  return ext === '' && name.length < 40;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}
