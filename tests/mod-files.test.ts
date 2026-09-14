import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  listMods,
  modSupport,
  requireStopped,
  setModEnabled,
  uploadMod,
} from '../apps/api/src/services/mods.js';
import { extractZip } from '../apps/api/src/lib/extract-zip.js';
import { downloadResponse } from '../apps/api/src/lib/download.js';
import { withServerLock } from '../apps/api/src/services/server-lock.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-mods-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const fixture = (name: string) => path.resolve('tests/fixtures/mod-zips', name);

describe('mod files', () => {
  it.each([
    ['minecraft-java', 'fabric', '.jar'],
    ['valheim', 'valheim-bepinex', '.dll'],
    ['palworld', 'palworld-modded', '.pak'],
  ])('uploads and reversibly disables a %s mod', async (game, variant, extension) => {
    const { directory, extensions } = modSupport(game, variant);
    expect(directory).toBeTruthy();
    const name = `example${extension}`;
    await uploadMod(root, directory!, extensions, name, Readable.from('mod contents'));
    await setModEnabled(root, directory!, extensions, name, false);
    expect(await listMods(root, directory!, extensions)).toEqual([
      { name: `${name}.disabled`, enabled: false, size: 12 },
    ]);
    await setModEnabled(root, directory!, extensions, `${name}.disabled`, true);
    expect(await fs.readFile(path.join(root, directory!, name), 'utf8')).toBe('mod contents');
  });

  it('manages nested mods from an existing pack without touching other files', async () => {
    await fs.mkdir(path.join(root, 'mods/nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'mods/nested/example.jar'), 'mod');
    await fs.writeFile(path.join(root, 'mods/README.txt'), 'keep');
    await setModEnabled(root, 'mods', ['.jar'], 'nested/example.jar', false);
    expect((await listMods(root, 'mods', ['.jar'])).map((file) => file.name)).toEqual([
      'nested/example.jar.disabled',
    ]);
    expect(await fs.readFile(path.join(root, 'mods/README.txt'), 'utf8')).toBe('keep');
  });

  it('rejects incompatible files, traversal, collisions and partial uploads', async () => {
    await expect(
      uploadMod(root, 'mods', ['.jar'], 'wrong.dll', Readable.from('x')),
    ).rejects.toThrow(/\.jar/);
    await expect(
      uploadMod(root, 'mods', ['.jar'], '../escape.jar', Readable.from('x')),
    ).rejects.toThrow();
    await uploadMod(root, 'mods', ['.jar'], 'test.jar', Readable.from('original'));
    await expect(
      uploadMod(root, 'mods', ['.jar'], 'test.jar', Readable.from('replacement')),
    ).rejects.toThrow(/already exists/);
    await setModEnabled(root, 'mods', ['.jar'], 'test.jar', false);
    await expect(
      uploadMod(root, 'mods', ['.jar'], 'test.jar', Readable.from('replacement')),
    ).rejects.toThrow(/already exists/);
    await expect(
      uploadMod(
        root,
        'mods',
        ['.jar'],
        'partial.jar',
        Object.assign(Readable.from('partial'), { truncated: true }),
      ),
    ).rejects.toThrow(/256 MiB/);
    expect(await fs.readFile(path.join(root, 'mods/test.jar.disabled'), 'utf8')).toBe('original');
    expect(await fs.readdir(path.join(root, '.serverforge/uploads'))).toEqual([]);
    expect((await listMods(root, 'mods', ['.jar'])).length).toBe(1);
  });

  it('rejects symlink directories and file targets', async () => {
    await fs.mkdir(path.join(root, 'outside'));
    await fs.symlink(path.join(root, 'outside'), path.join(root, 'mods'));
    await expect(uploadMod(root, 'mods', ['.jar'], 'test.jar', Readable.from('x'))).rejects.toThrow(
      /outside/,
    );
    expect(await fs.readdir(path.join(root, 'outside'))).toEqual([]);
  });

  it('allows edits only while stopped and serializes writes against power actions', async () => {
    for (const state of ['running', 'starting', 'stopping', 'installing', 'install_failed'])
      expect(() => requireStopped(state)).toThrow(/Stop/);
    expect(() => requireStopped('offline')).not.toThrow();
    await withServerLock('test', async () => {
      await expect(withServerLock('test', async () => {})).rejects.toThrow(/operation/);
    });
    await expect(withServerLock('test', async () => 'released')).resolves.toBe('released');
  });
});

describe('server-pack ZIP extraction', () => {
  it('strips a pack folder and preserves Linux executable permissions', async () => {
    await extractZip(fixture('server-pack.zip'), root, 1);
    expect(await fs.readFile(path.join(root, 'mods/test.jar'), 'utf8')).toBe('mod');
    expect((await fs.stat(path.join(root, 'start.sh'))).mode & 0o777).toBe(0o755);
  });
  it.each(['traversal.zip', 'symlink.zip'])('rejects %s', async (name) => {
    await expect(extractZip(fixture(name), root, 1)).rejects.toThrow();
  });
  it('refuses extraction through an existing link', async () => {
    await fs.mkdir(path.join(root, 'outside'));
    await fs.symlink(path.join(root, 'outside'), path.join(root, 'mods'));
    await expect(extractZip(fixture('through-link.zip'), root)).rejects.toThrow(/outside/);
    expect(await fs.readdir(path.join(root, 'outside'))).toEqual([]);
  });
});

describe('pack download URLs', () => {
  it.each([
    'file:///etc/passwd',
    'http://example.com/mod.zip',
    'https://user:password@example.com/mod.zip',
    'https://127.0.0.1/',
    'https://[::ffff:7f00:1]/',
    'https://[::1]/',
    'https://localhost/mod.zip',
  ])('rejects %s', async (url) => {
    await expect(downloadResponse(url)).rejects.toThrow();
  });
});
