import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openServerFile } from '../apps/api/src/lib/server-files.js';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-open-race-')); await fs.mkdir(path.join(root, 'game/sub'), { recursive: true }); await fs.mkdir(path.join(root, 'outside')); await fs.writeFile(path.join(root, 'game/sub/file.txt'), 'world'); await fs.writeFile(path.join(root, 'outside/file.txt'), 'panel-secret'); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
it('rejects a parent directory exchanged for an external symlink between validation and open', async () => {
  const original = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    await fs.rename(path.join(root, 'game/sub'), path.join(root, 'game/original'));
    await fs.symlink(path.join(root, 'outside'), path.join(root, 'game/sub'));
    return original(...args);
  });
  await expect(openServerFile(path.join(root, 'game'), 'sub/file.txt')).rejects.toThrow();
});
it('reads the validated descriptor even when the original path later changes', async () => {
  const file = await openServerFile(path.join(root, 'game'), 'sub/file.txt');
  try {
    await fs.rename(path.join(root, 'game/sub'), path.join(root, 'game/original'));
    await fs.symlink(path.join(root, 'outside'), path.join(root, 'game/sub'));
    expect(await file.readFile('utf8')).toBe('world');
  } finally { await file.close(); }
});
