#!/usr/bin/env node
// Destructive qualification is confined to fresh directories and unique projects.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseEnv } from '../packages/maintenance/src/environment.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const legacyImages = { api: process.env.SF_LEGACY_API_IMAGE, web: process.env.SF_LEGACY_WEB_IMAGE };
const candidateImages = {
  api: process.env.SF_API_TEST_IMAGE || 'serverforge-rc-api:check',
  web: process.env.SF_WEB_TEST_IMAGE || 'serverforge-rc-web:check',
};
if (Object.values(legacyImages).some((image) => !/^sha256:[a-f0-9]{64}$/.test(image || ''))) throw new Error('Select explicit retained legacy API/web image IDs. This drill never discovers a live installation.');
const endpoint = process.env.DOCKER_HOST || `unix://${process.env.DOCKER_SOCKET}`;
if (!endpoint.startsWith('unix://') || endpoint.endsWith('undefined')) throw new Error('Select the isolated local Docker socket.');
const env = { ...process.env, DOCKER_HOST: endpoint, SERVERFORGE_MAINTENANCE_IMAGE: process.env.SF_MAINTENANCE_TEST_IMAGE || 'serverforge-rc-maintenance:check' };
const root = await fs.mkdtemp(path.join(repo, 'data/release-tests/host-upgrade-'));
const report = { format: 'serverforge-host-upgrade-drill', version: 1, startedAt: new Date().toISOString(), ok: false, legacyImages, cases: [], limitations: ['Local Linux Docker Desktop. Other platform rows require their own results. Legacy background workers are disabled to isolate migration/rollback from old host-network behavior. World data is a filesystem sentinel; real-game restore has a separate report.'] };
const save = () => fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
let logNumber = 0;
function run(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: repo, env: { ...env, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (v) => { out = (out + v).slice(-2000000); });
    child.stderr.on('data', (v) => { err = (err + v).slice(-2000000); });
    child.stdin.end(options.input);
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout || 300000);
    child.on('error', reject);
    child.on('close', async (code) => {
      clearTimeout(timer);
      const file = path.join(root, `command-${++logNumber}.log`);
      await fs.writeFile(file, (out + err).replace(/One-time owner setup token: \S+/g, 'One-time owner setup token: [redacted]'), { mode: 0o600 });
      code === 0 ? resolve(out.trim()) : reject(new Error(`${program} exited ${code}; inspect ${path.basename(file)}.`));
    });
  });
}
const launch = (home, args) => run('bash', ['release/serverforge', ...args], { env: { SERVERFORGE_HOME: home } });
const port = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const value = s.address().port; s.close(() => resolve(String(value))); }); });
const q = (value) => `'${String(value).replaceAll("'", "''")}'`;
const names = (await fs.readdir('packages/db/prisma/migrations')).filter((name) => /^\d/.test(name)).sort();
const version = JSON.parse(await fs.readFile('release.json', 'utf8')).version;
try {
  for (const state of [1, 2]) {
    const home = path.join(root, `legacy-${state}`); await fs.mkdir(home, { mode: 0o700 });
    const entry = { legacyState: state, checks: [], ok: false }; report.cases.push(entry); await save();
    let config;
    const base = ['compose', '--project-directory', path.join(home, 'config'), '--env-file', path.join(home, 'config/.env'), '-f', path.join(home, 'config/compose.yml')];
    const dockerCompose = (args, options) => run('docker', [...base, ...args], options);
    try {
      const webPort = await port(), apiPort = await port();
      await launch(home, ['setup', '--configure-only', '--port', webPort, '--api-image', candidateImages.api, '--web-image', candidateImages.web]);
      config = parseEnv(await fs.readFile(path.join(home, 'config/.env'), 'utf8'));
      assert.match(config.COMPOSE_PROJECT_NAME, /^serverforge-[a-f0-9]{10}$/); assert.equal(config.BRAND_RESOURCE_PREFIX, config.COMPOSE_PROJECT_NAME);
      entry.project = config.COMPOSE_PROJECT_NAME;
      await dockerCompose(['up', '-d', '--wait', 'postgres']);
      const sql = async (text) => dockerCompose(['exec', '-T', 'postgres', 'psql', '-U', config.POSTGRES_USER, '-d', config.POSTGRES_DB, '-v', 'ON_ERROR_STOP=1', '-At'], { input: text });
      for (const name of names.slice(0, state)) await sql(await fs.readFile(path.join('packages/db/prisma/migrations', name, 'migration.sql'), 'utf8'));
      const world = path.join(config.HOST_DATA_ROOT, 'legacyworld/world'); await fs.mkdir(world, { recursive: true });
      const sentinel = randomBytes(512); await fs.writeFile(path.join(world, 'checkpoint.dat'), sentinel);
      entry.worldSha256 = createHash('sha256').update(sentinel).digest('hex');
      await sql(`INSERT INTO "User" (id,uid,username,"displayName","passwordHash",role,"updatedAt") VALUES ('legacy-owner','owner-uid','legacy-owner','Legacy owner','preserved-password-hash','owner',NOW());
INSERT INTO "Node" (id,uid,name,"dataRoot","backupRoot","updatedAt") VALUES ('legacy-node','node-uid','Legacy node',${q(config.HOST_DATA_ROOT)},${q(config.HOST_BACKUP_ROOT)},NOW());
INSERT INTO "Server" (id,uid,name,state,"ownerId","nodeId","gameId","variantId",version,"memoryMib","cpuCores","diskMib","dataPath","updatedAt") VALUES ('legacy-server','legacyworld','Preserved world','offline','legacy-owner','legacy-node','minecraft-java','vanilla','1.20.1',128,1,1024,${q(path.dirname(world))},NOW());
INSERT INTO "Setting" (key,value,"updatedAt") VALUES ('network.preferences','{"upnp":false,"preserve":"legacy"}',NOW());`);
      const override = path.join(home, 'legacy-images.json');
      await fs.writeFile(override, JSON.stringify({ services: { api: { image: legacyImages.api, environment: { WORKER: '0', HEALTH_PATH: '/health' }, ports: [`127.0.0.1:${apiPort}:8080`] }, web: { image: legacyImages.web } } }));
      await run('docker', [...base, '-f', override, 'up', '-d', 'api', 'web']);
      const apiId = await dockerCompose(['ps', '-q', 'api']);
      const before = JSON.parse(await run('docker', ['inspect', apiId]))[0];
      const sourceText = await fs.readFile(path.join(home, 'config/.env'), 'utf8');
      await fs.writeFile(path.join(home, '.env'), sourceText, { mode: 0o600 });
      await fs.rename(path.join(home, 'config'), path.join(home, 'source-config'));
      await launch(home, ['adopt', '--project', config.COMPOSE_PROJECT_NAME]);
      const adopted = parseEnv(await fs.readFile(path.join(home, 'config/.env'), 'utf8'));
      for (const key of ['SESSION_SECRET','ENCRYPTION_KEY','HOST_DATA_ROOT','HOST_BACKUP_ROOT','WEB_PORT','BRAND_RESOURCE_PREFIX']) assert.equal(adopted[key], config[key]);
      assert.equal(JSON.parse(await run('docker', ['inspect', apiId]))[0].State.StartedAt, before.State.StartedAt);
      entry.checks.push('adoption-preserves-running-container-paths-secrets-port');
      await launch(home, ['upgrade', version, '--api-image', candidateImages.api, '--web-image', candidateImages.web, '--maintenance-image', env.SERVERFORGE_MAINTENANCE_IMAGE]);
      assert.equal(await sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;'), '3');
      assert.equal(await sql('SELECT "passwordHash" FROM "User" WHERE id=\'legacy-owner\';'), 'preserved-password-hash');
      assert.equal(await sql('SELECT uid FROM "Server" WHERE id=\'legacy-server\';'), 'legacyworld');
      assert.deepEqual(await fs.readFile(path.join(world, 'checkpoint.dat')), sentinel);
      const upgradedId = await dockerCompose(['ps', '-q', 'api']);
      entry.images = {};
      for (const [component, reference] of Object.entries({ ...candidateImages, maintenance: env.SERVERFORGE_MAINTENANCE_IMAGE, postgres: adopted.POSTGRES_IMAGE })) {
        const [image] = JSON.parse(await run('docker', ['image', 'inspect', reference]));
        entry.images[component] = { reference, digest: image.Id, architecture: image.Architecture };
        if (component !== 'maintenance') {
          const container = JSON.parse(await run('docker', ['inspect', await dockerCompose(['ps', '-q', component])]))[0];
          assert.equal(container.Image, image.Id);
        }
      }
      assert.equal(Object.keys(JSON.parse(await run('docker', ['inspect', upgradedId]))[0].HostConfig.PortBindings || {}).length, 0);
      entry.checks.push('backed-up-legacy-schema-upgrade','account-server-world-preserved','new-api-private');
      await launch(home, ['rollback']);
      assert.equal(await sql("SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='_prisma_migrations';"), '0');
      assert.equal(await sql("SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='Invitation';"), '0');
      assert.equal(await sql('SELECT "passwordHash" FROM "User" WHERE id=\'legacy-owner\';'), 'preserved-password-hash');
      const rolledId = await dockerCompose(['ps', '-q', 'api']);
      const rolled = JSON.parse(await run('docker', ['inspect', rolledId]))[0];
      assert.equal(rolled.Image, legacyImages.api); assert.equal(rolled.HostConfig.PortBindings['8080/tcp'][0].HostPort, apiPort);
      assert.deepEqual(await fs.readFile(path.join(world, 'checkpoint.dat')), sentinel);
      await launch(home, ['stop']); await launch(home, ['start']);
      assert.equal(await sql("SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='_prisma_migrations';"), '0');
      entry.checks.push('schema-incompatible-rollback-restores-database','legacy-api-port-restored','legacy-restart-does-not-migrate','world-unchanged-after-rollback');
      entry.ok = true;
    } finally {
      if (config) {
        assert.match(config.COMPOSE_PROJECT_NAME, /^serverforge-[a-f0-9]{10}$/);
        const ids = (await run('docker', ['ps','-aq','--filter',`label=com.docker.compose.project=${config.COMPOSE_PROJECT_NAME}`])).split(/\s+/).filter(Boolean);
        for (const id of ids) assert.equal(JSON.parse(await run('docker',['inspect',id]))[0].Config.Labels['com.docker.compose.project'],config.COMPOSE_PROJECT_NAME);
        if (ids.length) await run('docker',['rm','-f',...ids]);
        const volumes = (await run('docker',['volume','ls','-q','--filter',`label=com.docker.compose.project=${config.COMPOSE_PROJECT_NAME}`])).split(/\s+/).filter(Boolean);
        if (volumes.length) await run('docker',['volume','rm',...volumes]);
        const networks = (await run('docker',['network','ls','-q','--filter',`label=com.docker.compose.project=${config.COMPOSE_PROJECT_NAME}`])).split(/\s+/).filter(Boolean);
        for (const id of networks) {
          const [network] = JSON.parse(await run('docker',['network','inspect',id]));
          assert.equal(network.Labels['com.docker.compose.project'], config.COMPOSE_PROJECT_NAME);
          assert.equal(Object.keys(network.Containers || {}).length, 0);
        }
        if (networks.length) await run('docker',['network','rm',...networks]);
      }
      await save();
    }
    console.log(`Legacy state ${state}: adoption, upgrade and schema rollback passed.`);
  }
  report.ok = true;
} catch (error) { report.error = error.message; process.exitCode = 1; console.error(error.message); }
finally { report.finishedAt = new Date().toISOString(); await save(); console.log(`Host upgrade result: ${path.join(root,'result.json')}`); }
