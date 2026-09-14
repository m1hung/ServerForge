import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
const exec = promisify(execFile);
it('restores a verified full recovery bundle into an isolated fresh host fixture', async () => {
  const project = process.env.SF_TEST_PROJECT;
  const scratch = process.env.SF_TEST_DATA_ROOT;
  if (!project?.startsWith('serverforge-test-') || !scratch) throw new Error('Run through npm run test:integration; recovery tests never use the live installation.');
  const url = new URL(process.env.SF_TEST_DATABASE_URL!);
  expect(url.username).toBe('serverforge_test');
  url.hostname = 'postgres'; url.port = '5432';
  const environment = path.join(scratch, 'recovery.env');
  await fs.writeFile(environment, `DATABASE_URL=${url.href}\n`, { mode: 0o600 });
  const { stdout } = await exec('docker', ['run', '--rm', '--network', `${project}_default`, '--env-file', environment, '-v', `${scratch}:/test`, '-v', `${path.resolve('tests/fixtures/recovery-drill.mjs')}:/drill.mjs:ro`, '--entrypoint', 'node', 'serverforge-rc-maintenance:check', '/drill.mjs'], { timeout: 120000, maxBuffer: 1024 * 1024 });
  expect(JSON.parse(stdout.trim()).ok).toBe(true);
  await fs.writeFile(path.join(scratch, 'recovery-result.json'), stdout, { mode: 0o600 });
}, 125000);
