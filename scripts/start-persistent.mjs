#!/usr/bin/env node
/** Source builds use the packaged maintenance workflow for installation and upgrades. */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDockerGroupAccess } from './lib/docker-access.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
ensureDockerGroupAccess({ cwd: root, argv: process.argv });
const release = JSON.parse(await fs.readFile(path.join(root, 'release.json'), 'utf8'));
const environment = { ...process.env, SERVERFORGE_HOME: root, SERVERFORGE_MAINTENANCE_IMAGE: `serverforge-maintenance:${release.version}` };
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: environment, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code}. Existing configuration and recovery checkpoints are retained.`)));
  });
}
try {
  if (process.platform === 'win32') throw new Error('Run the production launcher inside WSL2 with Docker Desktop using Linux containers.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Source builds require Node.js 22 or newer. Packaged installations need only Docker.');
  await run('docker', ['info', '--format', 'Docker {{.ServerVersion}} / {{.OSType}} / {{.Architecture}}']);
  console.log('Building local candidate images. The panel remains online until the backed-up upgrade begins.');
  for (const [service, file, target] of [['api', 'docker/Dockerfile.api', 'runner'], ['web', 'docker/Dockerfile.web', 'runner'], ['maintenance', 'docker/Dockerfile.api', 'maintenance'], ['postgres', 'docker/Dockerfile.services', 'postgres'], ['tailscale', 'docker/Dockerfile.services', 'tailscale']]) {
    await run('docker', ['build', '--file', file, '--target', target, '--build-arg', `VERSION=${release.version}`, '--tag', `serverforge-${service}:${release.version}`, '.']);
  }
  const configured = await fs.stat(path.join(root, 'config/.env')).catch(() => null);
  if (!configured && await fs.stat(path.join(root, '.env')).catch(() => null)) await run('bash', ['release/serverforge', 'adopt']);
  if (await fs.stat(path.join(root, 'config/.env')).catch(() => null)) await run('bash', ['release/serverforge', 'upgrade', release.version]);
  else await run('bash', ['release/serverforge', 'setup']);
} catch (error) { console.error(error.message); process.exitCode = 1; }
