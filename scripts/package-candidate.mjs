#!/usr/bin/env node
// Creates private, immutable tester artifacts. Never pushes to a registry.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { snapshotSource } from './lib/candidate-source.mjs';
import { verifyCandidate } from './lib/verify-candidate.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const release = JSON.parse(await fs.readFile(path.join(repo, 'release.json'), 'utf8'));
const output = path.resolve(process.env.SF_CANDIDATE_OUTPUT || path.join(repo, 'data/candidates', `${release.version}-${new Date().toISOString().replaceAll(':', '-')}`));
const source = path.join(output, 'source');
const endpoint = process.env.DOCKER_HOST || (process.env.DOCKER_SOCKET ? `unix://${process.env.DOCKER_SOCKET}` : execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim());
const env = { ...process.env, DOCKER_HOST: endpoint };
const minutes = Number(process.env.SF_CANDIDATE_MINUTES || 330);
if (!Number.isFinite(minutes) || minutes < 1 || minutes > 330) throw new Error('Packaging must be bounded to 1–330 minutes.');
const deadline = Date.now() + minutes * 60000;
const report = { format: 'serverforge-candidate-artifacts', version: 1, release: release.version, startedAt: new Date().toISOString(), status: 'building', qualified: false, architectures: [], limitations: ['Artifact creation is not platform qualification. Consult the release report and actual tester/soak evidence.'] };
let created = false;
const save = () => fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
async function command(program, args, options = {}) {
  if (Date.now() >= deadline) throw new Error('The packaging time checkpoint was reached.');
  await new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: source, env: { ...env, ...options.env }, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill('SIGTERM'), deadline - Date.now());
    child.once('error', reject);
    child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${program} failed (${code}). Artifacts remain marked incomplete.`)); });
  });
}
async function hash(file) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}
async function filesUnder(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(file));
    else if (entry.isFile()) files.push(file);
    else throw new Error('Candidate artifacts must not contain links or special files.');
  }
  return files;
}
try {
  const snapshot = await snapshotSource(repo, output);
  created = true;
  const { sourceFiles } = snapshot;
  report.sourceRevision = snapshot.sourceRevision;
  report.sourceDigest = snapshot.sourceDigest;
  await fs.writeFile(path.join(output, 'source-files.json'), JSON.stringify(sourceFiles, null, 2) + '\n');
  await tar.c({ cwd: source, file: path.join(output, 'source.tar.gz'), gzip: true, portable: true }, ['.']);
  for (const architecture of ['amd64', 'arm64']) {
    console.log(`Building ${release.version} for linux/${architecture}.`);
    const directory = path.join(output, `serverforge-${release.version}-linux-${architecture}`);
    await fs.mkdir(directory, { recursive: true });
    const entry = { architecture, status: 'building', images: [], directory };
    report.architectures.push(entry); await save();
    for (const component of ['api', 'web', 'maintenance', 'postgres', 'tailscale']) {
      const reference = `serverforge-${component}:${release.version}-${architecture}`;
      const standardReference = `serverforge-${component}:${release.version}`;
      await command('docker', ['build', '--platform', `linux/${architecture}`, '--provenance=false', '-f', component === 'web' ? 'docker/Dockerfile.web' : ['postgres', 'tailscale'].includes(component) ? 'docker/Dockerfile.services' : 'docker/Dockerfile.api', '--target', ['maintenance', 'postgres', 'tailscale'].includes(component) ? component : 'runner', '--build-arg', `VERSION=${release.version}`, '--build-arg', `REVISION=${report.sourceRevision}`, '-t', reference, '.']);
      const [details] = JSON.parse(execFileSync('docker', ['image', 'inspect', reference], { env, encoding: 'utf8' }));
      if (details.Architecture !== architecture) throw new Error('Build produced the wrong architecture.');
      if (details.Config.Labels?.['org.opencontainers.image.version'] !== release.version || details.Config.Labels?.['org.opencontainers.image.revision'] !== report.sourceRevision) throw new Error('Build produced the wrong release metadata.');
      await command('docker', ['tag', reference, standardReference]);
      entry.images.push({ component, reference: standardReference, localReference: reference, digest: details.Id, architecture, sourceDigest: report.sourceDigest });
    }
    const scan = path.join(directory, 'security');
    await command(process.execPath, [path.join(source, 'scripts/scan-images.mjs')], { env: { SF_SCAN_OUTPUT: scan, SF_SCAN_EXTRA_IMAGES: JSON.stringify(Object.fromEntries(entry.images.filter((image) => ['postgres', 'tailscale'].includes(image.component)).map((image) => [image.component, image.localReference]))), ...Object.fromEntries(entry.images.map((image) => [`SF_${image.component.toUpperCase()}_TEST_IMAGE`, image.localReference])) } });
    // Scanner caches and logs are working data, not part of the tester bundle.
    await fs.rm(path.join(scan, 'grype-cache'), { recursive: true, force: true });
    for (const file of await filesUnder(scan)) if (file.endsWith('.log')) await fs.rm(file);
    await command('docker', ['save', '-o', path.join(directory, 'serverforge-images.tar'), ...entry.images.map((image) => image.reference)]);
    await fs.copyFile(path.join(source, 'release/serverforge'), path.join(directory, 'serverforge')); await fs.chmod(path.join(directory, 'serverforge'), 0o755);
    await fs.copyFile(path.join(output, 'source.tar.gz'), path.join(directory, 'source.tar.gz'));
    await fs.copyFile(path.join(output, 'source-files.json'), path.join(directory, 'source-files.json'));
    await fs.copyFile(path.join(source, 'release/security-exceptions.json'), path.join(scan, 'reviewed-findings.json'));
    await fs.copyFile(path.join(source, 'release.json'), path.join(directory, 'release.json'));
    await fs.copyFile(path.join(source, 'LICENSE'), path.join(directory, 'LICENSE'));
    await fs.cp(path.join(source, 'docs'), path.join(directory, 'docs'), { recursive: true });
    await fs.copyFile(path.join(source, 'docs/qualification.md'), path.join(directory, 'TESTING.md'));
    entry.status = 'artifacts-built-awaiting-qualification';
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ ...entry, format: 'serverforge-tester-bundle', version: 1, release: release.version, sourceRevision: report.sourceRevision, sourceDigest: report.sourceDigest, qualified: false }, null, 2) + '\n');
    const sums = [];
    for (const file of (await filesUnder(directory)).sort()) sums.push(`${await hash(file)}  ${path.relative(directory, file)}`);
    await fs.writeFile(path.join(directory, 'SHA256SUMS'), sums.join('\n') + '\n');
    entry.verification = await verifyCandidate(directory);
    await save();
  }
  const hostArchitecture = execFileSync('docker', ['info', '--format', '{{.Architecture}}'], { env, encoding: 'utf8' }).trim();
  const native = report.architectures.find((entry) => entry.architecture === (['arm64', 'aarch64'].includes(hostArchitecture) ? 'arm64' : 'amd64'));
  for (const image of native?.images || []) await command('docker', ['tag', image.localReference, image.reference]);
  report.status = 'artifacts-built-awaiting-qualification';
} catch (error) { report.status = 'incomplete'; report.error = error.message; process.exitCode = 1; }
finally { report.finishedAt = new Date().toISOString(); if (created) await save(); console.log(`Artifact checkpoint: ${output}`); }
