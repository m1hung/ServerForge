import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { redactDiagnostic } from '@serverforge/core';

const components = ['api', 'web', 'maintenance', 'postgres', 'tailscale'];
export function candidateIdentity(release, images) {
  const first = images.API_IMAGE;
  if (!first || !/^[a-f0-9]{40}$/.test(first.revision || '')) throw new Error('Candidate source revision is missing.');
  const result = { release, sourceRevision: first.revision, architecture: first.architecture, images: {} };
  for (const component of components) {
    const image = images[`${component.toUpperCase()}_IMAGE`];
    if (!image || image.version !== release || image.revision !== first.revision || image.architecture !== first.architecture || !/^sha256:[a-f0-9]{64}$/.test(image.digest))
      throw new Error(`Candidate image/version mismatch: ${component}.`);
    result.images[component] = image.digest;
  }
  return result;
}

export function assertCandidate(actual, expected) {
  if (!actual || actual.release !== expected.release || actual.sourceRevision !== expected.sourceRevision || actual.architecture !== expected.architecture ||
      components.some((component) => actual.images?.[component] !== expected.images[component]))
    throw new Error('Qualification evidence belongs to a different candidate.');
}

const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
async function read(file, json = true) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 ** 2) throw new Error('Unsafe qualification evidence file.');
    const text = await handle.readFile('utf8');
    return json ? JSON.parse(text) : text;
  } finally { await handle.close(); }
}

/** Export structured evidence only. Console logs, credentials and backups stay local. */
export async function qualificationReport(configRoot, project, expected, host, secrets = []) {
  const marker = await read(path.join(configRoot, 'qualification.json'));
  if (marker.format !== 1 || marker.project !== project) throw new Error('Qualification export requires a matching isolated installation marker.');
  const root = path.join(configRoot, 'qualification-results');
  const reports = [];
  const directories = await fs.readdir(root, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  if (directories.length > 200) throw new Error('Too many qualification runs to export.');
  for (const directory of directories.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!directory.isDirectory()) throw new Error('Qualification result directories must not be links or special files.');
    const value = await read(path.join(root, directory.name, 'result.json'));
    if (!['serverforge-game-qualification', 'serverforge-mixed-operation-soak'].includes(value.format) || value.version !== 1)
      throw new Error('Unknown qualification evidence format.');
    assertCandidate(value.candidate, expected);
    const report = pick(value, ['format', 'version', 'startedAt', 'finishedAt', 'status', 'ok', 'error', 'cleanupError', 'requestedMinutes', 'elapsedMinutes', 'memoryGrowth']);
    report.result = value.ok === true ? 'pass' : value.status === 'running' || value.status === 'incomplete-duration' ? 'not-tested' : 'fail';
    if (Array.isArray(value.cases)) report.cases = value.cases.map((entry) => pick(entry, ['name', 'gameId', 'variantId', 'requestedVersion', 'version', 'build', 'javaMajor', 'startedAt', 'finishedAt', 'status', 'checks', 'error', 'packSha256', 'packBytes']));
    if (Array.isArray(value.cycles)) report.cycles = value.cycles.map((entry) => pick(entry, ['at', 'finishedAt', 'checks']));
    if (Array.isArray(value.samples)) report.samples = value.samples.map((entry) => ({ at: entry.at, activeOperations: entry.activeOperations, panel: pick(entry.panel, ['rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'uptimeSeconds']), game: pick(entry.game, ['cpuPercent', 'memoryBytes', 'memoryLimitBytes', 'pids']) }));
    reports.push(report);
  }
  const manualChecks = ['independent-installation', 'independent-fresh-host-recovery', 'keyboard-and-focus', 'screen-reader', '200-percent-zoom', 'narrow-screen', 'host-restart', 'LAN-client', 'tailnet-client', 'public-client', 'real-mod-effect', 'independent-security-review'];
  const hostSamples = [];
  const sampleFiles = (await fs.readdir(configRoot)).filter((name) => /^soak-host-\d+\.jsonl$/.test(name));
  if (sampleFiles.length > 50) throw new Error('Too many host sample files to export.');
  for (const file of sampleFiles.sort()) {
    const lines = (await read(path.join(configRoot, file), false)).trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const sample = JSON.parse(line);
      assertCandidate(sample.candidate, expected);
      hostSamples.push({ at: sample.at, error: sample.error, containers: sample.containers?.map((entry) => pick(entry, ['ID', 'CPUPerc', 'MemUsage', 'MemPerc', 'PIDs', 'BlockIO', 'NetIO'])) });
    }
  }
  return redactDiagnostic({ format: 'serverforge-qualification-submission', version: 1, candidate: expected, exportedAt: new Date().toISOString(), authorRun: true,
    host: { ...pick(host, ['docker', 'compose', 'architecture', 'memoryMib', 'cpus', 'dockerOperatingSystem', 'dockerKernel']), host: pick(host.host, ['os', 'release', 'architecture']) }, reports, hostSamples,
    manualChecklist: manualChecks.map((check) => ({ check, result: 'not-tested', evidence: '' })),
    limitations: ['Author-run automation is not independent human testing.', 'Manual checks and external platform qualification remain pending until a tester supplies evidence.', 'Real-client and mod-effect qualification is separate.'],
  }, [...secrets, marker.password, marker.setupToken].filter(Boolean));
}
