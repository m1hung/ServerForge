#!/usr/bin/env node
// Fault injection is restricted to an explicitly selected disposable restored fixture.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { parseEnv } from '../packages/maintenance/src/environment.mjs';
const home = path.resolve(process.env.SF_GAME_TEST_HOME || 'invalid');
const uid = process.env.SF_GAME_TEST_UID;
assert.match(uid || '', /^[a-z0-9]+$/);
const endpoint = process.env.DOCKER_HOST || `unix://${process.env.DOCKER_SOCKET}`;
assert(
  endpoint.startsWith('unix://') && !endpoint.endsWith('undefined'),
  'Select a local test Docker socket.',
);
const env = { ...process.env, DOCKER_HOST: endpoint };
assert(home.startsWith(path.resolve('data/release-tests') + '/world-restore-'));
const cfg = parseEnv(await fs.readFile(path.join(home, 'config/.env'), 'utf8'));
assert.match(cfg.COMPOSE_PROJECT_NAME, /^serverforge-[a-f0-9]{10}$/);
assert(cfg.HOST_DATA_ROOT.startsWith(home + '/'));
assert(cfg.HOST_BACKUP_ROOT.startsWith(home + '/'));
const base = 'http://127.0.0.1:' + cfg.WEB_PORT;
const cookie = (await fs.readFile(path.join(home, 'test-cookie'), 'utf8')).trim();
const compose = [
  'compose',
  '--project-directory',
  path.join(home, 'config'),
  '--env-file',
  path.join(home, 'config/.env'),
  '-f',
  path.join(home, 'config/compose.yml'),
];
const override = path.join(home, 'config/qualification-fault.json');
const volume = cfg.COMPOSE_PROJECT_NAME + '-fault-' + randomBytes(4).toString('hex');
const report = {
  format: 'serverforge-isolated-fault-drill',
  version: 1,
  project: cfg.COMPOSE_PROJECT_NAME,
  startedAt: new Date().toISOString(),
  ok: false,
  checks: [],
  limitations: [
    'A bounded 128 MiB test volume is exhausted; the host disk and database volume are never filled. Docker access is removed only from this test API; the shared daemon remains running.',
  ],
};
const save = () =>
  fs.writeFile(path.join(home, 'fault-result.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
async function run(args) {
  return new Promise((resolve, reject) => {
    const c = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
    let out = '';
    c.stdout.on('data', (b) => (out += b));
    c.stderr.on('data', (b) => (out += b));
    c.once('error', reject);
    c.once('exit', (code, signal) =>
      code === 0
        ? resolve(out.trim())
        : reject(Error(`Docker fixture command failed (${signal || code}): ` + out.slice(-3000))),
    );
  });
}
const inspect = async (id) => JSON.parse(await run(['inspect', id]))[0];
const service = async (name) => (await run([...compose, 'ps', '-q', name])).trim();
async function request(route, body) {
  const r = await fetch(base + '/api' + route, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, origin: base, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error?.message || r.status);
  return d;
}
async function wait(fn, seconds = 150) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error('Fault drill timed out.');
}
async function health(route) {
  return JSON.parse(
    await run([
      'exec',
      await service('api'),
      'node',
      '-e',
      `fetch('http://127.0.0.1:8080${route}').then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()})))`,
    ]),
  );
}
const ready = () => wait(async () => (await health('/health/ready')).status === 200);
const game = async () => (await request('/servers/' + uid)).server;
async function hash(file) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}
async function files(root) {
  const out = {};
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      for (const [n, h] of Object.entries(await files(p))) out[e.name + '/' + n] = h;
    } else if (e.isFile()) out[e.name] = await hash(p);
  }
  return out;
}
let gameId,
  gameStart,
  createdVolume = false,
  overridden = false,
  preflightComplete = false,
  workerRunning = false;
async function unchanged() {
  const x = await inspect(gameId);
  assert(x.State.Running);
  assert.equal(x.State.StartedAt, gameStart);
  const ids = (
    await run(['ps', '-q', '--filter', 'label=' + cfg.BRAND_RESOURCE_PREFIX + '.io/server=' + uid])
  )
    .split(/\s+/)
    .filter(Boolean);
  assert.equal(ids.length, 1);
  assert.equal((await game()).containerId, gameId);
}
try {
  await ready();
  const initial = await game();
  assert.equal(initial.state, 'offline');
  assert.equal(initial.gameId, 'minecraft-java');
  assert.equal(initial.variantId, 'vanilla');
  assert(initial.dataPath.startsWith(cfg.HOST_DATA_ROOT + '/'));
  const apiInfo = await inspect(await service('api'));
  assert.equal(apiInfo.Config.Labels['com.docker.compose.project'], cfg.COMPOSE_PROJECT_NAME);
  const worker = await service('backup-worker');
  workerRunning = Boolean(worker && (await inspect(worker)).State.Running);
  preflightComplete = true;
  report.images = {
    api: (await inspect(await service('api'))).Image,
    web: (await inspect(await service('web'))).Image,
    postgres: (await inspect(await service('postgres'))).Image,
  };
  await run([...compose, 'stop', 'backup-worker']);
  await request('/servers/' + uid + '/power', { action: 'start' });
  gameId = (await game()).containerId;
  gameStart = (await inspect(gameId)).State.StartedAt;
  await wait(async () => (await run(['logs', '--tail', '150', gameId])).includes('Done ('));
  await request('/servers/' + uid + '/console', {
    command: 'scoreboard players set checkpoint sf_restore 14092026',
  });
  await request('/servers/' + uid + '/console', { command: 'save-all flush' });
  await wait(async () => (await run(['logs', '--tail', '150', gameId])).includes('Saved the game'));
  console.log('Checking database outage while the game keeps running.');
  await run([...compose, 'stop', 'postgres']);
  await wait(async () => {
    const r = await health('/health/ready');
    return r.status === 503 && r.body.checks.database === false;
  });
  assert.equal((await health('/health/live')).status, 200);
  assert((await inspect(gameId)).State.Running);
  await run([...compose, 'start', 'postgres']);
  await ready();
  await unchanged();
  report.checks.push(
    'database-outage-live-but-not-ready',
    'database-reconnect-without-game-restart',
  );
  await save();
  console.log('Checking unavailable Docker access in only the test API.');
  await fs.writeFile(
    override,
    JSON.stringify({
      services: {
        api: { environment: { DOCKER_SOCKET: '/nonexistent-qualification-docker.sock' } },
      },
    }),
    { mode: 0o600 },
  );
  overridden = true;
  await run([...compose, '-f', override, 'up', '-d', '--no-deps', 'api']);
  await wait(async () => {
    const r = await health('/health/ready');
    return r.status === 503 && r.body.checks.docker === false;
  });
  assert.equal((await health('/health/live')).status, 200);
  assert((await inspect(gameId)).State.Running);
  await run([...compose, 'up', '-d', '--no-deps', 'api']);
  overridden = false;
  await ready();
  await unchanged();
  report.checks.push(
    'docker-access-outage-live-but-not-ready',
    'owned-container-reconnected-without-duplicate',
  );
  await save();
  console.log('Checking real ENOSPC in a bounded disposable backup volume.');
  const originalBackups = await files(cfg.HOST_BACKUP_ROOT);
  await run([
    'volume',
    'create',
    '--driver',
    'local',
    '--opt',
    'type=tmpfs',
    '--opt',
    'device=tmpfs',
    '--opt',
    'o=size=128m,mode=0777',
    '--label',
    'serverforge.io/test-project=' + cfg.COMPOSE_PROJECT_NAME,
    volume,
  ]);
  createdVolume = true;
  await fs.writeFile(
    override,
    JSON.stringify({
      services: { api: { volumes: ['fault-backups:/var/lib/serverforge/backups'] } },
      volumes: { 'fault-backups': { external: true, name: volume } },
    }),
    { mode: 0o600 },
  );
  overridden = true;
  await run([...compose, '-f', override, 'up', '-d', '--no-deps', 'api']);
  await ready();
  await unchanged();
  const fill = JSON.parse(
    await run([
      'exec',
      await service('api'),
      'node',
      '-e',
      `const fs=require('fs');fs.writeFileSync('/var/lib/serverforge/backups/last-good-canary','retained');const f=fs.openSync('/var/lib/serverforge/backups/filler','w');const b=Buffer.alloc(1024*1024);let code;try{for(let n=0;n<160;n++)fs.writeSync(f,b);}catch(e){code=e.code;}finally{fs.closeSync(f);}console.log(JSON.stringify({code,free:Number(fs.statfsSync('/var/lib/serverforge/backups').bavail)*Number(fs.statfsSync('/var/lib/serverforge/backups').bsize)}));`,
    ]),
  );
  assert.equal(fill.code, 'ENOSPC');
  assert.equal(fill.free, 0);
  await request('/servers/' + uid + '/backups', { name: 'Full disk rejection' });
  await wait(async () => {
    const d = await request('/servers/' + uid + '/backups');
    return (
      !d.busy &&
      d.lastOperation?.action === 'backup.failed' &&
      d.lastOperation.message.includes('Not enough free storage')
    );
  });
  const status = await request('/system/status');
  assert.equal(status.storage.find((x) => x.name === 'Backups').freeBytes, 0);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'dark',
    });
    await context.addCookies([
      {
        name: cookie.slice(0, cookie.indexOf('=')),
        value: cookie.slice(cookie.indexOf('=') + 1),
        url: base,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    const page = await context.newPage();
    await page.goto(base + '/servers/' + uid + '#backups');
    await expect(
      page.getByRole('alert').filter({ hasText: 'Not enough free storage' }),
    ).toBeVisible();
    await page.screenshot({ path: path.join(home, 'full-disk-backup-error.png'), fullPage: true });
  } finally {
    await browser.close();
  }
  assert.equal(
    await run([
      'exec',
      await service('api'),
      'cat',
      '/var/lib/serverforge/backups/last-good-canary',
    ]),
    'retained',
  );
  await unchanged();
  await run([...compose, 'up', '-d', '--no-deps', 'api']);
  overridden = false;
  await ready();
  await unchanged();
  assert.deepEqual(await files(cfg.HOST_BACKUP_ROOT), originalBackups);
  await run(['volume', 'rm', volume]);
  createdVolume = false;
  report.checks.push(
    'bounded-volume-real-enospc',
    'storage-failure-visible-in-backups',
    'low-disk-measurement-visible',
    'failed-backup-preserves-game-and-last-good-files',
  );
  await request('/servers/' + uid + '/backups', { name: 'Recovered after storage failure' });
  await wait(async () => {
    const d = await request('/servers/' + uid + '/backups');
    return (
      !d.busy &&
      d.lastOperation?.action === 'backup.completed' &&
      d.lastOperation.message.includes('Recovered after storage failure')
    );
  }, 240);
  await wait(async () => (await game()).state === 'running');
  report.checks.push('successful-retry-clears-storage-error');
  const recoveredId = (await game()).containerId;
  await request('/servers/' + uid + '/console', {
    command: 'scoreboard players get checkpoint sf_restore',
  });
  await wait(async () =>
    (await run(['logs', '--tail', '200', recoveredId])).includes('checkpoint has 14092026'),
  );
  report.checks.push('recovered-game-confirms-world-content');
  await request('/servers/' + uid + '/power', { action: 'stop' });
  const world = path.join(cfg.HOST_DATA_ROOT, uid, 'world/data/scoreboard.dat');
  report.worldSha256 = await hash(world);
  report.ok = true;
} catch (e) {
  report.error = e.message;
  process.exitCode = 1;
} finally {
  try {
    if (preflightComplete) {
      await run([...compose, 'start', 'postgres']);
      if (overridden) await run([...compose, 'up', '-d', '--no-deps', 'api']);
      await ready();
      const s = await game();
      if (s.state === 'running') await request('/servers/' + uid + '/power', { action: 'stop' });
      if (createdVolume) await run(['volume', 'rm', volume]);
      await fs.rm(override, { force: true });
      if (workerRunning) await run([...compose, 'start', 'backup-worker']);
    }
  } catch (e) {
    report.cleanupError = e.message;
    report.ok = false;
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  await save();
  console.log('Fault report: ' + path.join(home, 'fault-result.json'));
}
