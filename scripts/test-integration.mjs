#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = `serverforge-test-${randomBytes(6).toString('hex')}`;
await mkdir(path.join(root, 'data/release-tests'), { recursive: true });
const scratch = await mkdtemp(path.join(root, 'data/release-tests', `${project}-`));
const envFile = path.join(scratch, 'compose.env');
await writeFile(envFile, '', { mode: 0o600 });
// Stop Prisma's package-root discovery here, away from the installation .env.
await writeFile(path.join(scratch, 'package.json'), '{"private":true}\n');
const schemaPath = path.join(scratch, 'schema.prisma');
await writeFile(
  schemaPath,
  (await readFile(path.join(root, 'packages/db/prisma/schema.prisma'), 'utf8')).replace(
    'output   = "../generated/client"',
    `output   = ${JSON.stringify(path.join(root, 'packages/db/generated/client'))}`,
  ),
);
const endpoint = process.env.DOCKER_SOCKET
  ? `unix://${process.env.DOCKER_SOCKET}`
  : process.env.DOCKER_HOST ||
    execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
      encoding: 'utf8',
    }).trim();
if (!endpoint.startsWith('unix://'))
  throw new Error('Integration tests require a local Linux-container Docker socket.');
const setupToken = randomBytes(32).toString('hex');
const env = {
  SETUP_TOKEN_HASH: createHash('sha256').update(setupToken).digest('hex'),
  SF_TEST_SETUP_TOKEN: setupToken,
  ...process.env,
  DOCKER_HOST: endpoint,
  DOCKER_SOCKET: endpoint.slice(7),
  SF_TEST_PASSWORD: randomBytes(24).toString('hex'),
  SF_TEST_PROJECT: project,
  SF_REQUIRE_INTEGRATION: '1',
  SF_TEST_DATA_ROOT: scratch,
  SESSION_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  DATA_ROOT: path.join(scratch, 'servers'),
  HOST_DATA_ROOT: path.join(scratch, 'servers'),
  BACKUP_ROOT: path.join(scratch, 'backups'),
  HOST_BACKUP_ROOT: path.join(scratch, 'backups'),
  CACHE_ROOT: path.join(scratch, 'cache'),
  THEMES_ROOT: path.join(scratch, 'themes'),
  GAMES_ROOT: path.join(scratch, 'games'),
  WORKER: '0',
  UPNP_ENABLED: 'false',
  TAILSCALE_SOCKET: path.join(scratch, 'no-tailscale.sock'),
  NODE_ENV: 'test',
};
const compose = [
  'compose',
  '--project-name',
  project,
  '--project-directory',
  scratch,
  '--env-file',
  envFile,
  '-f',
  path.join(root, 'docker/compose.test.yml'),
];
let active;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = true;
    active?.kill('SIGTERM');
  });
function run(command, args, cleanup = false, cwd = root) {
  if (interrupted && !cleanup) return Promise.reject(new Error('Integration run interrupted.'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    active = child;
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (active === child) active = undefined;
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} failed (${signal ?? code}).`));
    });
  });
}
const result = {
  project,
  startedAt: new Date().toISOString(),
  passed: false,
  error: null,
  finishedAt: null,
};
try {
  await run('docker', [
    'info',
    '--format',
    'Docker {{.ServerVersion}} ({{.OSType}}/{{.Architecture}})',
  ]);
  await run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '90']);
  const binding = execFileSync('docker', [...compose, 'port', 'postgres', '5432'], {
    env,
    encoding: 'utf8',
  }).trim();
  if (!/^127\.0\.0\.1:\d+$/.test(binding))
    throw new Error('Test database must bind an ephemeral loopback port.');
  env.DATABASE_URL = `postgresql://serverforge_test:${env.SF_TEST_PASSWORD}@${binding}/serverforge_test?schema=public`;
  env.SF_TEST_DATABASE_URL = env.DATABASE_URL;
  const prisma = path.join(root, 'node_modules/prisma/build/index.js');
  await run(process.execPath, [prisma, 'generate', '--schema', schemaPath], false, scratch);
  if (process.argv.includes('--update-schema-states'))
    await run(process.execPath, ['scripts/migration-fixtures.mjs', '--update-schema-states']);
  await run(process.execPath, ['packages/maintenance/src/migrate.mjs']);
  await run(process.execPath, [
    'node_modules/vitest/vitest.mjs',
    'run',
    '.integration.test.ts',
    '--maxWorkers=1',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${path.join(scratch, 'test-results.json')}`,
  ]);
  const tests = JSON.parse(await readFile(path.join(scratch, 'test-results.json'), 'utf8'));
  if (!tests.numTotalTests || tests.numPendingTests || tests.numTodoTests || tests.numFailedTests)
    throw new Error('Required integration checks contain failures, skipped tests, or no tests.');
  result.tests = { total: tests.numTotalTests, passed: tests.numPassedTests, skipped: tests.numPendingTests || 0 };
  result.passed = true;
} catch (error) {
  result.error = error.message;
  console.error(result.error);
  process.exitCode = 1;
} finally {
  try {
    await run('docker', [...compose, 'down', '--volumes', '--remove-orphans'], true);
  } catch (error) {
    result.passed = false;
    result.error = error.message;
    process.exitCode = 1;
  }
  result.finishedAt = new Date().toISOString();
  await writeFile(path.join(scratch, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(`Integration result: ${path.join(scratch, 'result.json')}`);
}
