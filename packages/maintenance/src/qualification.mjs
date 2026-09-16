import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { PrismaClient } from '@serverforge/db';
import { redactText } from '@serverforge/core';

export const gameCases = {
  bedrock: ['minecraft-bedrock', 'bedrock-vanilla', 'latest', 4096],
  vanilla: ['minecraft-java', 'vanilla', '1.20.1', 2048],
  paper: ['minecraft-java', 'paper', '1.20.1', 2048],
  purpur: ['minecraft-java', 'purpur', '1.20.1', 2048],
  fabric: ['minecraft-java', 'fabric', '1.20.1', 2048],
  forge: ['minecraft-java', 'forge', '1.20.1', 3072],
  neoforge: ['minecraft-java', 'neoforge', '1.21.1', 3072],
  'curseforge-zip': ['minecraft-java', 'custom-modpack', '1.21.1', 4096],
  valheim: ['valheim', 'valheim-vanilla', 'latest', 3072],
  'valheim-bepinex': ['valheim', 'valheim-bepinex', 'latest', 3072],
  palworld: ['palworld', 'palworld-vanilla', 'latest', 4096],
  'palworld-pak': ['palworld', 'palworld-modded', 'latest', 4096],
};

export async function qualify(cases, minutes = 180) {
  const configRoot = process.env.INSTALLATION_ROOT;
  const credentials = JSON.parse(await fs.readFile(path.join(configRoot, 'qualification.json'), 'utf8'));
  if (credentials.format !== 1 || credentials.project !== process.env.COMPOSE_PROJECT_NAME)
    throw new Error('Qualification requires an isolated installation created with setup --qualification.');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 330) throw new Error('Qualification runs are bounded to 1–330 minutes.');
  const selected = cases?.length ? cases : ['vanilla', 'fabric', 'forge', 'neoforge', 'valheim', 'valheim-bepinex', 'palworld', 'palworld-pak'];
  if (selected.some((name) => !gameCases[name])) throw new Error(`Choose cases from: ${Object.keys(gameCases).join(', ')}.`);
  const root = path.join(configRoot, 'qualification-results', `${new Date().toISOString().replaceAll(':', '-')}-${randomBytes(3).toString('hex')}`);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + minutes * 60000;
  const base = process.env.API_INTERNAL_URL || 'http://api:8080';
  const db = new PrismaClient();
  const secrets = [credentials.password, credentials.setupToken, ...Object.entries(process.env).filter(([key]) => /SECRET|PASSWORD|TOKEN|KEY/.test(key)).map(([, value]) => value)].filter(Boolean);
  let cookie;
  const report = { format: 'serverforge-game-qualification', version: 1, startedAt: new Date().toISOString(), ok: false, status: 'running', cases: [], limitations: ['These are game startup and lifecycle checks, not a completed platform qualification. Browser, remote-client connectivity, upgrade, full restore, and four-hour soak evidence must also be supplied.', 'Palworld PAK directory readiness does not prove compatibility of an arbitrary third-party PAK. Supply and test a compatible mod before marking mod support qualified.'] };
  const save = () => fs.writeFile(path.join(root, 'result.json'), redactText(JSON.stringify(report, null, 2), secrets) + '\n', { mode: 0o600 });
  async function request(route, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(base + '/api' + route, { method, headers: { origin: base, ...(cookie ? { cookie } : {}), ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
    const result = await response.json(); if (!response.ok) throw new Error(`${route}: ${result.error?.message || response.status}`);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return result;
  }
  async function waitFor(action, timeout) {
    const end = Math.min(deadline, Date.now() + timeout);
    while (Date.now() < end) { if (await action()) return; await new Promise((resolve) => setTimeout(resolve, 1000)); }
    throw new Error('The qualification time limit was reached. Inspect the recorded installation and game log.');
  }
  async function consoleUntil(uid, ready, output) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(deadline - Date.now(), 180000)));
    try {
      while (!controller.signal.aborted) {
      const response = await fetch(`${base}/api/servers/${uid}/console/stream`, { headers: { cookie }, signal: controller.signal });
      if (!response.ok) throw new Error(`Console stream failed (${response.status}).`);
      let carry = '';
      // Abort in finally instead of awaiting cancellation of an endless SSE
      // body when returning from the iterator (which can wait for the deadline).
      for await (const chunk of response.body.values({ preventCancel: true })) {
        carry += Buffer.from(chunk).toString();
        const events = carry.split('\n\n'); carry = events.pop() || '';
        for (const event of events) {
          if (!event.startsWith('event: lines\n')) continue;
          const lines = JSON.parse(event.slice(event.indexOf('data: ') + 6));
          output.push(...lines.map((line) => line.line));
          if (output.length > 10000) output.splice(0, output.length - 10000);
          if (ready(output.join('\n'))) return;
        }
      }
      // The API deliberately rotates streams to re-check account access.
      // Reconnect within the original readiness deadline, retaining the tail.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error('The game did not report readiness before the deadline.');
    } finally { clearTimeout(timer); controller.abort(); }
  }
  try {
    try { await request('/auth/login', { username: credentials.username, password: credentials.password }); }
    catch {
      if (!credentials.setupToken) throw new Error('The qualification owner credentials are no longer valid.');
      await request('/auth/register', { username: credentials.username, displayName: 'Platform qualification', password: credentials.password, setupToken: credentials.setupToken });
    }
    const system = await request('/system/status'); report.capabilities = system.capabilities;
    report.host = await fs.readFile(path.join(configRoot, 'qualification-host.json'), 'utf8').then(JSON.parse, () => ({ status: 'host evidence unavailable' }));
    report.candidate = report.host.candidate;
    report.release = JSON.parse(await fs.readFile('/app/release.json', 'utf8'));
    for (const name of selected) {
      if (Date.now() >= deadline) { report.cases.push({ name, status: 'not-run', reason: 'Run deadline reached.' }); continue; }
      const [gameId, variantId, version, memoryMib] = gameCases[name];
      const entry = { name, gameId, variantId, requestedVersion: version, startedAt: new Date().toISOString(), status: 'running', checks: [] };
      report.cases.push(entry); await save(); console.error(`Qualification: ${name}`);
      const output = [];
      let uid;
      try {
        const game = await request(`/games/${gameId}`);
        const variant = game.variants.find((variant) => variant.id === variantId);
        const configuration = { name: `Qualification ${name}`, gameId, variantId, version, limits: { memoryMib, cpuCores: 2, diskMib: gameId === 'palworld' ? 20480 : 8192, swapMib: 0 }, startOnCreate: false, settings: { ...variant.settings, ...(gameId === 'minecraft-java' ? { 'view-distance': 4, 'simulation-distance': 4 } : {}), ...(gameId === 'valheim' ? { Password: credentials.password, Public: false } : {}), ...(gameId === 'palworld' ? { AdminPassword: credentials.password, RESTAPIEnabled: true } : {}) }, acceptedEula: variant.eula?.key, runtimePlatform: game.compatibility?.platform, allowExperimental: process.env.SF_QUALIFY_EMULATION === 'true' };
        let body = configuration;
        if (name === 'curseforge-zip') {
          const zip = path.join(configRoot, 'qualification-pack.zip');
          const bytes = await fs.readFile(zip);
          entry.packSha256 = createHash('sha256').update(bytes).digest('hex'); entry.packBytes = bytes.length;
          body = new FormData(); body.append('configuration', JSON.stringify(configuration)); body.append('pack', new Blob([bytes]), 'qualification-pack.zip');
        }
        const reusable = process.env.SF_QUALIFY_REUSE === 'true' && name !== 'curseforge-zip'
          ? (await request('/servers')).servers.find((server) => server.name === configuration.name && server.gameId === gameId && server.variantId === variantId && server.installedAt && ['offline', 'crashed'].includes(server.state)) : null;
        if (reusable) {
          uid = reusable.uid;
          await request(`/servers/${uid}`, { settings: configuration.settings, limits: configuration.limits }, 'PATCH');
          entry.checks.push('existing-installation-requalification');
        } else uid = (await request('/servers', body)).server.uid;
        entry.uid = uid; await save();
        if (!reusable) await waitFor(async () => {
          const { installation } = await request(`/servers/${uid}/installation`);
          if (['failed', 'cancelled'].includes(installation?.state)) throw new Error(installation.error);
          return installation?.state === 'completed';
        }, 30 * 60000);
        const installed = (await request(`/servers/${uid}`)).server;
        entry.version = installed.version; entry.build = installed.build; entry.javaMajor = installed.javaMajor; entry.checks.push('installation-completed');
        await request(`/servers/${uid}/power`, { action: 'start' });
        entry.runtime = (await request(`/servers/${uid}/settings`)).appliedAllocation;
        const pattern = gameId === 'minecraft-java' ? /Done \(/ : gameId === 'minecraft-bedrock' ? /Server started\./ : gameId === 'valheim' ? /Game server connected|Session "[^"]+" with join code/ : /Running Palworld dedicated server/i;
        await consoleUntil(uid, (text) => pattern.test(text), output);
        entry.checks.push('game-ready-console');
        if (gameId === 'palworld') {
          const port = installed.allocations.find((allocation) => allocation.purpose === 'rest')?.port;
          const host = `${process.env.BRAND_RESOURCE_PREFIX || 'serverforge'}-${uid}`;
          await waitFor(async () => {
            const response = await fetch(`http://${host}:${port}/v1/api/info`, { headers: { authorization: `Basic ${Buffer.from(`admin:${credentials.password}`).toString('base64')}` }, signal: AbortSignal.timeout(5000) }).catch(() => null);
            if (!response?.ok) return false;
            const info = await response.json();
            if (!info.version || !info.worldguid) return false;
            entry.gameInfo = { version: info.version, worldGuid: info.worldguid };
            return true;
          }, 120000);
          entry.checks.push('authenticated-game-api-ready');
        }
        entry.runtimeVersionLines = output.filter((line) => /Starting minecraft server version|Loading Minecraft|Forge Mod Loader version|NeoForge|Valheim version|Game version|BuildID/i.test(line)).slice(-20);
        if (name === 'valheim-bepinex') { if (!/BepInEx.*5\.4|Chainloader startup complete/i.test(output.join('\n'))) throw new Error('Valheim started, but BepInEx initialization was not observed.'); entry.checks.push('bepinex-loaded'); }
        const usage = await request(`/servers/${uid}/resources`); if (!usage.usage || !(usage.usage.memoryBytes > 0)) throw new Error('Live resource measurements are unavailable.');
        entry.telemetry = usage.usage; entry.containerId = usage.containerId; entry.checks.push('live-telemetry');
        if (['minecraft-java', 'minecraft-bedrock'].includes(gameId)) {
          const bedrock = gameId === 'minecraft-bedrock';
          // Bedrock sends say to players without echoing it to an empty server's
          // console. list provides a native response even when nobody is online.
          await request(`/servers/${uid}/console`, { command: bedrock ? 'list' : 'say ServerForge qualification command received' });
          await consoleUntil(uid, (text) => bedrock ? /There are \d+\/\d+ players online:/.test(text) : text.includes('ServerForge qualification command received'), output);
          entry.checks.push('console-command');
        }
        const stopRequestedAt = Date.now();
        await request(`/servers/${uid}/power`, { action: 'stop' });
        if (gameId === 'palworld') {
          const world = path.join(process.env.DATA_ROOT, uid, 'Pal/Saved/SaveGames/0', entry.gameInfo.worldGuid, 'Level.sav');
          const saved = await fs.stat(world);
          if (saved.mtimeMs < stopRequestedAt - 1000 || saved.size <= 0)
            throw new Error('Palworld stopped without a newly flushed world save.');
          entry.savedWorld = { bytes: saved.size, modifiedAt: saved.mtime.toISOString(), sha256: createHash('sha256').update(await fs.readFile(world)).digest('hex') };
          entry.checks.push('world-flushed-during-safe-shutdown');
        }
        entry.checks.push('stop'); entry.status = name === 'palworld-pak' ? 'mod-test-required' : 'passed';
      } catch (error) { entry.status = 'failed'; entry.error = error.message; }
      finally {
        if (uid) {
          const installation = await db.installationAttempt.findFirst({ where: { server: { uid } }, orderBy: { createdAt: 'desc' } });
          if (installation && ['queued', 'running'].includes(installation.state)) await request(`/servers/${uid}/installation/cancel`, {}).catch(() => {});
          let server = await db.server.findUnique({ where: { uid } });
          if (server?.state === 'running') await request(`/servers/${uid}/power`, { action: 'stop' }).catch(() => {});
          server = await db.server.findUnique({ where: { uid } });
          // Retain files for inspection while releasing reserved test RAM.
          if (server && ['offline', 'crashed', 'install_failed'].includes(server.state)) await request(`/servers/${uid}`, { limits: { memoryMib: 128 } }, 'PATCH').catch(() => {});
          const installLog = await db.installLog.findMany({ where: { server: { uid } }, select: { phase: true, message: true }, take: 3000, orderBy: { id: 'desc' } });
          await fs.writeFile(path.join(root, `${name}-installation.json`), redactText(JSON.stringify(installLog.reverse(), null, 2), secrets), { mode: 0o600 });
        }
        await fs.writeFile(path.join(root, `${name}-console.log`), redactText(output.join('\n'), secrets), { mode: 0o600 });
        entry.finishedAt = new Date().toISOString(); await save();
      }
    }
    report.ok = report.cases.every((entry) => entry.status === 'passed');
    report.status = 'awaiting-platform-qualification';
  } finally { report.finishedAt = new Date().toISOString(); await save(); await db.$disconnect(); }
  return { ...report, reportDirectory: root };
}
