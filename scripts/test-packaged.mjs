#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { parseEnv } from '../packages/maintenance/src/environment.mjs';

const root = path.resolve(import.meta.dirname, '..');
const testsRoot = path.join(root, 'data/release-tests');
await fs.mkdir(testsRoot, { recursive: true });
const scratch = await fs.mkdtemp(path.join(testsRoot, 'serverforge-packaged-'));
const endpoint = process.env.DOCKER_HOST || (process.env.DOCKER_SOCKET ? `unix://${process.env.DOCKER_SOCKET}` : execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim());
const env = { ...process.env, DOCKER_HOST: endpoint, SERVERFORGE_HOME: scratch, SERVERFORGE_MAINTENANCE_IMAGE: process.env.SF_MAINTENANCE_TEST_IMAGE || 'serverforge-rc-maintenance:check' };
if (!endpoint.startsWith('unix://')) throw new Error('Use a local Linux-container Docker host for qualification.');
function run(command, args, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { output = (output + data).slice(-2 * 1024 * 1024); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`${command} failed (${code}): ${output.replace(/One-time owner setup token: \S+/g, 'One-time owner setup token: [redacted]')}`)));
  });
}
async function removeFixtureGames(config) {
      if (!/^serverforge-[a-f0-9]{10}$/.test(config.COMPOSE_PROJECT_NAME) || config.BRAND_RESOURCE_PREFIX !== config.COMPOSE_PROJECT_NAME)
        throw new Error('Refusing cleanup without a unique fixture ownership prefix.');
      const label = `${config.BRAND_RESOURCE_PREFIX}.io/managed`;
      const ids = (await run('docker', ['ps', '-aq', '--filter', `label=${label}=true`])).trim().split(/\s+/).filter(Boolean);
      for (const id of ids) {
        const [container] = JSON.parse(await run('docker', ['inspect', id]));
        const bind = container.Mounts.find((mount) => mount.Type === 'bind' && mount.Destination === container.Config.WorkingDir);
        if (container.Config.Labels[label] !== 'true' || !container.Name.startsWith(`/${config.BRAND_RESOURCE_PREFIX}-`) || !bind?.Source.startsWith(path.join(scratch, 'data/servers') + '/'))
          throw new Error('Refusing cleanup of a container whose fixture mount does not match.');
        await run('docker', ['rm', '-f', id]);
      }
}
const launch = (args) => run('bash', ['release/serverforge', ...args]);
  async function ownHostCommands() {
    const ids = (await run('docker', ['ps', '-q', '--filter', 'label=serverforge.io/maintenance=true'])).split(/\s+/).filter(Boolean);
    const own = [];
    for (const id of ids) {
      const [details] = JSON.parse(await run('docker', ['inspect', id]));
      if (details.Config.Env.includes(`SF_HOST_ROOT=${scratch}`) && details.Config.Labels['serverforge.io/maintenance'] === 'true') own.push(id);
    }
    return own;
  }
const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const result = { format: 'serverforge-packaged-check', version: 1, startedAt: new Date().toISOString(), ok: false, checks: [], limitations: ['Linux Docker Desktop browser and Minecraft checks; other game families, external clients and other host platforms require separate evidence.'] };
try {
  console.log(`Testing isolated packaged installation in ${scratch}`);
  const setup = await launch(['setup', '--port', String(port), '--api-image', 'serverforge-rc-api:check', '--web-image', 'serverforge-rc-web:check']);
  await fs.writeFile(path.join(scratch, 'setup.log'), setup, { mode: 0o600 });
  const token = /One-time owner setup token: (\S+)/.exec(setup)?.[1];
  if (!token) throw new Error('Setup did not supply a one-time token.');
  const configStat = await fs.stat(path.join(scratch, 'config'));
  const envStat = await fs.stat(path.join(scratch, 'config/.env'));
  const hostStat = await fs.stat(scratch);
  if (configStat.uid !== hostStat.uid || envStat.uid !== hostStat.uid || (configStat.mode & 0o777) !== 0o700 || (envStat.mode & 0o777) !== 0o600)
    throw new Error('The host user must own private configuration without widening its permissions.');
  result.checks.push('host-owned-private-configuration');
  const composeArgs = ['compose', '--project-directory', path.join(scratch, 'config'), '--env-file', path.join(scratch, 'config/.env'), '-f', path.join(scratch, 'config/compose.yml')];
  // Only this freshly created database is touched. Keep game ports separate
  // from both the live installation and the other qualification fixture.
  await run('docker', [...composeArgs, 'exec', '-T', 'postgres', 'psql', '-U', 'serverforge', '-d', 'serverforge', '-v', 'ON_ERROR_STOP=1', '-c', 'BEGIN; DELETE FROM "Allocation" WHERE "serverId" IS NULL; UPDATE "Node" SET "portRangeStart"=32500,"portRangeEnd"=32999; INSERT INTO "Allocation" (id,"nodeId",ip,port,purpose,"primary") SELECT md5(n.id||p::text),n.id,\'0.0.0.0\',p,\'game\',false FROM "Node" n CROSS JOIN generate_series(32500,32999) p; COMMIT;']);
  result.checks.push('image-based-setup-and-readiness');
  console.log('Packaged installation ready; exercising browser workflows.');
  const password = randomBytes(24).toString('hex');
  // Private credentials let a retained fixture be inspected or used for the
  // separate fresh-host world-recovery drill. Never include them in artifacts.
  await fs.writeFile(path.join(scratch, 'browser-credentials.json'), JSON.stringify({ username: 'release-owner', password }), { mode: 0o600 });
  const browser = await run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test'], { SF_TEST_BROWSER_URL: `http://127.0.0.1:${port}`, SF_TEST_SETUP_TOKEN: token, SF_TEST_OWNER_PASSWORD: password, SF_TEST_BROWSER_OUTPUT: path.join(scratch, 'browser-output'), SF_TEST_BROWSER_RESULT: path.join(scratch, 'browser-result.json') });
  await fs.writeFile(path.join(scratch, 'browser.log'), browser, { mode: 0o600 });
  const browserResult = JSON.parse(await fs.readFile(path.join(scratch, 'browser-result.json'), 'utf8'));
  if (!browserResult.stats.expected || browserResult.stats.unexpected || browserResult.stats.skipped || browserResult.stats.flaky)
    throw new Error('Required browser checks failed, were skipped, or retried.');
  result.checks.push('browser-owner-invitation-account-network-dark-mode-mobile', 'browser-axe-wcag-aa-light-dark-desktop-mobile-reflow');
  result.checks.push('browser-minecraft-install-console-telemetry-configuration-backup-world-restore', 'browser-zip-upload-client-export-error-retention-retry-removal');
  const backup = await launch(['backup']);
  await fs.writeFile(path.join(scratch, 'backup-result.json'), backup, { mode: 0o600 });
  const full = await launch(['backup', '--full']);
  await fs.writeFile(path.join(scratch, 'full-result.json'), full, { mode: 0o600 });
  result.checks.push('online-panel-backup', 'full-backup-maintenance-resume');
  const manifest = JSON.parse(full);
  const hostBundle = path.join(scratch, 'data/recovery', path.basename(manifest.directory));
  await launch(['verify', hostBundle]);
  result.checks.push('host-bundle-verification');
  console.log('Testing backed-up upgrade and declared image rollback.');
  const version = JSON.parse(await fs.readFile(path.join(root, 'release.json'), 'utf8')).version;
  await launch(['upgrade', version, '--api-image', 'serverforge-rc-api:check', '--web-image', 'serverforge-rc-web:check', '--maintenance-image', env.SERVERFORGE_MAINTENANCE_IMAGE]);
  await launch(['rollback']);
  result.checks.push('backed-up-upgrade', 'declared-image-rollback');
  console.log('Terminating the host upgrade command after migrations, then recovering its checkpoint.');
  const beforeFault = parseEnv(await fs.readFile(path.join(scratch, 'config/.env'), 'utf8'));
  const faultTag = `serverforge-upgrade-fault:${randomBytes(6).toString('hex')}`;
  const faultContext = path.join(scratch, 'fault-image'); await fs.mkdir(faultContext);
  await fs.writeFile(path.join(faultContext, 'Dockerfile'), 'FROM serverforge-rc-api:check\nCMD ["node", "-e", "setInterval(() => {}, 1000)"]\n');
  await run('docker', ['build', '--network', 'none', '-t', faultTag, faultContext]);
  const [faultImage] = JSON.parse(await run('docker', ['image', 'inspect', faultTag]));
  const interrupted = launch(['upgrade', version, '--api-image', faultTag, '--web-image', 'serverforge-rc-web:check', '--maintenance-image', env.SERVERFORGE_MAINTENANCE_IMAGE]).then(() => null, (error) => error);
  const until = Date.now() + 180000;
  let migrated = false;
  while (Date.now() < until) {
    const journal = await fs.readFile(path.join(scratch, 'config/upgrade.json'), 'utf8').then(JSON.parse, () => null);
    if (journal?.step === 'migrated' && journal.after.API_IMAGE === faultImage.Id) { migrated = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!migrated) throw new Error('Fault-injection upgrade did not reach its durable migration checkpoint.');

  const hosts = await ownHostCommands();
  if (hosts.length !== 1) throw new Error('Refusing interruption without exactly one fixture-owned host command.');
  await run('docker', ['kill', hosts[0]]);
  if (!await interrupted) throw new Error('The interrupted host command unexpectedly succeeded.');
  if ((await ownHostCommands()).length) throw new Error('A fixture host command is still running; preserve its maintenance lock.');
  // This is the documented interrupted-host recovery step, limited to the
  // fresh test directory after verifying that its lock has no running owner.
  await fs.rm(path.join(scratch, '.serverforge-maintenance-lock'), { recursive: true });
  await launch(['rollback']);
  const recovered = parseEnv(await fs.readFile(path.join(scratch, 'config/.env'), 'utf8'));
  if (recovered.API_IMAGE !== beforeFault.API_IMAGE || JSON.parse(await fs.readFile(path.join(scratch, 'config/upgrade.json'), 'utf8')).step !== 'rolled-back') throw new Error('Interrupted upgrade did not restore its recorded image checkpoint.');
  await run('docker', ['image', 'rm', faultTag]);
  result.checks.push('host-command-kill-after-migration', 'documented-stale-lock-recovery', 'interrupted-upgrade-rollback-ready');
  await launch(['diagnostics']);
  result.checks.push('redacted-host-diagnostics');
  result.ok = true;
} catch (error) { result.error = error.message; console.error(error.message); process.exitCode = 1; }
finally {
  if (!process.argv.includes('--keep')) {
    try {
      for (const id of await ownHostCommands()) await run('docker', ['kill', id]);
      const config = parseEnv(await fs.readFile(path.join(scratch, 'config/.env'), 'utf8'));
      await removeFixtureGames(config);
      await run('docker', ['compose', '--project-directory', path.join(scratch, 'config'), '--env-file', path.join(scratch, 'config/.env'), '-f', path.join(scratch, 'config/compose.yml'), '--profile', 'backups', '--profile', 'tools', 'down', '--volumes']);
      result.project = config.COMPOSE_PROJECT_NAME;
    } catch (error) { result.cleanupError = error.message; result.ok = false; process.exitCode = 1; }
  }
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(scratch, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(`Packaged result: ${path.join(scratch, 'result.json')}`);
}
