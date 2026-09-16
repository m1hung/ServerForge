import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshotSource } from '../scripts/lib/candidate-source.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it('packages only committed source and refuses dirty input or an occupied output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-source-')); roots.push(root);
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
  git('init'); await fs.writeFile(path.join(repo, '.gitignore'), '.env\n');
  await fs.writeFile(path.join(repo, 'app.txt'), 'committed');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  await fs.writeFile(path.join(repo, '.env'), 'PLANTED_SECRET=never-export');
  const output = path.join(root, 'bundle'); const snapshot = await snapshotSource(repo, output);
  expect(snapshot.sourceRevision).toBe(git('rev-parse', 'HEAD'));
  expect(snapshot.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(await fs.readdir(path.join(output, 'source'))).toEqual(['.gitignore', 'app.txt']);
  await expect(snapshotSource(repo, output)).rejects.toThrow(/EEXIST/);
  await fs.writeFile(path.join(repo, 'app.txt'), 'uncommitted');
  await expect(snapshotSource(repo, path.join(root, 'dirty'))).rejects.toThrow(/Commit all source/);
  expect(await fs.readFile(path.join(output, 'source/app.txt'), 'utf8')).toBe('committed');
  git('checkout', '--', 'app.txt'); await fs.writeFile(path.join(repo, 'private.txt'), 'untracked');
  await expect(snapshotSource(repo, path.join(root, 'untracked'))).rejects.toThrow(/Commit all source/);
});
