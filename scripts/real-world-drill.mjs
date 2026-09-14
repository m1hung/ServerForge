#!/usr/bin/env node
// Actual Minecraft recovery qualification. Only a disposable test installation
// can be selected; this never discovers or operates the user's installation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { parseEnv } from '../packages/maintenance/src/environment.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const source = path.resolve(process.env.SF_GAME_TEST_HOME || 'invalid');
if (!source.startsWith(path.join(repo, 'data/release-tests/'))) throw new Error('Select an isolated SF_GAME_TEST_HOME under data/release-tests.');
const sourceConfig = parseEnv(await fs.readFile(path.join(source, 'config/.env'), 'utf8'));
if (!sourceConfig.COMPOSE_PROJECT_NAME.startsWith('serverforge-') || !sourceConfig.HOST_DATA_ROOT.startsWith(source + path.sep)) throw new Error('The selected project does not own this test directory.');
const uid = process.env.SF_GAME_TEST_UID;
if (!uid || !/^[a-z0-9-]+$/.test(uid)) throw new Error('Select the explicit test Minecraft server UID.');
const target = await fs.mkdtemp(path.join(repo, 'data/release-tests/world-restore-'));
const endpoint = process.env.DOCKER_HOST || `unix://${process.env.DOCKER_SOCKET}`;
if (!endpoint.startsWith('unix://') || endpoint.endsWith('undefined')) throw new Error('Select the test Docker socket.');
const env = { ...process.env, DOCKER_HOST: endpoint, SERVERFORGE_MAINTENANCE_IMAGE: process.env.SF_MAINTENANCE_TEST_IMAGE || 'serverforge-rc-maintenance:check' };
const report = { format: 'serverforge-real-world-recovery', version: 1, startedAt: new Date().toISOString(), ok: false, game: { id: 'minecraft-java', variant: 'vanilla', version: '1.20.1', uid }, checks: [], sourceProject: sourceConfig.COMPOSE_PROJECT_NAME, target, limitations: ['Linux Docker Desktop only. Native Docker Engine, Windows, macOS, other loaders and the four-hour soak require separate evidence.'] };
function run(command, args, extra = {}) {
  return new Promise((resolve, reject) => { const child = spawn(command, args, { cwd: repo, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); let text = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { text = (text + chunk).slice(-2000000); }); child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(text) : reject(new Error(`${command} failed (${code}): ${text.replace(/One-time owner setup token: \S+/g, '[setup token redacted]')}`))); });
}
const launch = (home, args) => run('bash', ['release/serverforge', ...args], { SERVERFORGE_HOME: home });
const cookie = (await fs.readFile(path.join(source, 'test-cookie'), 'utf8')).trim();
const sourceUrl = `http://127.0.0.1:${sourceConfig.WEB_PORT}`;
async function api(base, cookie, route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + '/api' + route, { method, headers: { cookie, origin: base, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json(); if (!response.ok) throw new Error(`${route}: ${result.error?.message || response.status}`); return result;
}
async function waitFor(action, timeout = 120000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await action()) return; await new Promise((resolve) => setTimeout(resolve, 1000)); } throw new Error('World recovery check timed out.'); }
async function logs(id) { return run('docker', ['logs', '--tail', '100', id]); }
try {
  let server = (await api(sourceUrl, cookie, `/servers/${uid}`)).server;
  assert.equal(server.gameId, report.game.id); assert.equal(server.variantId, 'vanilla'); assert.equal(server.version, '1.20.1');
  if (server.state !== 'running') await api(sourceUrl, cookie, `/servers/${uid}/power`, { action: 'start' });
  server = (await api(sourceUrl, cookie, `/servers/${uid}`)).server;
  await waitFor(async () => (await logs(server.containerId)).includes('Done ('));
  for (const command of ['scoreboard objectives add sf_restore dummy', 'scoreboard players set checkpoint sf_restore 14092026', 'save-all flush']) await api(sourceUrl, cookie, `/servers/${uid}/console`, { command });
  await waitFor(async () => (await logs(server.containerId)).includes('14092026'));
  report.checks.push('real-game-console-command-and-persistent-world-sentinel');
  const before = JSON.parse(await run('docker', ['inspect', server.containerId]))[0];
  report.game.image = before.Image; report.game.startedBeforeBackup = before.State.StartedAt;
  console.log('Taking a full consistent backup of the real Minecraft world.');
  const bundleText = await launch(source, ['backup', '--full']);
  const bundle = JSON.parse(bundleText); const bundleHost = path.join(sourceConfig.HOST_RECOVERY_ROOT, path.basename(bundle.directory));
  await launch(source, ['verify', bundleHost]); report.bundleId = bundle.id;
  const resumed = (await api(sourceUrl, cookie, `/servers/${uid}`)).server;
  assert.equal(resumed.state, 'running'); assert.notEqual(resumed.containerId, server.containerId);
  await waitFor(async () => (await logs(resumed.containerId)).includes('Done ('));
  report.checks.push('full-bundle-checksums', 'graceful-stop-and-resume');
  await api(sourceUrl, cookie, `/servers/${uid}/power`, { action: 'stop' });
  const sourceWorld = path.join(sourceConfig.HOST_DATA_ROOT, uid, 'world/data/scoreboard.dat');
  report.worldSentinelSha256 = createHash('sha256').update(await fs.readFile(sourceWorld)).digest('hex');
  console.log('Restoring into a new database and installation directory.');
  const setup = await launch(target, ['setup', '--configure-only', '--port', process.env.SF_RESTORE_WEB_PORT || '3031', '--api-image', 'serverforge-rc-api:check', '--web-image', 'serverforge-rc-web:check']);
  await fs.writeFile(path.join(target, 'setup.log'), setup, { mode: 0o600 });
  await launch(target, ['restore', bundleHost]);
  await launch(target, ['start']);
  const targetConfig = parseEnv(await fs.readFile(path.join(target, 'config/.env'), 'utf8'));
  report.targetProject = targetConfig.COMPOSE_PROJECT_NAME;
  assert.notEqual(targetConfig.COMPOSE_PROJECT_NAME, sourceConfig.COMPOSE_PROJECT_NAME);
  assert.equal(targetConfig.ENCRYPTION_KEY, sourceConfig.ENCRYPTION_KEY);
  assert.notEqual(targetConfig.SESSION_SECRET, sourceConfig.SESSION_SECRET);
  assert.equal(targetConfig.UPNP_ENABLED, 'false'); assert.equal(targetConfig.BIND_HOST, '127.0.0.1');
  const targetUrl = `http://127.0.0.1:${targetConfig.WEB_PORT}`;
  const oldSession = await fetch(targetUrl + '/api/account', { headers: { cookie } }); assert.equal(oldSession.status, 401);
  const credentials = JSON.parse(await fs.readFile(path.join(source, 'browser-credentials.json'), 'utf8'));
  const login = await fetch(targetUrl + '/api/auth/login', { method: 'POST', headers: { origin: targetUrl, 'content-type': 'application/json' }, body: JSON.stringify({ username: credentials.username || 'release-owner', password: credentials.password }) });
  assert.equal(login.status, 200); const newCookie = login.headers.get('set-cookie').split(';')[0];
  await fs.writeFile(path.join(target, 'test-cookie'), newCookie, { mode: 0o600 });
  const recovered = (await api(targetUrl, newCookie, `/servers/${uid}`)).server;
  assert.equal(recovered.state, 'offline'); assert.equal(recovered.containerId, null); assert.equal(recovered.publicAccess, false);
  const targetWorld = path.join(targetConfig.HOST_DATA_ROOT, uid, 'world/data/scoreboard.dat');
  assert.equal(createHash('sha256').update(await fs.readFile(targetWorld)).digest('hex'), report.worldSentinelSha256);
  report.checks.push('fresh-host-path-remap', 'encryption-key-preserved', 'restored-session-revoked', 'account-password-preserved', 'games-restored-offline', 'world-content-checksum');
  await api(targetUrl, newCookie, `/servers/${uid}/power`, { action: 'start' });
  const running = (await api(targetUrl, newCookie, `/servers/${uid}`)).server;
  await waitFor(async () => (await logs(running.containerId)).includes('Done ('));
  await api(targetUrl, newCookie, `/servers/${uid}/console`, { command: 'scoreboard players get checkpoint sf_restore' });
  await waitFor(async () => (await logs(running.containerId)).includes('14092026'));
  report.checks.push('restored-game-startup', 'restored-world-sentinel-confirmed-by-game');
  await fs.writeFile(path.join(target, 'restored-game.log'), await logs(running.containerId), { mode: 0o600 });
  await api(targetUrl, newCookie, `/servers/${uid}/power`, { action: 'stop' });
  report.platform = JSON.parse(execFileSync('docker', ['info', '--format', '{{json .}}'], { env, encoding: 'utf8' }));
  report.platform = Object.fromEntries(['ServerVersion', 'OSType', 'Architecture', 'OperatingSystem', 'KernelVersion', 'NCPU', 'MemTotal'].map((key) => [key, report.platform[key]]));
  report.ok = true;
} catch (error) { report.error = error.message; process.exitCode = 1; console.error(error.message); }
finally { report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(target, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); console.log(`World recovery result: ${path.join(target, 'result.json')}`); }
