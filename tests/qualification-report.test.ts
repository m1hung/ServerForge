import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { candidateIdentity, assertCandidate, qualificationReport } from '../packages/maintenance/src/qualification-report.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const images = Object.fromEntries(['API', 'WEB', 'MAINTENANCE', 'POSTGRES', 'TAILSCALE'].map((component, index) => [`${component}_IMAGE`, { version: '0.1.0-rc.2', revision: 'a'.repeat(40), architecture: 'amd64', digest: `sha256:${index.toString().repeat(64)}` }]));
const candidate = candidateIdentity('0.1.0-rc.2', images);
it('requires coherent versions, revisions and exact image identifiers', () => {
  expect(() => candidateIdentity('0.1.0-rc.1', images)).toThrow(/mismatch/);
  expect(() => candidateIdentity('0.1.0-rc.2', { ...images, WEB_IMAGE: { ...images.WEB_IMAGE, revision: 'b'.repeat(40) } })).toThrow(/mismatch/);
  expect(() => assertCandidate({ ...candidate, images: { ...candidate.images, api: 'wrong' } }, candidate)).toThrow(/different candidate/);
});
it('exports allowlisted evidence, redacts planted secrets, and keeps manual checks unfinished', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-report-')); roots.push(root);
  const resultRoot = path.join(root, 'qualification-results', 'run'); await fs.mkdir(resultRoot, { recursive: true });
  await fs.writeFile(path.join(root, 'qualification.json'), JSON.stringify({ format: 1, project: 'fixture', password: 'planted-password', setupToken: 'planted-token' }));
  const result = { format: 'serverforge-game-qualification', version: 1, candidate, ok: false, status: 'running', error: 'planted-password planted-token configured-secret Bearer private-key', password: 'other-secret', console: 'private-console', cases: [{ name: 'vanilla', status: 'running', console: 'private-console' }] };
  const file = path.join(resultRoot, 'result.json'); await fs.writeFile(file, JSON.stringify(result));
  await fs.writeFile(path.join(resultRoot, 'console.log'), 'never-export-raw-log');
  await fs.writeFile(path.join(root, 'backup.tar'), 'never-export-backup');
  await fs.writeFile(path.join(root, 'soak-host-123.jsonl'), JSON.stringify({ candidate, at: 'now', containers: [{ ID: 'id', CPUPerc: '1%', Name: 'private-name', secret: 'private-value' }] }) + '\n');
  const report = await qualificationReport(root, 'fixture', candidate, { docker: '29', host: { os: 'Linux', secret: 'private-host' } }, ['configured-secret']);
  const text = JSON.stringify(report);
  for (const secret of ['planted-password', 'planted-token', 'configured-secret', 'private-key', 'other-secret', 'private-console', 'never-export', 'private-name', 'private-value', 'private-host']) expect(text).not.toContain(secret);
  expect(report.reports[0].result).toBe('not-tested');
  expect(report.manualChecklist.every((entry: { result: string }) => entry.result === 'not-tested')).toBe(true);
  await expect(qualificationReport(root, 'wrong-project', candidate, {})).rejects.toThrow(/marker/);
  await fs.writeFile(file, JSON.stringify({ ...result, candidate: { ...candidate, sourceRevision: 'b'.repeat(40) } }));
  await expect(qualificationReport(root, 'fixture', candidate, {})).rejects.toThrow(/different candidate/);
  await fs.rm(file); await fs.symlink(path.join(root, 'qualification.json'), file);
  await expect(qualificationReport(root, 'fixture', candidate, {})).rejects.toThrow();
});
