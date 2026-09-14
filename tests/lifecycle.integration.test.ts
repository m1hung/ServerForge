import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import Docker from 'dockerode';
import { fixtureDatabase } from '../scripts/migration-fixtures.mjs';
import { migrateDatabase } from '../packages/maintenance/src/migrate.mjs';
import { brand } from '@serverforge/core';
import { DockerRuntime } from '../apps/api/src/runtime/docker.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port)); }); });
}
async function waitFor(action: () => Promise<boolean>, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await action().catch(() => false)) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error('Lifecycle check did not reach the expected state.');
}
async function fixture(action: (context: { start: (extra?: Record<string, string>) => ChildProcess; stop: (signal?: NodeJS.Signals) => Promise<void>; url: string; directory: string }) => Promise<void>) {
  if (!process.env.SF_REQUIRE_INTEGRATION || !process.env.SF_TEST_DATA_ROOT) throw new Error('Use the isolated integration launcher.');
  const directory = await fs.mkdtemp(path.join(process.env.SF_TEST_DATA_ROOT, 'lifecycle-'));
  const port = await freePort();
  let child: ChildProcess | undefined;
  let output = '';
  for (const folder of ['servers', 'backups', 'cache', 'games', 'themes']) await fs.mkdir(path.join(directory, folder), { mode: 0o777 });
  const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    await waitFor(async () => child!.exitCode !== null || child!.signalCode !== null, 15000);
  };
  try {
    await action({
      directory, url: `http://127.0.0.1:${port}`, stop,
      start(extra = {}) {
        child = spawn(process.execPath, ['apps/api/dist/index.js'], { env: { ...process.env, WORKER: '1', API_HOST: '127.0.0.1', API_PORT: String(port), DATA_ROOT: path.join(directory, 'servers'), HOST_DATA_ROOT: path.join(directory, 'servers'), BACKUP_ROOT: path.join(directory, 'backups'), HOST_BACKUP_ROOT: path.join(directory, 'backups'), CACHE_ROOT: path.join(directory, 'cache'), GAMES_ROOT: path.join(directory, 'games'), THEMES_ROOT: path.join(directory, 'themes'), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
        for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (chunk) => { output = (output + chunk).slice(-256000); });
        return child;
      },
    });
  } finally { await stop('SIGKILL'); await fs.writeFile(path.join(directory, 'api.log'), output, { mode: 0o600 }); }
}

it.each(['database', 'docker'])('keeps liveness available while %s is unavailable and refuses mutations', async (dependency) => {
  await fixture(async ({ start, stop, url, directory }) => {
    start(dependency === 'docker' ? { DOCKER_SOCKET: path.join(directory, 'absent.sock') } : { DATABASE_URL: `postgresql://unavailable:unavailable@127.0.0.1:${await freePort()}/unavailable?connect_timeout=1` });
    await waitFor(async () => (await fetch(`${url}/health/live`)).status === 200);
    const readiness = await fetch(`${url}/health/ready`);
    expect(readiness.status).toBe(503);
    expect((await readiness.json()).checks[dependency]).toBe(false);
    expect((await fetch(`${url}/api/servers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(503);
    await stop();
  });
}, 45000);

it('reconnects to an orphaned owned container, survives API termination, and flags interrupted work without replay', async () => {
  await fixtureDatabase(async (db, databaseUrl) => {
    await migrateDatabase(databaseUrl);
    await fixture(async ({ start, stop, url, directory }) => {
      const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET });
      const image = process.env.SF_TEST_IMAGE || 'node:22.23.2-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284';
      await new DockerRuntime(process.env.DOCKER_SOCKET).ensureImage(image);
      const uid = `sf-crash-${randomBytes(5).toString('hex')}`;
      const dataPath = path.join(directory, 'servers', uid); await fs.mkdir(dataPath, { mode: 0o777 });
      const owner = await db.user.create({ data: { username: uid, displayName: 'Fixture', uid, role: 'owner', passwordHash: 'fixture-only' } });
      const node = await db.node.create({ data: { uid, name: uid, dataRoot: path.join(directory, 'servers') } });
      const server = await db.server.create({ data: { uid, name: uid, ownerId: owner.id, nodeId: node.id, gameId: 'minecraft-java', variantId: 'vanilla', version: '1.20.1', state: 'starting', installedAt: new Date(), dataPath, memoryMib: 64, cpuCores: 1, diskMib: 1024, autoRestart: false } });
      const container = await docker.createContainer({ Image: image, name: uid, User: '1000:1000', Entrypoint: ['/bin/sh', '-c'], Cmd: ['sleep 600'], WorkingDir: '/home/container', Labels: { [`${brand.labelNamespace}/managed`]: 'true', [`${brand.labelNamespace}/server`]: uid, 'serverforge.io/test-project': process.env.SF_TEST_PROJECT! }, HostConfig: { Binds: [`${dataPath}:/home/container`], NetworkMode: 'none', Memory: 64 * 1024 ** 2, PidsLimit: 64, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'] } });
      try {
        await container.start(); const before = await container.inspect();
        start({ DATABASE_URL: databaseUrl });
        await waitFor(async () => (await fetch(`${url}/health/ready`)).status === 200);
        expect(await db.server.findUnique({ where: { id: server.id } })).toMatchObject({ state: 'running', containerId: container.id });
        await stop();
        expect((await container.inspect()).State.StartedAt).toBe(before.State.StartedAt);
        expect((await container.inspect()).State.Running).toBe(true);
        // This durable state is the crash window immediately after create,
        // before persisting Docker's container identifier.
        await db.server.update({ where: { id: server.id }, data: { containerId: null, state: 'offline' } });
        const failed = await db.server.create({ data: { uid: `${uid}-install`, name: 'Interrupted installation', ownerId: owner.id, nodeId: node.id, gameId: 'minecraft-java', variantId: 'vanilla', version: '1.20.1', state: 'installing', dataPath: path.join(directory, 'servers', `${uid}-install`), memoryMib: 64, cpuCores: 1, diskMib: 1024 } });
        await fs.mkdir(failed.dataPath);
        await db.installationAttempt.create({ data: { uid: `${uid}-attempt`, serverId: failed.id, state: 'running', stagingPath: path.join(directory, 'servers/.operations', failed.uid, `install-${uid}-attempt`), startedAt: new Date() } });
        const schedule = await db.schedule.create({ data: { uid: `${uid}-schedule`, name: 'Do not replay', serverId: server.id, cron: '* * * * *', actions: [{ type: 'command', command: 'unsafe-to-replay' }], lastRunAt: new Date(Date.now() - 60000), nextRunAt: new Date(Date.now() - 60000), lastRunOk: null } });
        const backupDirectory = path.join(directory, 'backups', uid); await fs.mkdir(backupDirectory);
        const interruptedBackup = await db.backup.create({ data: { uid: 'interrupted-backup', serverId: server.id, name: 'Interrupted', state: 'running' } });
        await db.backup.create({ data: { uid: 'last-good-backup', serverId: server.id, name: 'Last good', state: 'completed' } });
        await fs.writeFile(path.join(backupDirectory, 'interrupted-backup.tar.gz.partial'), 'partial');
        await fs.writeFile(path.join(backupDirectory, 'last-good-backup.tar.gz'), 'keep this checkpoint');
        start({ DATABASE_URL: databaseUrl });
        await waitFor(async () => (await fetch(`${url}/health/ready`)).status === 200);
        expect(await db.backup.findUnique({ where: { id: interruptedBackup.id } })).toMatchObject({ state: 'failed' });
        expect(await fs.stat(path.join(backupDirectory, 'interrupted-backup.tar.gz.partial')).catch(() => null)).toBeNull();
        expect(await fs.readFile(path.join(backupDirectory, 'last-good-backup.tar.gz'), 'utf8')).toBe('keep this checkpoint');
        expect(await db.server.findUnique({ where: { id: server.id } })).toMatchObject({ state: 'running', containerId: container.id });
        expect(await db.server.findUnique({ where: { id: failed.id } })).toMatchObject({ state: 'install_failed' });
        expect(await db.installationAttempt.findFirst({ where: { serverId: failed.id } })).toMatchObject({ state: 'failed', finishedAt: expect.any(Date) });
        const recoveredSchedule = await db.schedule.findUnique({ where: { id: schedule.id } });
        expect(recoveredSchedule.lastRunOk).toBe(false); expect(recoveredSchedule.nextRunAt.getTime()).toBeGreaterThan(Date.now());
        await stop('SIGKILL'); start({ DATABASE_URL: databaseUrl });
        await waitFor(async () => (await fetch(`${url}/health/ready`)).status === 200);
        expect((await container.inspect()).State.StartedAt).toBe(before.State.StartedAt);
        const owned = await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`${brand.labelNamespace}/server=${uid}`] }) });
        expect(owned).toHaveLength(1);
      } finally { await stop('SIGKILL'); await container.remove({ force: true }); }
    });
  });
}, 120000);
