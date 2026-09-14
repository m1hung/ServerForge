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

it('keeps installer configuration private and readable by a different Linux host UID', async () => {
  const project = process.env.SF_TEST_PROJECT;
  if (!project?.startsWith('serverforge-test-')) throw new Error('Use the isolated integration launcher.');
  const volume = `${project}-host-ownership`;
  const image = 'serverforge-rc-maintenance:check';
  const docker = (args: string[]) => exec('docker', args, { timeout: 120000, maxBuffer: 1024 * 1024 });
  await docker(['volume', 'create', '--label', `serverforge.io/test-project=${project}`, volume]);
  try {
    // A daemon-local Linux volume tests real UID boundaries even under Desktop,
    // whose host bind sharing can make every file appear owned by the caller.
    await docker(['run', '--rm', '--network', 'none', '-v', `${volume}:/installation`, '--entrypoint', 'node', image, '-e', 'const fs=require("fs");fs.chmodSync("/installation",0o700);fs.chownSync("/installation",60001,60002)']);
    const net = await import('node:net');
    const port = await new Promise<number>((resolve) => { const listener = net.createServer(); listener.listen(0, '127.0.0.1', () => { const value = (listener.address() as import('node:net').AddressInfo).port; listener.close(() => resolve(value)); }); });
    const info = JSON.parse((await docker(['info', '--format', '{{json .}}'])).stdout);
    const socket = info.OperatingSystem.includes('Docker Desktop') ? '/var/run/docker.sock' : process.env.DOCKER_SOCKET!;
    await docker(['run', '--rm', '-v', `${volume}:/installation`, '-v', `${socket}:/var/run/docker.sock`, '-e', `SF_HOST_ROOT=/serverforge-fixture/${project}`, '-e', `SF_MAINTENANCE_IMAGE=${image}`, '--entrypoint', 'node', image, 'packages/maintenance/src/host.mjs', 'setup', '--configure-only', '--port', String(port), '--api-image', 'serverforge-rc-api:check', '--web-image', 'serverforge-rc-web:check']);
    const result = await docker(['run', '--rm', '--network', 'none', '--user', '60001:60002', '--cap-drop', 'ALL', '-v', `${volume}:/installation:ro`, '--entrypoint', 'node', image, '-e', 'const fs=require("fs");const paths=["/installation/config","/installation/config/.env"];fs.readFileSync(paths[1]);console.log(JSON.stringify(paths.map(path=>{const s=fs.statSync(path);return {uid:s.uid,gid:s.gid,mode:s.mode&511}})))']);
    expect(JSON.parse(result.stdout)).toEqual([{ uid: 60001, gid: 60002, mode: 0o700 }, { uid: 60001, gid: 60002, mode: 0o600 }]);
  } finally { await docker(['volume', 'rm', volume]); }
}, 180000);
