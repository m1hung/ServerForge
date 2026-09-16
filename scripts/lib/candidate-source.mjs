import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Freeze Git objects, never a working tree that can change during packaging. */
export async function snapshotSource(repo, output) {
  const git = (args) => execFileSync('git', args, { cwd: repo, maxBuffer: 32 * 1024 ** 2 });
  if (git(['status', '--porcelain', '--untracked-files=all']).length)
    throw new Error('Commit all source changes before packaging a candidate.');
  const sourceRevision = git(['rev-parse', 'HEAD']).toString().trim();
  const entries = git(['ls-tree', '-rz', '--full-tree', sourceRevision]).toString().split('\0').filter(Boolean);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output, { mode: 0o700 }); // EEXIST protects even an empty prior checkpoint.
  const source = path.join(output, 'source');
  await fs.mkdir(source, { mode: 0o700 });
  const sourceFiles = [];
  for (const entry of entries) {
    const split = entry.indexOf('\t');
    const metadata = entry.slice(0, split), name = entry.slice(split + 1);
    const [mode, type, sha] = metadata.split(' ');
    if (/[\r\n\t\\]/.test(name) || type !== 'blob' || !['100644', '100755'].includes(mode) ||
        /(^|\/)\.env($|\.(?!example$))/.test(name) || /^(data|config|backups|volumes)\//.test(name))
      throw new Error(`Refusing non-source or secret input: ${name}`);
    const contents = git(['cat-file', 'blob', sha]);
    const destination = path.join(source, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents, { mode: parseInt(mode, 8) & 0o777 });
    sourceFiles.push({ path: name, mode, sha256: createHash('sha256').update(contents).digest('hex') });
  }
  sourceFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { sourceRevision, sourceFiles, sourceDigest: createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex') };
}
