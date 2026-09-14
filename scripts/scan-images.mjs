#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.env.SF_SCAN_OUTPUT || path.join(root, 'data/release-tests/image-scans-current'));
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const outputOwner = await fs.stat(output);
const socket = process.env.DOCKER_HOST || (process.env.DOCKER_SOCKET ? `unix://${process.env.DOCKER_SOCKET}` : execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim());
const env = { ...process.env, DOCKER_HOST: socket };
const scanners = {
  syft: 'anchore/syft@sha256:95fe0835e5bebc6f8b1f8acef68d47d63d594ef4c0f25c097ff853b23cbac74c',
  grype: 'anchore/grype@sha256:8a93fc48da96bd6ec5981279d099b69de11541dc68fdf222fb9161f8ff284af7',
};
const release = JSON.parse(await fs.readFile(path.join(root, 'release.json'), 'utf8'));
const exceptions = JSON.parse(await fs.readFile(path.join(root, 'release/security-exceptions.json'), 'utf8'));
async function docker(args, name) {
  const log = createWriteStream(path.join(output, `${name}.log`), { mode: 0o600 });
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    child.once('error', reject);
    child.once('close', (code) => {
      log.end(async () => {
        if (code === 0) resolve();
        else {
          const detail = await fs.readFile(path.join(output, `${name}.log`), 'utf8').catch(() => '');
          reject(new Error(`${name} failed (${code}): ${detail.slice(-4000) || 'See its scanner log.'}`));
        }
      });
    });
  });
}
const reports = [];
let ok = true;
const targets = process.env.SF_SCAN_ONLY_EXTRA === 'true' ? {} : Object.fromEntries(['api', 'web', 'maintenance'].map((name) => [name, process.env[`SF_${name.toUpperCase()}_TEST_IMAGE`] || `serverforge-rc-${name}:check`]));
if (process.env.SF_SCAN_ONLY_EXTRA !== 'true') Object.assign(targets, { postgres: release.postgresImage, tailscale: release.tailscaleImage });
Object.assign(targets, JSON.parse(process.env.SF_SCAN_EXTRA_IMAGES || '{}'));
if (!Object.keys(targets).length || Object.entries(targets).some(([name, reference]) => !/^[a-z0-9-]{1,40}$/.test(name) || typeof reference !== 'string' || !reference)) throw new Error('Provide named image references to scan.');
try {
  await docker(['info'], 'docker');
  for (const [name, image] of Object.entries(scanners)) await docker(['pull', image], `pull-${name}`);
  const cache = path.join(output, 'grype-cache'); await fs.mkdir(cache, { recursive: true });
  for (const [name, reference] of Object.entries(targets)) {
    const [info] = JSON.parse(execFileSync('docker', ['image', 'inspect', reference], { env, encoding: 'utf8' }));
    if (['api', 'web', 'maintenance'].includes(name)) await docker(['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '256m', '--entrypoint', 'sh', reference, '-c', 'set -eu; for tool in infocmp mount umount nsenter unshare npm npx; do if command -v "$tool" >/dev/null 2>&1; then echo "Unexpected runtime tool: $tool"; exit 1; fi; done; test -z "$(find /usr -xdev -type f -perm /6000 -print -quit)"; test ! -d /app/node_modules/typescript; test ! -d /app/node_modules/vitest; test ! -d /app/node_modules/happy-dom'], `${name}-runtime-contents`);
    if (name === 'postgres') await docker(['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '256m', '--entrypoint', 'sh', reference, '-c', 'set -eu; for tool in infocmp mount umount nsenter unshare; do if command -v "$tool" >/dev/null 2>&1; then echo "Unexpected database tool: $tool"; exit 1; fi; done; test -z "$(find /usr -xdev -type f -perm /6000 -print -quit)"'], `${name}-runtime-contents`);
    if (name === 'tailscale' && !info.Config.Env.includes('TS_DISABLE_SSH_SERVER=true')) throw new Error('The packaged Tailscale image must disable its SSH server.');
    console.log(`Exporting and scanning ${name} (${info.Architecture}).`);
    const archive = path.join(output, `${name}.tar`);
    await docker(['image', 'save', '-o', archive, reference], `${name}-export`);
    // With all capabilities dropped, root cannot traverse another user's 0700
    // report directory on Linux. Write reports as its owner, preserving privacy.
    const limits = ['run', '--rm', '--user', `${outputOwner.uid}:${outputOwner.gid}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '512', '--memory', '1g', '--cpus', '2', '-e', 'TMPDIR=/output', '-e', 'XDG_CACHE_HOME=/output/grype-cache', '-e', 'SYFT_CHECK_FOR_APP_UPDATE=false', '-v', `${output}:/output`, '-v', `${archive}:/image.tar:ro`];
    await docker([...limits, '--network', 'none', scanners.syft, 'scan', 'docker-archive:/image.tar', '-o', `cyclonedx-json=/output/${name}.sbom.json`], `${name}-syft`);
    await docker([...limits, '-v', `${cache}:/cache`, '-e', 'GRYPE_DB_CACHE_DIR=/cache', scanners.grype, 'docker-archive:/image.tar', '-o', 'json', '--file', `/output/${name}.scan.json`], `${name}-grype`);
    const scan = JSON.parse(await fs.readFile(path.join(output, `${name}.scan.json`), 'utf8'));
    const matches = scan.matches.filter((match) => ['Critical', 'High'].includes(match.vulnerability.severity));
    const unreviewed = matches.filter((match) => !exceptions.some((entry) => entry.images.includes(name) && entry.vulnerability === match.vulnerability.id && entry.packages[match.artifact.name] === match.artifact.version && entry.reason && entry.source && new Date(entry.expiresAt).getTime() > Date.now()));
    if (unreviewed.length || scan.descriptor?.db?.status?.valid !== true) ok = false;
    reports.push({ image: name, reference, digest: info.Id, architecture: info.Architecture, database: scan.descriptor?.db, highCritical: matches.length, unreviewed: unreviewed.map((match) => ({ id: match.vulnerability.id, severity: match.vulnerability.severity, package: match.artifact.name, version: match.artifact.version, fix: match.vulnerability.fix, source: match.vulnerability.dataSource, locations: match.artifact.locations.map((location) => location.path) })) });
    await fs.rm(archive);
    console.log(`${name}: ${matches.length} high/critical findings; ${unreviewed.length} require review.`);
  }
} catch (error) { ok = false; reports.push({ error: error.message }); console.error(error.message); }
await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ format: 'serverforge-image-security', version: 1, at: new Date().toISOString(), ok, scanners, images: reports }, null, 2) + '\n', { mode: 0o600 });
if (!ok) process.exitCode = 1;
