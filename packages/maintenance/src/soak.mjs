import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { redactText } from '@serverforge/core';

export async function soak(uid, minutes = 240) {
  const config = process.env.INSTALLATION_ROOT;
  const credentials = JSON.parse(await fs.readFile(path.join(config, 'qualification.json'), 'utf8'));
  if (credentials.format !== 1 || credentials.project !== process.env.COMPOSE_PROJECT_NAME)
    throw new Error('Soak checks require a separate setup --qualification installation.');
  if (!/^[a-z0-9-]+$/.test(uid || '') || !Number.isInteger(minutes) || minutes < 1 || minutes > 330)
    throw new Error('Choose a qualification server UID and 1–330 minutes. The release gate requires 240 minutes.');
  const base = process.env.API_INTERNAL_URL || 'http://api:8080';
  const started = Date.now(), deadline = started + minutes * 60000;
  const root = path.join(config, 'qualification-results', `soak-${new Date().toISOString().replaceAll(':', '-')}-${randomBytes(3).toString('hex')}`);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const report = { format: 'serverforge-mixed-operation-soak', version: 1, uid, requestedMinutes: minutes, startedAt: new Date(started).toISOString(), status: 'running', ok: false, cycles: [], samples: [], limitations: ['Only the selected isolated Minecraft server is exercised. Game compatibility, external-client connectivity and host installation/recovery require their own qualification evidence.'] };
  report.candidate = JSON.parse(await fs.readFile(path.join(config, 'qualification-host.json'), 'utf8')).candidate;
  const save = () => fs.writeFile(path.join(root, 'result.json'), redactText(JSON.stringify(report, null, 2), [credentials.password, credentials.setupToken || '']) + '\n', { mode: 0o600 });
  let cookie, stopped = false;
  const interrupt = () => { stopped = true; };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, interrupt);
  async function request(route, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(base + '/api' + route, { method, headers: { origin: base, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
    const value = await response.json();
    if (!response.ok) throw new Error(`${route}: ${value.error?.message || response.status}`);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return value;
  }
  async function waitFor(action, timeout = 180000) {
    const until = Math.min(deadline + 180000, Date.now() + timeout);
    while (Date.now() < until && !stopped) { if (await action()) return; await new Promise((resolve) => setTimeout(resolve, 1000)); }
    throw new Error('An operation exceeded its deadline or the soak was interrupted.');
  }
  async function consoleCheck(command, expected) {
    await request(`/servers/${uid}/console`, { command });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      let text = '';
      while (!controller.signal.aborted) {
        const response = await fetch(`${base}/api/servers/${uid}/console/stream`, { headers: { cookie }, signal: controller.signal });
        if (!response.ok) throw new Error('Console stream unavailable.');
        for await (const bytes of response.body.values({ preventCancel: true })) {
          text = (text + Buffer.from(bytes).toString()).slice(-256000);
          if (text.includes(expected)) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error('Console disconnected before its command was confirmed.');
    } finally { controller.abort(); clearTimeout(timer); }
  }
  const game = async () => (await request(`/servers/${uid}`)).server;
  async function ready() {
    await waitFor(async () => {
      const state = await game();
      if (['crashed', 'suspended', 'install_failed'].includes(state.state)) throw new Error(`Game entered ${state.state}.`);
      return state.state === 'running';
    });
    // Commands issued before Minecraft finishes loading remain in stdin until ready.
    const marker = `soak-ready-${randomBytes(6).toString('hex')}`;
    await consoleCheck(`say ${marker}`, marker);
  }
  try {
    await request('/auth/login', { username: credentials.username, password: credentials.password });
    const server = await game();
    if (server.gameId !== 'minecraft-java' || !server.name.startsWith('Qualification ') || !server.installedAt)
      throw new Error('Choose a Minecraft server created by this installation’s qualifier.');
    await request(`/servers/${uid}`, { limits: { memoryMib: 2048, cpuCores: 2, swapMib: 0 } }, 'PATCH');
    if (server.state !== 'running') await request(`/servers/${uid}/power`, { action: 'start' });
    await ready();
    await request(`/servers/${uid}/console`, { command: 'scoreboard objectives add sf_soak dummy' });
    await consoleCheck('scoreboard players set checkpoint sf_soak 14092026', '14092026');
    while (Date.now() < deadline && !stopped) {
      const cycle = { at: new Date().toISOString(), checks: [] };
      report.cycles.push(cycle);
      await request(`/servers/${uid}`, { settings: { motd: `ServerForge soak cycle ${report.cycles.length}` } }, 'PATCH');
      cycle.checks.push('configuration-save');
      await request(`/servers/${uid}/console`, { command: 'save-all flush' });
      const name = `Soak ${randomBytes(6).toString('hex')}`;
      await request(`/servers/${uid}/backups`, { name });
      let selected;
      await waitFor(async () => {
        const data = await request(`/servers/${uid}/backups`);
        selected = data.backups.find((backup) => backup.name === name);
        if (selected?.state === 'failed') throw new Error(selected.error);
        return !data.busy && selected?.state === 'completed';
      }, 300000);
      cycle.backupUid = selected.uid; cycle.checks.push('consistent-backup-and-resume');
      await ready();
      await request(`/servers/${uid}/backups/${selected.uid}/restore`, {});
      await waitFor(async () => !(await request(`/servers/${uid}/backups`)).busy && (await game()).state === 'offline', 300000);
      await request(`/servers/${uid}/power`, { action: 'start' }); await ready();
      await consoleCheck('scoreboard players get checkpoint sf_soak', '14092026');
      cycle.checks.push('restore-restart-world-content');
      const until = Math.min(deadline, Date.now() + 10 * 60000);
      while (Date.now() < until && !stopped) {
        const [status, usage, current] = await Promise.all([request('/system/status'), request(`/servers/${uid}/resources`), game()]);
        if (!status.ok || status.activeOperations.length !== 0 || current.state !== 'running' || !usage.usage || usage.usage.memoryBytes <= 0)
          throw new Error('Readiness, game state or real telemetry became unavailable.');
        report.samples.push({ at: new Date().toISOString(), panel: status.processMetrics, game: usage.usage, activeOperations: status.activeOperations.length });
        await save();
        await new Promise((resolve) => setTimeout(resolve, 15000));
      }
      cycle.finishedAt = new Date().toISOString();
      // This is a dedicated qualification server; retain its last two soak
      // snapshots and last two safety snapshots made by the restore workflow.
      const backups = await request(`/servers/${uid}/backups`);
      for (const prefix of ['Soak ', 'Before restore']) {
        for (const backup of backups.backups.filter((backup) => backup.state === 'completed' && backup.name.startsWith(prefix)).slice(2))
          await request(`/servers/${uid}/backups/${backup.uid}`, undefined, 'DELETE');
      }
      await save();
    }
    const warm = report.samples.filter((sample) => new Date(sample.at).getTime() - started > 15 * 60000 && sample.panel?.rssBytes);
    if (warm.length > 20) {
      const count = Math.floor(warm.length / 4);
      const average = (samples) => samples.reduce((sum, sample) => sum + sample.panel.rssBytes, 0) / samples.length;
      const first = average(warm.slice(0, count)), last = average(warm.slice(-count));
      report.memoryGrowth = { firstQuarterRss: first, lastQuarterRss: last, permittedGrowthBytes: Math.max(128 * 1024 ** 2, first * 0.5) };
      if (last - first > report.memoryGrowth.permittedGrowthBytes) throw new Error('Panel RSS growth exceeded the declared soak threshold. Review samples and repeat after investigation.');
    }
    report.ok = !stopped && Date.now() - started >= 240 * 60000 && report.cycles.length >= 8 && warm.length >= 100;
    report.status = report.ok ? 'passed' : 'incomplete-duration';
  } catch (error) { report.status = 'failed'; report.error = error.message; }
  finally {
    if (cookie) {
      const server = await game().catch(() => null);
      if (server?.name.startsWith('Qualification ') && ['running', 'starting'].includes(server.state))
        await request(`/servers/${uid}/power`, { action: 'stop' }).catch((error) => { report.cleanupError = error.message; report.ok = false; });
    }
    report.finishedAt = new Date().toISOString(); report.elapsedMinutes = (Date.now() - started) / 60000;
    await save();
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, interrupt);
  }
  return { ...report, reportDirectory: root };
}
