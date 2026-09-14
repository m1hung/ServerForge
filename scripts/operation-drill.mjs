// Destructive qualification against an explicitly selected isolated restored fixture only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { parseEnv } from '../packages/maintenance/src/environment.mjs';
const repo = process.cwd(),
  home = path.resolve(process.env.SF_GAME_TEST_HOME || 'invalid'),
  uid = process.env.SF_GAME_TEST_UID;
assert(home.startsWith(path.join(repo, 'data/release-tests/')));
assert.match(uid || '', /^[a-z0-9]+$/);
const cfg = parseEnv(await fs.readFile(path.join(home, 'config/.env'), 'utf8'));
assert(cfg.HOST_DATA_ROOT.startsWith(home + '/'));
assert.match(cfg.COMPOSE_PROJECT_NAME, /^serverforge-[a-f0-9]{10}$/);
const env = { ...process.env, DOCKER_HOST: `unix://${process.env.DOCKER_SOCKET}` },
  base = `http://127.0.0.1:${cfg.WEB_PORT}`,
  cookie = (await fs.readFile(path.join(home, 'test-cookie'), 'utf8')).trim();
const out = path.join(home, 'operation-kill-result.json');
const report = {
  format: 'serverforge-operation-kill-drill',
  version: 1,
  startedAt: new Date().toISOString(),
  ok: false,
  project: cfg.COMPOSE_PROJECT_NAME,
  uid,
  checks: [],
  limitations: [
    'Linux Docker Desktop only. These are specific real interruption points, not exhaustive crash timing coverage. Interrupted game backup leaves the game offline for attention; full-host backup resume is tested separately.',
  ],
};
const save = () => fs.writeFile(out, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const docker = (args) =>
  execFileSync('docker', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function api(route, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(base + '/api' + route, {
    method,
    headers: { cookie, origin: base, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error?.message || r.status);
  return d;
}
async function wait(f, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('Operation interruption checkpoint timed out.');
}
const current = async () => (await api(`/servers/${uid}`)).server;
const command = (command) => api(`/servers/${uid}/console`, { command });
const world = path.join(cfg.HOST_DATA_ROOT, uid, 'world/data/scoreboard.dat');
const attempt = randomBytes(6).toString('hex');
const hash = async () =>
  createHash('sha256')
    .update(await fs.readFile(world))
    .digest('hex');
let apiId, noise;
async function kill() {
  docker(['kill', apiId]);
  await wait(async () => JSON.parse(docker(['inspect', apiId]))[0].State.Running === false);
}
async function recover() {
  docker(['start', apiId]);
  await wait(async () => {
    try {
      return JSON.parse(docker(['inspect', apiId]))[0].State.Health?.Status === 'healthy';
    } catch {
      return false;
    }
  });
}
async function ready() {
  let s = await current();
  if (s.state !== 'running') {
    await api(`/servers/${uid}/power`, { action: 'start' });
    s = await current();
  }
  await wait(async () => docker(['logs', '--tail', '100', s.containerId]).includes('Done ('));
  return s;
}
try {
  const s = await current();
  assert.equal(s.gameId, 'minecraft-java');
  assert.equal(s.variantId, 'vanilla');
  assert.equal(s.state, 'offline');
  const ids = docker([
    'ps',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${cfg.COMPOSE_PROJECT_NAME}`,
    '--filter',
    'label=com.docker.compose.service=api',
  ])
    .split(/\s+/)
    .filter(Boolean);
  assert.equal(ids.length, 1);
  apiId = ids[0];
  const info = JSON.parse(docker(['inspect', apiId]))[0];
  assert.equal(info.Config.Labels['com.docker.compose.project'], cfg.COMPOSE_PROJECT_NAME);
  report.apiImage = info.Image;
  docker(['update', '--restart=no', apiId]);
  await ready();
  await command('scoreboard players set checkpoint sf_restore 14092026');
  await command('save-all flush');
  await api(`/servers/${uid}/backups`, { name: `Crash drill baseline ${attempt}` });
  let backup;
  await wait(async () => {
    const d = await api(`/servers/${uid}/backups`);
    backup = d.backups.find((b) => b.name === `Crash drill baseline ${attempt}`);
    if (backup?.state === 'failed') throw Error(backup.error);
    return backup?.state === 'completed' && !d.busy;
  });
  await ready();
  await api(`/servers/${uid}/power`, { action: 'stop' });
  const a = await hash();
  report.baselineWorldSha256 = a;
  report.baselineBackup = backup.uid;
  await ready();
  await command('scoreboard players set checkpoint sf_restore 20260914');
  await command('save-all flush');
  const noisePath = path.join(cfg.HOST_DATA_ROOT, uid, `.serverforge/qualification-noise-${attempt}.bin`);
  const fd = await fs.open(noisePath, 'wx', 0o600);
  noise = noisePath;
  try {
    for (let n = 0; n < 32; n++) await fd.write(randomBytes(8 * 1024 ** 2));
  } finally {
    await fd.close();
  }
  await api(`/servers/${uid}/backups`, { name: `Crash drill interrupted backup ${attempt}` });
  let interrupted;
  await wait(async () => {
    const d = await api(`/servers/${uid}/backups`);
    interrupted = d.backups.find((b) => b.name === `Crash drill interrupted backup ${attempt}`);
    if (!interrupted) return false;
    const p = path.join(cfg.HOST_BACKUP_ROOT, uid, `${interrupted.uid}.tar.gz.partial`);
    return (await fs.stat(p).catch(() => null))?.size > 65536;
  });
  await kill();
  const b = await hash();
  report.liveWorldSha256 = b;
  assert.notEqual(a, b);
  await recover();
  const failed = (await api(`/servers/${uid}/backups`)).backups.find(
    (x) => x.uid === interrupted.uid,
  );
  assert.equal(failed.state, 'failed');
  assert.equal(
    await fs
      .stat(path.join(cfg.HOST_BACKUP_ROOT, uid, `${interrupted.uid}.tar.gz.partial`))
      .catch(() => null),
    null,
  );
  assert.equal((await current()).state, 'offline');
  assert.equal(await hash(), b);
  report.checks.push(
    'kill-during-real-backup-archive',
    'interrupted-backup-failed-actionably',
    'partial-archive-cleaned',
    'live-world-preserved',
  );
  await save();
  await fs.rm(noise);
  noise = null;
  const journal = path.join(cfg.HOST_DATA_ROOT, '.operations', uid, 'swap.json');
  await api(`/servers/${uid}/backups/${backup.uid}/restore`, {});
  let observed = false;
  await wait(async () => {
    if (await fs.stat(journal).catch(() => null)) {
      observed = true;
      return true;
    }
    return false;
  });
  assert(observed);
  await kill();
  const state = await fs.readFile(journal, 'utf8').then(JSON.parse, () => null);
  report.journalAtTermination = state ? { committed: state.committed } : null;
  const expected = state && !state.committed ? b : a;
  await recover();
  assert.equal((await current()).state, 'offline');
  assert.equal(await hash(), expected);
  assert.equal(await fs.stat(journal).catch(() => null), null);
  report.checks.push(
    'kill-after-restore-journal-created',
    'journal-recovered-offline',
    'world-matches-atomic-commit-state',
  );
  const running = await ready();
  const marker = expected === a ? '14092026' : '20260914';
  await command('scoreboard players get checkpoint sf_restore');
  await wait(async () =>
    docker(['logs', '--tail', '100', running.containerId]).includes(`checkpoint has ${marker}`),
  );
  await api(`/servers/${uid}/power`, { action: 'stop' });
  report.checks.push('recovered-game-starts-and-confirms-world-content');
  report.ok = true;
} catch (e) {
  report.error = e.message;
  process.exitCode = 1;
  console.error(e.message);
} finally {
  if (apiId) {
    try {
      await recover();
      docker(['update', '--restart=unless-stopped', apiId]);
      const s = await current();
      if (s.state === 'running') await api(`/servers/${uid}/power`, { action: 'stop' });
    } catch (e) {
      report.cleanupError = e.message;
      report.ok = false;
    }
  }
  if (noise) await fs.rm(noise, { force: true });
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(out);
}
