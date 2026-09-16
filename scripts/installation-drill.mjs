#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { parseEnv } from '../packages/maintenance/src/environment.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const root = path.resolve(process.env.SF_GAME_TEST_HOME || 'invalid');
if (!root.startsWith(path.join(repo, 'data/release-tests/'))) throw new Error('Choose an isolated SF_GAME_TEST_HOME under data/release-tests.');
const configuration = parseEnv(await fs.readFile(path.join(root, 'config/.env'), 'utf8'));
const credentials = JSON.parse(await fs.readFile(path.join(root, 'config/qualification.json'), 'utf8'));
assert.equal(credentials.project, configuration.COMPOSE_PROJECT_NAME);
assert.equal(configuration.HOST_DATA_ROOT, path.join(root, 'data/servers'));
assert.match(configuration.COMPOSE_PROJECT_NAME, /^serverforge-[a-f0-9]{10}$/);
const endpoint = process.env.DOCKER_HOST || `unix://${process.env.DOCKER_SOCKET}`;
assert.match(endpoint, /^unix:\/\//); assert.ok(!endpoint.endsWith('undefined'));
const env = { ...process.env, DOCKER_HOST: endpoint };
const base = `http://127.0.0.1:${configuration.WEB_PORT}`;
assert.ok(!['3000', '8080'].includes(configuration.WEB_PORT));
const output = path.join(root, 'config/qualification-results', `installation-interruption-${Date.now()}`);
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const report = { format: 'serverforge-installation-interruption', version: 1, startedAt: new Date().toISOString(), project: configuration.COMPOSE_PROJECT_NAME, ok: false, checks: [] };
const resourcePrefix = configuration.BRAND_RESOURCE_PREFIX || 'serverforge';
let cookie, uid, apiStopped = false;
async function docker(args) {
  return new Promise((resolve, reject) => { const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); let text = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', (bytes) => { text = (text + bytes).slice(-100000); }); child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(text) : reject(new Error(`Docker operation failed (${code}). Inspect the isolated project.`))); });
}
const compose = (args) => docker(['compose', '--project-directory', path.join(root, 'config'), '--env-file', path.join(root, 'config/.env'), '-f', path.join(root, 'config/compose.yml'), ...args]);
async function request(route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + '/api' + route, { method, headers: { origin: base, ...(cookie ? { cookie } : {}), ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
  const data = await response.json(); if (!response.ok) throw new Error(`${route}: ${data.error?.message || response.status}`);
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return data;
}
async function waitFor(check, timeout = 120000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 300)); } throw new Error('The isolated installation check timed out.'); }
const installation = async () => (await request(`/servers/${uid}/installation`)).installation;
async function installerFor(attemptUid) {
  const ids = (await docker(['ps', '-q', '--filter', `label=${resourcePrefix}.io/purpose=install`])).trim().split(/\s+/).filter(Boolean);
  for (const id of ids) {
    const [details] = JSON.parse(await docker(['inspect', id]));
    if (details.Mounts.some((mount) => mount.Type === 'bind' && mount.Destination === '/home/container' && mount.Source === path.join(root, 'data/servers/.operations', uid, `install-${attemptUid}`))) return id;
  }
  return null;
}
try {
  await request('/auth/login', { username: credentials.username, password: credentials.password });
  const game = await request('/games/minecraft-java'); const variant = game.variants.find((variant) => variant.id === 'custom-modpack');
  const pack = await fs.readFile(path.join(root, 'config/qualification-pack.zip'));
  report.packSha256 = createHash('sha256').update(pack).digest('hex');
  const body = new FormData();
  body.append('configuration', JSON.stringify({ name: `Qualification interrupted ${randomBytes(3).toString('hex')}`, gameId: 'minecraft-java', variantId: 'custom-modpack', version: '1.21.1', settings: variant.settings, limits: { memoryMib: 4096, cpuCores: 2, diskMib: 8192, swapMib: 0 }, startOnCreate: false, acceptedEula: variant.eula.key }));
  body.append('pack', new Blob([pack]), 'qualification-pack.zip');
  uid = (await request('/servers', body)).server.uid; report.uid = uid;
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  let attempt, installer;
  await waitFor(async () => { attempt = await installation(); installer = attempt && await installerFor(attempt.uid); return !!installer; }, 180000);
  report.interruptedAttempt = attempt.uid; report.installerContainer = installer;
  console.log('Terminating only the fixture API while its real loader installer is active.');
  const apiId = (await compose(['ps', '-q', 'api'])).trim();
  const [api] = JSON.parse(await docker(['inspect', apiId]));
  assert.equal(api.Config.Labels['com.docker.compose.project'], configuration.COMPOSE_PROJECT_NAME);
  apiStopped = true; await docker(['kill', '--signal', 'KILL', apiId]); await compose(['start', 'api']); apiStopped = false;
  await waitFor(async () => { const response = await fetch(base + '/api/system/status', { headers: { cookie } }).catch(() => null); return response?.ok && (await response.json()).ok; });
  await waitFor(async () => (await installation()).state === 'failed');
  const failed = await installation(); assert.equal(failed.hasUploadedPack, true); assert.match(failed.error, /restarted/);
  const uploaded = path.join(root, 'data/servers/.operations', uid, 'uploaded-pack.zip');
  assert.equal(createHash('sha256').update(await fs.readFile(uploaded)).digest('hex'), report.packSha256);
  assert.equal(await installerFor(attempt.uid), null);
  assert.equal(await fs.stat(path.join(root, 'data/servers/.operations', uid, `install-${attempt.uid}`)).catch(() => null), null);
  report.checks.push('api-killed-during-real-installer', 'restart-readiness', 'interrupted-attempt-actionable-failure', 'uploaded-pack-preserved', 'orphan-installer-and-staging-cleaned');
  await request(`/servers/${uid}/installation/retry`, {});
  let second;
  await waitFor(async () => { second = await installation(); return second?.uid !== attempt.uid && second?.state === 'running'; });
  assert.notEqual(second.uid, attempt.uid); report.cancelledAttempt = second.uid;
  await request(`/servers/${uid}/installation/cancel`, {});
  await waitFor(async () => (await installation()).state === 'cancelled');
  assert.equal((await installation()).hasUploadedPack, true);
  report.checks.push('retry-new-attempt-and-staging', 'cooperative-cancellation-retains-upload');
  await request(`/servers/${uid}/installation/retry`, {});
  await waitFor(async () => { const current = await installation(); if (current.state === 'failed') throw new Error(current.error); return current.state === 'completed'; }, 300000);
  const completed = await installation(); report.completedAttempt = completed.uid;
  assert.notEqual(completed.uid, second.uid); assert.equal(completed.hasUploadedPack, false);
  assert.equal(await fs.stat(uploaded).catch(() => null), null);
  report.checks.push('retry-completes-original-pack', 'upload-removed-only-after-success');
  await request(`/servers/${uid}/power`, { action: 'start' });
  let server = (await request(`/servers/${uid}`)).server;
  await waitFor(async () => (await docker(['logs', '--tail', '300', server.containerId])).includes('Done ('), 180000);
  const count = (await docker(['ps', '-q', '--filter', `label=${resourcePrefix}.io/server=${uid}`])).trim().split(/\s+/).filter(Boolean).length;
  assert.equal(count, 1); report.checks.push('retried-modpack-starts', 'exactly-one-game-container');
  await request(`/servers/${uid}/power`, { action: 'stop' });
  report.ok = true;
} catch (error) { report.error = error.message; process.exitCode = 1; console.error(error.message); }
finally {
  if (apiStopped) await compose(['start', 'api']).catch(() => {});
  if (cookie && uid) {
    const server = await request(`/servers/${uid}`).then((result) => result.server, () => null);
    if (server?.state === 'running') await request(`/servers/${uid}/power`, { action: 'stop' }).catch(() => {});
    const attempt = await installation().catch(() => null);
    if (attempt && ['queued', 'running'].includes(attempt.state)) await request(`/servers/${uid}/installation/cancel`, {}).catch(() => {});
    if (['offline', 'install_failed', 'crashed'].includes((await request(`/servers/${uid}`).catch(() => ({}))).server?.state)) await request(`/servers/${uid}`, { limits: { memoryMib: 128 } }, 'PATCH').catch(() => {});
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`Installation drill: ${path.join(output, 'result.json')}`);
}
