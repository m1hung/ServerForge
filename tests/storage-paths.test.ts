import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

/**
 * Path remapping is loaded after env is set — the module reads config at
 * import time, so each case gets a fresh module graph.
 */
async function loadMapper(env: Record<string, string>) {
  vi.resetModules();
  // Clear remapping knobs so a prior case cannot leak into the next.
  delete process.env.HOST_DATA_ROOT;
  delete process.env.HOST_BACKUP_ROOT;
  delete process.env.COOKIE_SECURE;
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  return import('../apps/api/src/lib/storage-paths.js');
}

const secrets = {
  SESSION_SECRET: 'a'.repeat(64),
  ENCRYPTION_KEY: 'b'.repeat(64),
  DATABASE_URL: 'postgresql://serverforge:x@localhost:5432/serverforge',
};

afterEach(() => {
  vi.resetModules();
});

describe('storage path remapping', () => {
  it('rewrites host data paths to the container mount for local I/O', async () => {
    const host = '/home/will/data/servers';
    const local = '/var/lib/serverforge/servers';
    const { localDataPath, hostDataPath } = await loadMapper({
      ...secrets,
      NODE_ENV: 'production',
      DATA_ROOT: local,
      BACKUP_ROOT: '/var/lib/serverforge/backups',
      HOST_DATA_ROOT: host,
      HOST_BACKUP_ROOT: '/home/will/data/backups',
      COOKIE_SECURE: 'false',
    });

    const serverDir = path.join(host, 'abc123');
    expect(localDataPath(serverDir)).toBe(path.join(local, 'abc123'));
    expect(hostDataPath(path.join(local, 'abc123'))).toBe(serverDir);
  });

  it('rewrites host backup paths onto the bind-mounted backup root', async () => {
    const host = '/home/will/data/backups';
    const local = '/var/lib/serverforge/backups';
    const { localBackupPath } = await loadMapper({
      ...secrets,
      NODE_ENV: 'production',
      DATA_ROOT: '/var/lib/serverforge/servers',
      BACKUP_ROOT: local,
      HOST_DATA_ROOT: '/home/will/data/servers',
      HOST_BACKUP_ROOT: host,
      COOKIE_SECURE: 'false',
    });

    expect(localBackupPath(path.join(host, 'srv', 'x.tar.gz'))).toBe(
      path.join(local, 'srv', 'x.tar.gz'),
    );
  });

  it('treats a blank HOST_DATA_ROOT as unset, not as the current directory', async () => {
    const local = '/var/lib/serverforge/servers';
    const { hostDataPath } = await loadMapper({
      ...secrets,
      NODE_ENV: 'production',
      DATA_ROOT: local,
      BACKUP_ROOT: '/var/lib/serverforge/backups',
      // What .env.example ships before bootstrap has run.
      HOST_DATA_ROOT: '',
      HOST_BACKUP_ROOT: '',
      COOKIE_SECURE: 'false',
    });

    expect(hostDataPath(path.join(local, 'abc123'))).toBe(path.join(local, 'abc123'));
  });

  it('is a no-op when host and local roots match (dev on the host)', async () => {
    const root = path.resolve('./data/servers');
    const { localDataPath, hostDataPath } = await loadMapper({
      ...secrets,
      NODE_ENV: 'development',
      DATA_ROOT: root,
      BACKUP_ROOT: './data/backups',
      COOKIE_SECURE: 'auto',
    });

    const serverDir = path.join(root, 'abc123');
    expect(localDataPath(serverDir)).toBe(serverDir);
    expect(hostDataPath(serverDir)).toBe(serverDir);
  });
});

/**
 * The startup guard. Each case is a real deployment shape: the compose file
 * once defaulted HOST_DATA_ROOT and its own bind mount to different paths, so
 * a fresh install pointed game containers at a directory nothing wrote to.
 */
describe('describeMountMismatch', () => {
  const containerRoot = '/var/lib/serverforge/servers';
  const options = {
    containerRoot,
    hostRoot: '/home/will/LGH/data/servers',
    localKey: 'DATA_ROOT',
    hostKey: 'HOST_DATA_ROOT',
  };

  async function load() {
    return (await loadMapper({ ...secrets })).describeMountMismatch;
  }

  it('passes when the mount source is the configured host root', async () => {
    const describeMountMismatch = await load();
    expect(
      describeMountMismatch(
        [
          { source: '/var/run/docker.sock', destination: '/var/run/docker.sock' },
          { source: '/home/will/LGH/data/servers', destination: containerRoot },
        ],
        options,
      ),
    ).toBeNull();
  });

  it('ignores trailing separators and unnormalised paths', async () => {
    const describeMountMismatch = await load();
    expect(
      describeMountMismatch(
        [{ source: '/home/will/LGH/./data/servers/', destination: `${containerRoot}/` }],
        options,
      ),
    ).toBeNull();
  });

  it('reports the real host path when the two disagree', async () => {
    const describeMountMismatch = await load();
    const problem = describeMountMismatch(
      [{ source: '/home/will/LGH/data/servers', destination: containerRoot }],
      { ...options, hostRoot: '/var/lib/serverforge/servers' },
    );

    expect(problem).toContain('/home/will/LGH/data/servers');
    expect(problem).toContain('HOST_DATA_ROOT');
  });

  it('reports a data root that is not bind-mounted at all', async () => {
    const describeMountMismatch = await load();
    const problem = describeMountMismatch(
      [{ source: '/var/run/docker.sock', destination: '/var/run/docker.sock' }],
      options,
    );

    expect(problem).toContain('not bind-mounted');
  });
});
