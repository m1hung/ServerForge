#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freeSpace } from './recovery.mjs';
import { parseEnv } from './environment.mjs';
import net from 'node:net';

const installation = '/installation';
// The launcher creates this directory as the host user. Preserve that user's
// access to private configuration on Linux, including when the command crashes.
const hostOwner = await fs.stat(installation);
const configRoot = path.join(installation, 'config');
const configFile = path.join(configRoot, '.env');
const hostRoot = process.env.SF_HOST_ROOT;
if (!hostRoot || !path.isAbsolute(hostRoot))
  throw new Error('Run maintenance through the supplied host launcher.');
const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../release');
const release = JSON.parse(await fs.readFile(path.join(assets, '../release.json'), 'utf8'));
const [action = 'status', ...args] = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const secret = () => randomBytes(32).toString('hex');
const envQuote = (value) => JSON.stringify(String(value)).replaceAll('$', '$$');
async function run(command, argv, { echo = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout = (stdout + data).slice(-1024 * 1024);
      if (echo) process.stdout.write(data);
    });
    child.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(-32000);
      if (echo) process.stderr.write(data);
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(
            new Error(
              `${command} ${argv.slice(0, 2).join(' ')} failed (${code}): ${stderr || stdout}`,
            ),
          ),
    );
  });
}
async function atomic(file, contents) {
  const temporary = `${file}.partial`;
  const handle = await fs.open(temporary, 'w', 0o600);
  try {
    await handle.chown(hostOwner.uid, hostOwner.gid);
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
}
const writeJson = (file, value) => atomic(file, `${JSON.stringify(value, null, 2)}\n`);
async function saveConfig(values) {
  await atomic(
    configFile,
    Object.entries(values)
      .map(([key, value]) => `${key}=${envQuote(value)}`)
      .join('\n') + '\n',
  );
}
async function readConfig() {
  return parseEnv(await fs.readFile(configFile, 'utf8'));
}
async function compose(argv, options) {
  const current = await readConfig();
  // Original dashboards call the API's published port directly. Restore that
  // binding only with the recorded legacy images; new releases use the proxy.
  const legacy = current.APP_VERSION === 'legacy' && await fs.stat(path.join(configRoot, 'legacy-runtime.json')).catch(() => null);
  return run(
    'docker',
    [
      'compose',
      '--project-directory',
      configRoot,
      '--env-file',
      configFile,
      '-f',
      path.join(configRoot, 'compose.yml'),
      ...(legacy ? ['-f', path.join(configRoot, 'legacy-runtime.json')] : []),
      ...argv,
    ],
    options,
  );
}
const maintenance = (argv, extra = []) =>
  compose([
    '--profile',
    'tools',
    'run',
    '--rm',
    '--no-deps',
    '-T',
    ...extra,
    'maintenance',
    'packages/maintenance/src/cli.mjs',
    ...argv,
  ]);
async function imageInfo(image) {
  if (!image || image.startsWith('-') || /\s/.test(image))
    throw new Error('Choose a valid local image reference.');
  const [details] = JSON.parse(await run('docker', ['image', 'inspect', image]));
  // Keep prior release layers reachable when a development tag is rebuilt.
  // Readiness for rollback must be checked before any running panel is stopped.
  await run('docker', ['image', 'tag', details.Id, `serverforge-retained:${details.Id.replace('sha256:', '')}`]);
  return {
    reference: image,
    digest: details.Id,
    architecture: details.Architecture,
    version: details.Config.Labels?.['org.opencontainers.image.version'] || 'unknown',
    postgresMajor: details.Config.Env?.find((entry) => entry.startsWith('PG_MAJOR='))?.slice(9) || null,
  };
}
async function repairCollation(force = false, beforeReindex = async () => {}) {
  const current = await readConfig();
  const sql = (statement) => compose(['exec', '-T', 'postgres', 'psql', '-X', '-U', current.POSTGRES_USER, '-d', current.POSTGRES_DB, '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement]);
  const state = JSON.parse(await sql("SELECT json_build_object('database',datname,'recorded',datcollversion,'actual',pg_database_collation_actual_version(oid)) FROM pg_database WHERE datname=current_database()"));
  if (!force && state.recorded === state.actual) return { ...state, rebuilt: false };
  const needed = Number(await sql('SELECT pg_database_size(current_database())')) + 64 * 1024 ** 2;
  const disk = await compose(['exec', '-T', 'postgres', 'df', '-Pk', '/var/lib/postgresql/data']);
  const available = Number(disk.trim().split('\n').at(-1).trim().split(/\s+/)[3]) * 1024;
  if (!Number.isSafeInteger(needed) || !Number.isFinite(available) || available < needed)
    throw new Error('Database sorting changed, but there is insufficient database-volume space to rebuild indexes. Free space and recover this upgrade checkpoint.');
  // Persist intent before rebuilding: an interrupted rebuild may leave some
  // indexes using the selected library even if its version was never recorded.
  await beforeReindex();
  console.log('Rebuilding database indexes for the selected image. The panel remains stopped.');
  await sql('REINDEX DATABASE');
  const metadataAdopted = (state.recorded === null) !== (state.actual === null);
  // PostgreSQL 17 REFRESH rejects transitions to/from an unrecorded version
  // (for example musl/glibc). Adopt this one database's actual metadata only
  // after the verified backup and successful complete index rebuild.
  if (metadataAdopted)
    await sql('UPDATE pg_catalog.pg_database SET datcollversion=pg_database_collation_actual_version(oid) WHERE datname=current_database()');
  else await sql(`ALTER DATABASE "${state.database.replaceAll('"', '""')}" REFRESH COLLATION VERSION`);
  if ((await sql('SELECT datcollversion IS NOT DISTINCT FROM pg_database_collation_actual_version(oid) FROM pg_database WHERE datname=current_database()')).trim() !== 't')
    throw new Error('The database sorting version could not be verified after rebuilding indexes.');
  return { ...state, rebuilt: true, metadataAdopted };
}
async function preflight() {
  const info = JSON.parse(await run('docker', ['info', '--format', '{{json .}}']));
  if (info.OSType !== 'linux') throw new Error('Switch Docker Desktop to Linux containers.');
  if (Number(info.ServerVersion.split('.')[0]) < 24)
    throw new Error('Docker Engine 24 or newer is required.');
  const composeVersion = await run('docker', ['compose', 'version', '--short']);
  const [major, minor] = composeVersion.replace(/^v/, '').split('.').map(Number);
  if (major < 2 || (major === 2 && minor < 24))
    throw new Error('Docker Compose 2.24 or newer is required.');
  if (!['x86_64', 'aarch64', 'amd64', 'arm64'].includes(info.Architecture))
    throw new Error(`Unsupported Docker architecture: ${info.Architecture}`);
  if (info.MemTotal < 2 * 1024 ** 3)
    throw new Error('Give Docker at least 2 GiB RAM for the panel, plus the games’ memory.');
  if (/^\/mnt\/[a-z]\//.test(hostRoot))
    throw new Error(
      'On WSL2, install in the Linux filesystem (for example ~/serverforge), not /mnt/c.',
    );
  await freeSpace(installation, 2 * 1024 ** 3);
  await fs.writeFile(path.join(installation, '.write-test'), 'ok', { mode: 0o600 });
  await fs.rm(path.join(installation, '.write-test'));
  return {
    docker: info.ServerVersion,
    compose: composeVersion,
    architecture: info.Architecture,
    memoryMib: Math.floor(info.MemTotal / 1024 ** 2),
    cpus: info.NCPU,
    host: { os: process.env.SF_HOST_OS || 'unknown', release: process.env.SF_HOST_RELEASE || 'unknown', architecture: process.env.SF_HOST_ARCH || 'unknown' },
    dockerOperatingSystem: info.OperatingSystem,
    dockerKernel: info.KernelVersion,
  };
}
async function waitReady(timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const id = await compose(['ps', '-q', 'api']);
    if (id) {
      const status = await run('docker', [
        'inspect',
        '--format',
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
        id,
      ]);
      if (status === 'healthy') return;
      if (['exited', 'dead'].includes(status)) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    'The API did not become ready. Run serverforge diagnostics; the previous backup and upgrade journal have been kept.',
  );
}
async function start() {
  const existing = await compose(['ps', '-q', 'api']);
  if (
    existing &&
    (await run('docker', ['inspect', '--format', '{{.State.Running}}', existing])) === 'true'
  ) {
    await waitReady();
    console.log('The dashboard is already running. Use upgrade to change its release.');
    return;
  }
  await compose(['up', '-d', '--wait', 'postgres'], { echo: true });
  const configuration = await readConfig();
  if (configuration.APP_VERSION !== 'legacy') {
    await maintenance(['migrate']);
    await maintenance(['seed']);
  }
  await compose(['up', '-d', 'api', 'web'], { echo: true });
  await waitReady();
  if (configuration.APP_VERSION !== 'legacy') await compose(['--profile', 'backups', 'up', '-d', 'backup-worker'], { echo: true });
  const config = await readConfig();
  console.log(`Dashboard ready: http://localhost:${config.WEB_PORT}`);
}
async function setup() {
  const checks = await preflight();
  if (await fs.stat(configFile).catch(() => null))
    throw new Error(
      'This installation already has configuration. Use start or upgrade; setup never replaces existing secrets.',
    );
  if (await fs.stat(path.join(installation, '.env')).catch(() => null))
    throw new Error(
      'A source installation exists here. Use serverforge adopt to preserve its database, paths, and credentials.',
    );
  const port = Number(option('--port', '3000'));
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Choose a dashboard port between 1024 and 65535.');
  const version = option('--version', release.version);
  const images = {
    API_IMAGE: option('--api-image', `serverforge-api:${version}`),
    WEB_IMAGE: option('--web-image', `serverforge-web:${version}`),
    MAINTENANCE_IMAGE: process.env.SF_MAINTENANCE_IMAGE,
    POSTGRES_IMAGE: option('--postgres-image', release.postgresImage),
    TAILSCALE_IMAGE: option('--tailscale-image', release.tailscaleImage),
  };
  const imageDetails = {};
  for (const [key, image] of Object.entries(images)) imageDetails[key] = await imageInfo(image);
  const expectedArchitecture = ['aarch64', 'arm64'].includes(checks.architecture)
    ? 'arm64'
    : 'amd64';
  if (Object.values(imageDetails).some((image) => image.architecture !== expectedArchitecture))
    throw new Error('Load the native candidate application images for this Docker architecture.');
  if (Object.values(imageDetails).some((image) => image.version !== version))
    throw new Error('Load all five candidate images matching the selected release version.');
  if (imageDetails.POSTGRES_IMAGE.postgresMajor !== String(release.postgresMajor)) throw new Error('The database image has an incompatible PostgreSQL major version.');
  // Docker checks host port publication, including Desktop's forwarding layer.
  let probe;
  try {
    probe = await run('docker', [
      'run',
      '-d',
      '--rm',
      '--label',
      'serverforge.io/preflight=true',
      '-p',
      `127.0.0.1:${port}:3000`,
      '--entrypoint',
      'node',
      images.MAINTENANCE_IMAGE,
      '-e',
      "require('net').createServer().listen(3000,'0.0.0.0')",
    ]);
  } catch {
    throw new Error(
      `Dashboard port ${port} is occupied or unavailable. Retry setup with --port and a free port.`,
    );
  } finally {
    if (probe) await run('docker', ['rm', '-f', probe]);
  }
  await fs.mkdir(configRoot, { recursive: true, mode: 0o700 });
  await fs.chown(configRoot, hostOwner.uid, hostOwner.gid);
  const paths = {
    DATA: 'servers',
    BACKUP: 'backups',
    CACHE: 'cache',
    THEMES: 'themes',
    GAMES: 'games',
    RECOVERY: 'recovery',
  };
  for (const directory of Object.values(paths))
    await fs.mkdir(path.join(installation, 'data', directory), {
      recursive: true,
      mode: directory === 'recovery' ? 0o700 : 0o755,
    });
  const token = secret();
  const project = `serverforge-${randomBytes(5).toString('hex')}`;
  const values = {
    COMPOSE_PROJECT_NAME: project,
    APP_VERSION: version,
    ...Object.fromEntries(Object.entries(imageDetails).map(([key, image]) => [key, image.digest])),
    POSTGRES_USER: 'serverforge',
    POSTGRES_PASSWORD: secret(),
    POSTGRES_DB: 'serverforge',
    SESSION_SECRET: secret(),
    ENCRYPTION_KEY: secret(),
    SETUP_TOKEN_HASH: createHash('sha256').update(token).digest('hex'),
    BIND_HOST: '127.0.0.1',
    WEB_PORT: String(port),
    COOKIE_SECURE: 'false',
    DASHBOARD_SCHEME: 'http',
    CORS_ORIGINS: `http://localhost:${port},http://127.0.0.1:${port}`,
    HOST_CONFIG_ROOT: path.join(hostRoot, 'config'),
    DOCKER_SOCKET_FILE: process.env.DOCKER_SOCKET_FILE || '/var/run/docker.sock',
    UPNP_ENABLED: 'false',
    TS_HOSTNAME: 'serverforge',
    PUBLIC_HOST: 'localhost',
    BRAND_RESOURCE_PREFIX: project,
    ...Object.fromEntries(
      Object.entries(paths).map(([key, directory]) => [
        `HOST_${key}_ROOT`,
        path.join(hostRoot, 'data', directory),
      ]),
    ),
  };
  await saveConfig(values);
  if (args.includes('--qualification')) await writeJson(path.join(configRoot, 'qualification.json'), { format: 1, project, username: 'platform-tester', password: secret(), setupToken: token });
  for (const file of ['compose.yml', 'tailscale-entrypoint.sh'])
    await fs.copyFile(path.join(assets, file), path.join(configRoot, file));
  await writeJson(path.join(configRoot, 'release.json'), {
    ...release,
    images: imageDetails,
    installedAt: new Date().toISOString(),
    preflight: checks,
  });
  console.log(`One-time owner setup token: ${token}`);
  if (!args.includes('--configure-only')) await start();
}
async function adopt() {
  const checks = await preflight();
  if (await fs.stat(configFile).catch(() => null)) throw new Error('Configuration already exists. Use upgrade; adoption never overwrites it.');
  const sourceText = await fs.readFile(path.join(installation, '.env'), 'utf8');
  const source = parseEnv(sourceText);
  const project = option('--project', source.COMPOSE_PROJECT_NAME || 'serverforge');
  if (!/^[a-z0-9][a-z0-9_-]+$/.test(project)) throw new Error('Choose the existing Compose project name.');
  const containers = {};
  for (const service of ['postgres', 'api', 'web']) {
    const ids = (await run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`, '--filter', `label=com.docker.compose.service=${service}`])).split(/\s+/).filter(Boolean);
    if (ids.length !== 1) throw new Error(`Expected one ${service} container in ${project}. Inspect the selected source installation.`);
    [containers[service]] = JSON.parse(await run('docker', ['inspect', ids[0]]));
  }
  const apiEnvironment = Object.fromEntries(containers.api.Config.Env.map((entry) => { const index = entry.indexOf('='); return [entry.slice(0, index), entry.slice(index + 1)]; }));
  const postgresEnvironment = Object.fromEntries(containers.postgres.Config.Env.map((entry) => { const index = entry.indexOf('='); return [entry.slice(0, index), entry.slice(index + 1)]; }));
  const hostMountPath = (source) => checks.dockerOperatingSystem.includes('Docker Desktop') && source.startsWith('/host_mnt/') ? source.slice('/host_mnt'.length) : source;
  const expectedDataRoot = path.resolve(hostRoot, source.HOST_DATA_ROOT || 'data/servers');
  const dataMount = containers.api.Mounts.find((mount) => mount.Destination === apiEnvironment.DATA_ROOT && mount.Type === 'bind');
  if (!dataMount || hostMountPath(dataMount.Source) !== expectedDataRoot || apiEnvironment.HOST_DATA_ROOT !== expectedDataRoot) throw new Error('The selected containers do not match this source installation’s game directory. Adoption refused.');
  const databaseVolume = containers.postgres.Mounts.find((mount) => mount.Destination === '/var/lib/postgresql/data' && mount.Type === 'volume');
  if (!databaseVolume) throw new Error('This adoption path requires the documented PostgreSQL named volume. Preserve the custom database and configure it explicitly.');
  const binding = containers.web.HostConfig.PortBindings?.['3000/tcp'];
  if (!binding?.length || binding.length !== 1) throw new Error('Inspect the existing dashboard port binding before adoption.');
  for (const key of ['SESSION_SECRET', 'ENCRYPTION_KEY']) if (!apiEnvironment[key]) throw new Error(`Existing API is missing ${key}; restore configuration before proceeding.`);
  await fs.mkdir(configRoot, { mode: 0o700 });
  await fs.chown(configRoot, hostOwner.uid, hostOwner.gid);
  const values = { ...source, COMPOSE_PROJECT_NAME: project, APP_VERSION: 'legacy', HEALTH_PATH: '/health', API_IMAGE: containers.api.Image, WEB_IMAGE: containers.web.Image, MAINTENANCE_IMAGE: process.env.SF_MAINTENANCE_IMAGE,
    HOST_DATA_ROOT: expectedDataRoot, POSTGRES_IMAGE: containers.postgres.Image, POSTGRES_VOLUME: databaseVolume.Name, POSTGRES_USER: postgresEnvironment.POSTGRES_USER, POSTGRES_PASSWORD: postgresEnvironment.POSTGRES_PASSWORD, POSTGRES_DB: postgresEnvironment.POSTGRES_DB,
    SESSION_SECRET: apiEnvironment.SESSION_SECRET, ENCRYPTION_KEY: apiEnvironment.ENCRYPTION_KEY, HOST_CONFIG_ROOT: path.join(hostRoot, 'config'), HOST_CACHE_ROOT: source.HOST_CACHE_ROOT || path.join(hostRoot, 'data/cache'), HOST_RECOVERY_ROOT: source.HOST_RECOVERY_ROOT || path.join(hostRoot, 'data/recovery'),
    DOCKER_SOCKET_FILE: process.env.DOCKER_SOCKET_FILE || '/var/run/docker.sock', WEB_PORT: binding[0].HostPort, BIND_HOST: binding[0].HostIp || '0.0.0.0', DASHBOARD_SCHEME: source.DASHBOARD_SCHEME || 'http', UPNP_ENABLED: apiEnvironment.UPNP_ENABLED || 'false' };
  for (const [key, local] of Object.entries({ HOST_BACKUP_ROOT: 'BACKUP_ROOT', HOST_THEMES_ROOT: 'THEMES_ROOT', HOST_GAMES_ROOT: 'GAMES_ROOT', HOST_CACHE_ROOT: 'CACHE_ROOT' })) {
    const mount = containers.api.Mounts.find((entry) => entry.Type === 'bind' && entry.Destination === apiEnvironment[local]);
    if (mount) values[key] = hostMountPath(mount.Source);
  }
  const ports = Object.entries(containers.api.HostConfig.PortBindings || {}).flatMap(([target, bindings]) => (bindings || []).map((binding) => ({ target: Number(target.split('/')[0]), published: binding.HostPort, host_ip: binding.HostIp || '0.0.0.0', protocol: target.split('/')[1] || 'tcp' })));
  await writeJson(path.join(configRoot, 'legacy-runtime.json'), { services: { api: { ports, environment: apiEnvironment, command: containers.api.Config.Cmd, entrypoint: containers.api.Config.Entrypoint }, web: { environment: Object.fromEntries(containers.web.Config.Env.map((entry) => { const index = entry.indexOf('='); return [entry.slice(0, index), entry.slice(index + 1)]; })), command: containers.web.Config.Cmd, entrypoint: containers.web.Config.Entrypoint } } });
  await saveConfig(values);
  for (const file of ['compose.yml', 'tailscale-entrypoint.sh']) await fs.copyFile(path.join(assets, file), path.join(configRoot, file));
  await atomic(path.join(configRoot, 'source.env.before-adoption'), sourceText);
  const images = {};
  for (const key of ['API_IMAGE', 'WEB_IMAGE', 'MAINTENANCE_IMAGE']) images[key] = await imageInfo(values[key]);
  await writeJson(path.join(configRoot, 'release.json'), { version: 'legacy', schemaVersion: null, imageOnlyRollbackFromSchemas: [], images, adoptedAt: new Date().toISOString(), preflight: checks });
  console.log(`Existing project ${project} recorded without restarting services. Paths, secrets, database volume and dashboard port are preserved. Run serverforge upgrade ${release.version}; it verifies a panel backup and recognizes the schema before applying migrations.`);
}
async function upgrade(version = args[0]) {
  const checks = await preflight();
  if (!version || version.startsWith('-'))
    throw new Error('Usage: serverforge upgrade VERSION (load its candidate images first).');
  const before = await readConfig();
  const previousRelease = JSON.parse(
    await fs.readFile(path.join(configRoot, 'release.json'), 'utf8'),
  );
  const tailscaleId = await compose(['ps', '-q', 'tailscale']);
  if (tailscaleId) {
    before.TAILSCALE_IMAGE = await run('docker', ['inspect', '--format', '{{.Image}}', tailscaleId]);
    await imageInfo(before.TAILSCALE_IMAGE);
  }
  if (!before.POSTGRES_IMAGE) {
    const postgres = await compose(['ps', '-aq', 'postgres']);
    if (!postgres) throw new Error('The installation database container is missing. Recover it before upgrading.');
    before.POSTGRES_IMAGE = await run('docker', ['inspect', '--format', '{{.Image}}', postgres]);
  }
  await imageInfo(before.POSTGRES_IMAGE);
  for (const key of ['API_IMAGE', 'WEB_IMAGE', 'MAINTENANCE_IMAGE']) if (previousRelease.images?.[key]?.digest) before[key] = previousRelease.images[key].digest;
  for (const key of ['API_IMAGE', 'WEB_IMAGE', 'MAINTENANCE_IMAGE']) {
    try { await imageInfo(before[key]); }
    catch { throw new Error(`The installed ${key} image is missing. Load the recorded release image before upgrading; the running panel has not been stopped.`); }
  }
  const after = {
    ...before,
    APP_VERSION: version,
    HEALTH_PATH: '/health/ready',
    ...(args.includes('--postgres-image') ? { POSTGRES_IMAGE: option('--postgres-image') } : {}),
    ...(args.includes('--tailscale-image') ? { TAILSCALE_IMAGE: option('--tailscale-image') } : {}),
    API_IMAGE: option('--api-image', `serverforge-api:${version}`),
    WEB_IMAGE: option('--web-image', `serverforge-web:${version}`),
    MAINTENANCE_IMAGE: option('--maintenance-image', `serverforge-maintenance:${version}`),
  };
  const images = {};
  for (const key of ['API_IMAGE', 'WEB_IMAGE', 'MAINTENANCE_IMAGE', ...(args.includes('--postgres-image') ? ['POSTGRES_IMAGE'] : []), ...(args.includes('--tailscale-image') ? ['TAILSCALE_IMAGE'] : [])])
    images[key] = await imageInfo(after[key]);
  if (images.POSTGRES_IMAGE && images.POSTGRES_IMAGE.postgresMajor !== String(release.postgresMajor)) throw new Error('Database major upgrades need a separate migration; choose a matching PostgreSQL image.');
  const architecture = ['arm64', 'aarch64'].includes(checks.architecture) ? 'arm64' : 'amd64';
  if (Object.values(images).some((image) => image.version !== version || image.architecture !== architecture))
    throw new Error('Load matching native API, web, and maintenance images for the selected release before upgrading.');
  for (const key of ['POSTGRES_IMAGE', 'TAILSCALE_IMAGE']) if (!images[key] && after[key]) images[key] = await imageInfo(after[key]);
  for (const key of Object.keys(images)) after[key] = images[key].digest;
  const selectedRelease = JSON.parse(
    await run('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'node',
      after.MAINTENANCE_IMAGE,
      'packages/maintenance/src/cli.mjs',
      'release-info',
    ]),
  );
  if (selectedRelease.version !== version) throw new Error('The selected maintenance image does not contain the requested release version.');
  const selectedAssets = JSON.parse(await run('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'node', after.MAINTENANCE_IMAGE, '-e', "const fs=require('fs');console.log(JSON.stringify(Object.fromEntries(['compose.yml','tailscale-entrypoint.sh'].map(name=>[name,fs.readFileSync('/app/release/'+name,'utf8')]))))"]));
  const previousAssets = {};
  for (const name of Object.keys(selectedAssets)) previousAssets[name] = await fs.readFile(path.join(configRoot, name), 'utf8');
  const journalFile = path.join(configRoot, 'upgrade.json');
  const existing = await fs.readFile(journalFile, 'utf8').then(JSON.parse, () => null);
  if (existing && !['complete', 'rolled-back'].includes(existing.step))
    throw new Error(
      'An unfinished upgrade is recorded. Run rollback before starting another upgrade.',
    );
  const journal = {
    id: secret().slice(0, 16),
    startedAt: new Date().toISOString(),
    step: 'preparing',
    before,
    after,
    previousRelease,
    selectedRelease,
    images,
    previousAssets,
    tailscaleWasRunning: !!tailscaleId,
    backup: null,
  };
  await writeJson(journalFile, journal);
  try {
    await compose(['stop', 'backup-worker', 'web', 'api'], { echo: true });
    journal.step = 'panel-stopped';
    await writeJson(journalFile, journal);
    await compose(['up', '-d', '--wait', 'postgres'], { echo: true });
    journal.backup = JSON.parse(
      await maintenance(['backup', '--offline'], ['-e', 'SF_OFFLINE_MAINTENANCE=1']),
    );
    journal.previousRelease.schemaVersion = journal.backup.schemaVersion;
    journal.step = 'backed-up';
    await writeJson(journalFile, journal);
    await saveConfig(after);
    for (const [name, contents] of Object.entries(selectedAssets)) await atomic(path.join(configRoot, name), contents);
    await compose(['up', '-d', '--wait', 'postgres'], { echo: true });
    await maintenance(['migrate']);
    journal.collation = await repairCollation(false, async () => {
      journal.databaseReindexed = true;
      journal.step = 'reindexing';
      await writeJson(journalFile, journal);
    });
    journal.step = 'migrated';
    await writeJson(journalFile, journal);
    await compose(['up', '-d', 'api', 'web'], { echo: true });
    await waitReady();
    await compose(['--profile', 'backups', 'up', '-d', 'backup-worker'], { echo: true });
    if (journal.tailscaleWasRunning && (before.TAILSCALE_IMAGE !== after.TAILSCALE_IMAGE || previousAssets['tailscale-entrypoint.sh'] !== selectedAssets['tailscale-entrypoint.sh']))
      await compose(['up', '-d', '--no-deps', '--force-recreate', 'tailscale'], { echo: true });
    journal.step = 'complete';
    journal.finishedAt = new Date().toISOString();
    await writeJson(journalFile, journal);
    await writeJson(path.join(configRoot, 'release.json'), {
      ...selectedRelease,
      images,
      installedAt: journal.finishedAt,
      backupId: journal.backup.id,
    });
    console.log(`Upgrade complete. Verified backup: ${journal.backup.id}`);
  } catch (error) {
    journal.error = error.message;
    await writeJson(journalFile, journal);
    throw new Error(
      `${error.message}\nUpgrade checkpoint: ${journal.id}, step ${journal.step}. Use serverforge rollback; no destructive schema downgrade was attempted.`,
    );
  }
}
async function rollback() {
  const journal = JSON.parse(await fs.readFile(path.join(configRoot, 'upgrade.json'), 'utf8'));
  const tailscaleWasRunning = journal.tailscaleWasRunning ?? !!(await compose(['ps', '-q', 'tailscale']));
  if (!journal.backup) {
    await saveConfig(journal.before);
    for (const [name, contents] of Object.entries(journal.previousAssets || {})) await atomic(path.join(configRoot, name), contents);
    await compose(['up', '-d', 'api', 'web']);
    await waitReady();
    if (journal.before.APP_VERSION !== 'legacy') await compose(['--profile', 'backups', 'up', '-d', 'backup-worker']);
    if (tailscaleWasRunning) await compose(['up', '-d', '--no-deps', '--force-recreate', 'tailscale']);
    journal.step = 'rolled-back';
    await writeJson(path.join(configRoot, 'upgrade.json'), journal);
    return;
  }
  await compose(['stop', 'backup-worker', 'web', 'api'], { echo: true });
  const compatible = journal.previousRelease.imageOnlyRollbackFromSchemas?.includes(
    journal.selectedRelease.schemaVersion,
  );
  if (!compatible)
    await maintenance(
      ['restore', journal.backup.directory, '--replace-panel'],
      ['-e', 'SF_OFFLINE_MAINTENANCE=1'],
    );
  await saveConfig(journal.before);
  for (const [name, contents] of Object.entries(journal.previousAssets || {})) await atomic(path.join(configRoot, name), contents);
  await compose(['up', '-d', '--wait', 'postgres'], { echo: true });
  journal.rollbackCollation = await repairCollation(!!journal.databaseReindexed, async () => {
    journal.databaseReindexed = true;
    journal.step = 'reindexing-rollback';
    await writeJson(path.join(configRoot, 'upgrade.json'), journal);
  });
  await compose(['up', '-d', 'api', 'web'], { echo: true });
  await waitReady();
  if (journal.before.APP_VERSION !== 'legacy') await compose(['--profile', 'backups', 'up', '-d', 'backup-worker'], { echo: true });
  if (tailscaleWasRunning) await compose(['up', '-d', '--no-deps', '--force-recreate', 'tailscale'], { echo: true });
  journal.step = 'rolled-back';
  journal.finishedAt = new Date().toISOString();
  await writeJson(path.join(configRoot, 'upgrade.json'), journal);
  await writeJson(path.join(configRoot, 'release.json'), journal.previousRelease);
  console.log(
    compatible
      ? 'Previous images restored using declared schema compatibility.'
      : 'Matching pre-upgrade database, configuration, and images restored.',
  );
}
async function restore() {
  const bundle = args[0];
  if (!bundle || !path.isAbsolute(bundle))
    throw new Error(
      'Usage: serverforge restore /absolute/host/path/to/bundle.sfr. Use a fresh installation configured with setup --configure-only.',
    );
  await compose(['stop', 'backup-worker', 'web', 'api'], { echo: true });
  await compose(['up', '-d', '--wait', 'postgres'], { echo: true });
  console.log(
    await maintenance(
      ['restore', '/restore'],
      ['-e', 'SF_OFFLINE_MAINTENANCE=1', '-v', `${bundle}:/restore:ro`],
    ),
  );
  console.log(
    'Recovery is complete and games remain offline. Start the panel and inspect each world before enabling game access.',
  );
}
async function diagnostics() {
  const checks = await preflight().catch((error) => ({ error: error.message }));
  const containers = await compose(['ps', '--all', '--format', 'json']).catch(() => '[]');
  const report = {
    format: 'serverforge-diagnostics',
    version: 1,
    createdAt: new Date().toISOString(),
    checks,
    containers: containers
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const row = JSON.parse(line);
          return {
            service: row.Service,
            state: row.State,
            health: row.Health,
            exitCode: row.ExitCode,
          };
        } catch {
          return { state: 'unavailable' };
        }
      }),
    note: 'Configuration, credentials, account records, raw console logs and recovery bundle contents are excluded.',
  };
  await writeJson(path.join(installation, 'diagnostics.json'), report);
  console.log(JSON.stringify(report, null, 2));
}
async function access() {
  const mode = args[0];
  if (!['local', 'lan', 'https', 'sidecar'].includes(mode)) throw new Error('Use access local, access lan [--bind LAN_IP], access sidecar, or access https after configuring a trusted HTTPS proxy.');
  const config = await readConfig();
  if (mode === 'sidecar') {
    await compose(['--profile', 'tailscale', 'up', '-d', 'tailscale'], { echo: true });
    console.log('Dedicated dashboard device started. Sign in from Network & access, then enable its HTTPS handler. Run serverforge access https before using HTTPS account sessions. The sidecar does not carry game traffic.');
    return;
  }
  const bind = mode === 'lan' ? option('--bind', '0.0.0.0') : '127.0.0.1';
  if (!net.isIP(bind)) throw new Error('Choose an IP address assigned to this host, or 0.0.0.0 for all IPv4 interfaces.');
  await saveConfig({ ...config, BIND_HOST: bind, DASHBOARD_SCHEME: mode === 'https' ? 'https' : 'http', COOKIE_SECURE: mode === 'https' ? 'true' : 'false' });
  await compose(['up', '-d', '--no-deps', 'api', 'web'], { echo: true });
  await waitReady();
  console.log(mode === 'https' ? 'Dashboard sessions now require HTTPS through your trusted proxy. Local HTTP sign-in is disabled.' : `Dashboard listens on ${bind}:${config.WEB_PORT}. Verify this host’s firewall and address from the intended client.`);
}
async function network() {
  const config = await readConfig();
  const snapshot = process.env.SF_HOST_NETWORK_STATUS;
  if (!/^\.network-discovery\.[a-zA-Z0-9]+$/.test(snapshot || '')) throw new Error('Use the host launcher for network discovery.');
  const folder = path.join(installation, snapshot);
  const status = await fs.readFile(path.join(folder, 'status.json'), 'utf8').then(JSON.parse, () => null);
  const serve = await fs.readFile(path.join(folder, 'serve.json'), 'utf8').then(JSON.parse, () => null);
  const dnsName = status?.Self?.DNSName?.replace(/\.$/, '') || null;
  const target = `http://127.0.0.1:${config.WEB_PORT}`;
  const key = `${dnsName}:443`;
  const owned = serve?.TCP?.['443']?.HTTPS && serve?.Web?.[key]?.Handlers?.['/']?.Proxy === target && !Object.values(serve?.AllowFunnel || {}).some(Boolean);
  const lanHost = option('--lan-address', null);
  if (lanHost && (!net.isIPv4(lanHost) || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(lanHost))) throw new Error('Supply this host’s private LAN IPv4 address.');
  const value = { checkedAt: new Date().toISOString(), lanHost, gateway: null, tailscale: status ? { state: status.BackendState, ip: status.TailscaleIPs?.find((ip) => net.isIPv4(ip)) || null, dnsName, dashboardUrl: owned ? `https://${dnsName}` : null } : null };
  const destination = path.join(config.HOST_DATA_ROOT, '.network');
  // The daemon resolves the host data path; mount exactly that installation’s directory.
  await run('docker', ['run', '--rm', '--network', 'none', '-v', `${config.HOST_DATA_ROOT}:/data`, '--entrypoint', 'node', config.MAINTENANCE_IMAGE, '-e', "const fs=require('fs');fs.mkdirSync('/data/.network',{recursive:true,mode:0o700});fs.writeFileSync('/data/.network/host.json.partial',process.argv[1],{mode:0o600});fs.renameSync('/data/.network/host.json.partial','/data/.network/host.json')", JSON.stringify(value)]);
  console.log(JSON.stringify({ ...value, snapshot: destination, note: 'Serve configuration alone is not a reachability test. Check connections in the dashboard from an authorized tailnet device.' }, null, 2));
  if (status?.BackendState === 'Running' && !owned) console.log(`Keep your working host address and port. To add HTTPS, inspect tailscale serve status first, then configure: tailscale serve --bg ${target}. Preserve unrelated handlers; host permissions may require the command printed by Tailscale. After HTTPS verification run serverforge access https.`);
}

let locked = false;
const lock = path.join(installation, '.serverforge-maintenance-lock');
try {
  if (!['status', 'diagnostics'].includes(action)) {
    await fs.mkdir(lock, { mode: 0o700 }).catch(() => {
      throw new Error(
        'Another host maintenance command is active, or its lock survived interruption. Inspect running maintenance containers before removing .serverforge-maintenance-lock.',
      );
    });
    locked = true;
    await fs.chown(lock, hostOwner.uid, hostOwner.gid);
    await writeJson(path.join(lock, 'owner.json'), {
      command: action,
      startedAt: new Date().toISOString(),
    });
  }
  if (action === 'setup') await setup();
  else if (action === 'adopt') await adopt();
  else if (action === 'access') await access();
  else if (action === 'network') await network();
  else if (action === 'start') {
    await preflight();
    await start();
  } else if (action === 'stop') await compose(['stop'], { echo: true });
  else if (action === 'status') console.log(await compose(['ps', '--all']));
  else if (action === 'diagnostics') await diagnostics();
  else if (action === 'setup-token') {
    const state = JSON.parse(await maintenance(['setup-state']));
    if (!state.ownerSetupAvailable) throw new Error('Owner setup is already complete. Use reset-password for an existing account.');
    const token = secret();
    await saveConfig({ ...await readConfig(), SETUP_TOKEN_HASH: createHash('sha256').update(token).digest('hex') });
    await compose(['up', '-d', '--no-deps', 'api', 'web']);
    await waitReady();
    console.log(`One-time owner setup token: ${token}`);
  }
  else if (action === 'backup')
    console.log(await maintenance(['backup', ...(args.includes('--full') ? ['--full'] : [])]));
  else if (action === 'verify')
    console.log(await maintenance(['verify', '/verify'], ['-v', `${args[0]}:/verify:ro`]));
  else if (action === 'restore') await restore();
  else if (action === 'upgrade') await upgrade();
  else if (action === 'qualify') {
    const marker = JSON.parse(await fs.readFile(path.join(configRoot, 'qualification.json'), 'utf8').catch(() => { throw new Error('Create an isolated setup --qualification installation before running game checks.'); }));
    const configuration = await readConfig();
    if (marker.project !== configuration.COMPOSE_PROJECT_NAME) throw new Error('Qualification project mismatch.');
    const host = await preflight();
    const images = {};
    for (const key of ['API_IMAGE', 'WEB_IMAGE', 'MAINTENANCE_IMAGE', 'POSTGRES_IMAGE']) images[key] = await imageInfo(configuration[key]);
    await writeJson(path.join(configRoot, 'qualification-host.json'), { ...host, images, checkedAt: new Date().toISOString() });
    console.log(await maintenance(['qualify', option('--cases', ''), option('--minutes', '180')], [...(process.env.SF_QUALIFY_EMULATION === 'true' || args.includes('--allow-experimental') ? ['-e', 'SF_QUALIFY_EMULATION=true'] : []), ...(args.includes('--reuse') ? ['-e', 'SF_QUALIFY_REUSE=true'] : [])]));
  }
  else if (action === 'soak') {
    const marker = JSON.parse(await fs.readFile(path.join(configRoot, 'qualification.json'), 'utf8'));
    if (marker.project !== (await readConfig()).COMPOSE_PROJECT_NAME) throw new Error('Soak project mismatch.');
    const ids = (await compose(['ps', '-q', 'api', 'web', 'postgres'])).split(/\s+/).filter(Boolean);
    if (ids.length !== 3) throw new Error('All three panel services must be running before a soak.');
    const file = path.join(configRoot, `soak-host-${Date.now()}.jsonl`);
    let pending;
    const sample = () => {
      if (pending) return;
      pending = run('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...ids])
        .then((output) => fs.appendFile(file, JSON.stringify({ at: new Date().toISOString(), containers: output.split('\n').filter(Boolean).map(JSON.parse) }) + '\n', { mode: 0o600 }))
        .catch((error) => fs.appendFile(file, JSON.stringify({ at: new Date().toISOString(), error: error.message }) + '\n', { mode: 0o600 }))
        .finally(() => { pending = undefined; });
    };
    sample();
    const timer = setInterval(sample, 30000);
    try { console.log(await maintenance(['soak', option('--server', ''), option('--minutes', '240')])); }
    finally { clearInterval(timer); await pending; console.log(`Host resource samples: ${hostRoot}/config/${path.basename(file)}`); }
  }
  else if (action === 'rollback') await rollback();
  else if (action === 'reset-password') {
    if (!args.includes('--user') || !args.includes('--generate'))
      throw new Error(
        'Use reset-password --user USERNAME --generate (optionally --clear-2fa). The new password is shown once.',
      );
    console.log(await maintenance(['reset-password', ...args]));
  } else
    throw new Error(
      'Commands: setup, adopt, start, stop, status, diagnostics, backup, verify, restore, upgrade, rollback, reset-password.',
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (locked) {
    try {
      // Restore/qualification helpers also write private config files. Change
      // ownership only inside this installation's config, never game files or
      // symlink targets. Keep every existing file mode intact.
      const ownConfig = async (directory) => {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) await ownConfig(file);
          else if (entry.isFile()) await fs.chown(file, hostOwner.uid, hostOwner.gid);
        }
        await fs.chown(directory, hostOwner.uid, hostOwner.gid);
      };
      const entry = await fs.lstat(configRoot).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (entry?.isDirectory()) await ownConfig(configRoot);
    } finally { await fs.rm(lock, { recursive: true, force: true }); }
  }
}
