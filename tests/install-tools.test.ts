import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({ runOnce: vi.fn(), repairOwnership: vi.fn(), response: vi.fn() }));
vi.mock('../apps/api/src/runtime/docker.js', () => ({
  DockerRuntime: class {
    runOnce = mocks.runOnce;
    repairOwnership = mocks.repairOwnership;
  },
}));
vi.mock('../apps/api/src/lib/storage-paths.js', () => ({
  localDataPath: (value: string) => value,
}));
vi.mock('../apps/api/src/lib/download.js', () => ({ downloadResponse: mocks.response }));
import { installToolsFor } from '../apps/api/src/services/install-tools.js';

let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.repairOwnership.mockResolvedValue(undefined);
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-install-tools-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('installer primitives', () => {
  it('verifies publisher hashes and keeps an existing file on checksum failure', async () => {
    const tools = installToolsFor(root);
    mocks.response.mockImplementation(async () => Readable.from(['verified content']));
    const sha256 = createHash('sha256').update('verified content').digest('hex');
    expect(await tools.download('https://example.com/mod.jar', 'mods/mod.jar', { sha256 })).toBe(
      16,
    );
    await expect(
      tools.download('https://example.com/mod.jar', 'mods/mod.jar', { sha256: '0'.repeat(64) }),
    ).rejects.toThrow(/checksum/);
    expect(await fs.readFile(path.join(root, 'mods/mod.jar'), 'utf8')).toBe('verified content');
    expect(await fs.readdir(path.join(root, 'mods'))).toEqual(['mod.jar']);
  });

  it('runs the actual container driver and restores editable ownership', async () => {
    mocks.runOnce.mockResolvedValueOnce({ exitCode: 0, output: 'Installed.' });
    const result = await installToolsFor(root).runInContainer({
      image: 'test-runtime',
      command: ['java', '-jar', 'installer.jar'],
      timeoutMs: 5000,
    });
    expect(result).toEqual({ exitCode: 0, output: 'Installed.' });
    expect(mocks.runOnce).toHaveBeenNthCalledWith(1, {
      image: 'test-runtime',
      command: ['java', '-jar', 'installer.jar'],
      timeoutMs: 5000,
      dataPath: root,
    });
    expect(mocks.repairOwnership).toHaveBeenNthCalledWith(1, root, '1000:1000');
    expect(mocks.repairOwnership).toHaveBeenNthCalledWith(
      2,
      root,
      `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
    );
  });

  it('restores ownership after an installer failure and preserves the failure', async () => {
    mocks.runOnce.mockRejectedValueOnce(new Error('Installer timed out.'));
    await expect(
      installToolsFor(root).runInContainer({ image: 'test-runtime', command: ['installer'] }),
    ).rejects.toThrow(/timed out/);
    expect(mocks.runOnce).toHaveBeenCalledOnce();
    expect(mocks.repairOwnership).toHaveBeenCalledTimes(2);
  });

  it('copies an extracted pack into the server root, retaining files and executable bits', async () => {
    const tools = installToolsFor(root);
    await fs.mkdir(path.join(root, '.serverforge/extracted/pack'), { recursive: true });
    await fs.copyFile(
      'tests/fixtures/mod-zips/server-pack.zip',
      path.join(root, '.serverforge/pack.zip'),
    );
    await tools.unzip('.serverforge/pack.zip', '.serverforge/extracted');
    await tools.unzip('.serverforge/extracted/pack', '.');
    expect(await tools.readFile('mods/test.jar')).toBe('mod');
    expect((await fs.stat(path.join(root, 'start.sh'))).mode & 0o777).toBe(0o755);
  });

  it('rejects links and reserved panel paths when copying extracted folders', async () => {
    const tools = installToolsFor(root);
    await tools.mkdir('.serverforge/extracted');
    await fs.symlink('/etc', path.join(root, '.serverforge/extracted/link'));
    await expect(tools.unzip('.serverforge/extracted', '.')).rejects.toThrow();
    await fs.unlink(path.join(root, '.serverforge/extracted/link'));
    await tools.writeFile(
      '.serverforge/extracted/.serverforge/pack.zip',
      'do not replace the upload',
    );
    await expect(tools.unzip('.serverforge/extracted', '.')).rejects.toThrow(/cannot overwrite/);
  });
});
