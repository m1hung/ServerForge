import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Docker from 'dockerode';
import { brand } from '@serverforge/core';
import type { ContainerSpec, RuntimeDriver } from '../apps/api/src/runtime/types.js';

/**
 * The Docker driver, against real Docker.
 *
 * Everything else in this suite is pure logic. This file is the one that
 * would have caught a wrong bind syntax, a label filter that matches nothing
 * or a log demuxer that drops the last line — none of which a mock can fail
 * on, because a mock agrees with whatever the code asks it.
 *
 * It skips rather than fails when Docker is unreachable, so `npm test` stays
 * green on a machine without it. Being in the `docker` group is what makes
 * the difference; if these skip unexpectedly, that is usually why.
 *
 * Everything created here is named `sf-selftest-*` and removed afterwards.
 * It never touches containers it did not create.
 */

const SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';

/**
 * A tiny image that is already present because the panel's own stack uses it.
 * Only its shell is used — the entrypoint is always overridden.
 */
const IMAGE = process.env.SF_TEST_IMAGE ?? 'redis:7-alpine';

const reachable = await new Docker({ socketPath: SOCKET })
  .ping()
  .then(() => true)
  .catch(() => false);

/**
 * Where the bind-mounted scratch directory goes.
 *
 * Deliberately not `/tmp`: a bind mount is resolved by the *daemon*, and the
 * daemon does not always share this process's `/tmp` — a rootless daemon, a
 * remote socket or a sandboxed test runner each break that assumption, and
 * the symptom is a silent empty mount rather than an error. The panel's own
 * data root is a path the daemon demonstrably reaches, since every game
 * server is bind-mounted out of it.
 */
const SCRATCH_ROOT =
  process.env.SF_TEST_DATA_ROOT ?? fileURLToPath(new URL('../data', import.meta.url));

const NETWORK = `sf-selftest-net-${process.pid}`;
const LABELS = {
  [`${brand.labelNamespace}/managed`]: 'true',
  [`${brand.labelNamespace}/role`]: 'selftest',
};

describe.skipIf(!reachable)('docker runtime driver', () => {
  let runtime: RuntimeDriver;
  let dataRoot: string;
  let counter = 0;
  const created: string[] = [];

  beforeAll(async () => {
    await mkdir(SCRATCH_ROOT, { recursive: true });
    dataRoot = await mkdtemp(path.join(SCRATCH_ROOT, 'sf-selftest-'));
    // Containers run as uid 1000, which is not necessarily the uid running
    // the tests, so the bind mount has to be writable by anyone.
    await chmod(dataRoot, 0o777);

    // config is read at import time; these are its only required values.
    process.env.SESSION_SECRET = 'a'.repeat(64);
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    process.env.DATABASE_URL ??= 'postgresql://serverforge:x@localhost:5432/serverforge';
    // Keep host/local path mapping an identity function: these tests run on
    // the host, so the path the driver binds is the path we made.
    process.env.DATA_ROOT = dataRoot;
    process.env.HOST_DATA_ROOT = dataRoot;
    process.env.DOCKER_SOCKET = SOCKET;

    const { DockerRuntime } = await import('../apps/api/src/runtime/docker.js');
    runtime = new DockerRuntime(SOCKET);
  }, 60_000);

  afterAll(async () => {
    const docker = new Docker({ socketPath: SOCKET });
    for (const id of created) {
      await docker
        .getContainer(id)
        .remove({ force: true })
        .catch(() => undefined);
    }
    await docker
      .getNetwork(NETWORK)
      .remove()
      .catch(() => undefined);
    if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
  }, 60_000);

  /** A spec that runs `sh -c <script>` and cleans up after itself. */
  function spec(script: string, overrides: Partial<ContainerSpec> = {}): ContainerSpec {
    return {
      name: `sf-selftest-${process.pid}-${counter++}`,
      image: IMAGE,
      command: ['/bin/sh', '-c', script],
      workingDir: '/home/container',
      env: {},
      dataPath: dataRoot,
      limits: { memoryMib: 64, cpuCores: 1, diskMib: 0 },
      ports: [],
      network: NETWORK,
      labels: LABELS,
      ...overrides,
    };
  }

  async function launch(script: string, overrides: Partial<ContainerSpec> = {}): Promise<string> {
    const id = await runtime.create(spec(script, overrides));
    created.push(id);
    return id;
  }

  /** Polls until the container is no longer running, or gives up. */
  async function waitForExit(id: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await runtime.status(id);
      if (!status.running) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`container ${id} was still running after ${timeoutMs}ms`);
  }

  it('reports the runtime as reachable', async () => {
    expect(await runtime.ping()).toBe(true);
  });

  it('treats an image that is already present as nothing to do', async () => {
    // No progress line means no pull was attempted, which is the whole point:
    // a pull on every start would add minutes to each server launch.
    const lines: string[] = [];
    await runtime.ensureImage(IMAGE, (line) => lines.push(line));
    expect(lines).toEqual([]);
  }, 60_000);

  it('creates a container that is present but not yet running', async () => {
    const id = await launch('sleep 30');

    const status = await runtime.status(id);
    expect(status.exists).toBe(true);
    expect(status.running).toBe(false);
  }, 90_000);

  it('starts a container and reports it as running', async () => {
    const id = await launch('sleep 30');
    await runtime.start(id);

    const status = await runtime.status(id);
    expect(status.running).toBe(true);
    expect(status.state).toBe('running');
  }, 90_000);

  it('reports a container that was never created as absent rather than throwing', async () => {
    const status = await runtime.status('sf-selftest-does-not-exist');
    expect(status).toEqual({ exists: false, running: false });
  });

  it('applies the memory limit it was given', async () => {
    const id = await launch('sleep 30', { limits: { memoryMib: 96, cpuCores: 1, diskMib: 0 } });
    await runtime.start(id);

    const usage = await runtime.stats(id);
    expect(usage).not.toBeNull();
    expect(usage!.memoryLimitBytes).toBe(96 * 1024 * 1024);
    expect(usage!.memoryBytes).toBeGreaterThan(0);
  }, 90_000);

  it('raises a limit on a running container without recreating it', async () => {
    const id = await launch('sleep 30', { limits: { memoryMib: 64, cpuCores: 1, diskMib: 0 } });
    await runtime.start(id);
    const before = await runtime.status(id);

    await runtime.updateLimits(id, { memoryMib: 128, cpuCores: 1, diskMib: 0 });

    const usage = await runtime.stats(id);
    expect(usage!.memoryLimitBytes).toBe(128 * 1024 * 1024);
    // Same container: a restart here would have disconnected every player.
    const after = await runtime.status(id);
    expect(after.startedAt).toBe(before.startedAt);
  }, 90_000);

  it('returns null stats for a container that is gone', async () => {
    expect(await runtime.stats('sf-selftest-does-not-exist')).toBeNull();
  });

  it('streams stdout line by line, without the frame headers', async () => {
    const id = await launch('echo first; echo second; echo third; sleep 2');
    const lines: { line: string; stream: string }[] = [];

    // Attach after starting: `follow` returns immediately for a container
    // that is not running, and `tail` replays whatever was printed in the
    // gap. This is the order the monitor uses for the same reason.
    await runtime.start(id);
    const handle = await runtime.streamLogs(id, {
      onLine: (line, stream) => lines.push({ line, stream }),
    });
    await waitForExit(id);
    // Give the stream a moment to drain after the process exits.
    await new Promise((resolve) => setTimeout(resolve, 500));
    handle.close();

    const stdout = lines.filter((l) => l.stream === 'stdout').map((l) => l.line);
    expect(stdout).toContain('first');
    expect(stdout).toContain('second');
    expect(stdout).toContain('third');
    // Docker's 8-byte multiplex header would show up as leading junk here.
    expect(stdout.every((line) => /^[\x20-\x7e]*$/.test(line))).toBe(true);
  }, 90_000);

  it('separates stderr from stdout', async () => {
    const id = await launch('echo out; echo err 1>&2; sleep 2');
    const seen: Record<string, string[]> = { stdout: [], stderr: [] };

    await runtime.start(id);
    const handle = await runtime.streamLogs(id, {
      onLine: (line, stream) => seen[stream].push(line),
    });
    await waitForExit(id);
    await new Promise((resolve) => setTimeout(resolve, 500));
    handle.close();

    expect(seen.stdout).toContain('out');
    expect(seen.stderr).toContain('err');
  }, 90_000);

  it('delivers a console command to the process on stdin', async () => {
    const id = await launch('read line; echo "received: $line"; sleep 1');
    const lines: string[] = [];

    await runtime.start(id);
    const handle = await runtime.streamLogs(id, { onLine: (line) => lines.push(line) });
    // The container is blocked on `read`; give it a moment to get there, or
    // the write lands before anything is listening on stdin.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await runtime.writeStdin(id, 'hello world\n');

    await waitForExit(id);
    await new Promise((resolve) => setTimeout(resolve, 500));
    handle.close();

    expect(lines).toContain('received: hello world');
  }, 90_000);

  it('stops in-band when the adapter provides a stop command', async () => {
    // Exits 0 only on the expected word, so the exit code proves the command
    // arrived on stdin rather than the container being signalled.
    const id = await launch('read line; [ "$line" = "stop" ] && exit 0; exit 7');
    await runtime.start(id);
    await new Promise((resolve) => setTimeout(resolve, 500));

    await runtime.stop(id, { stopCommand: 'stop\n', timeoutSeconds: 15 });

    const status = await runtime.status(id);
    expect(status.running).toBe(false);
    expect(status.exitCode).toBe(0);
  }, 90_000);

  it('falls back to signalling when there is no stop command', async () => {
    const id = await launch('sleep 60');
    await runtime.start(id);

    await runtime.stop(id, { timeoutSeconds: 5 });

    const status = await runtime.status(id);
    expect(status.running).toBe(false);
  }, 90_000);

  it('treats stopping an already-stopped container as success', async () => {
    const id = await launch('echo done');
    await runtime.start(id);
    await waitForExit(id);

    // Docker answers 304 here; the driver must swallow it, because the panel
    // stops servers it believes are running and races are normal.
    await expect(runtime.stop(id, { timeoutSeconds: 5 })).resolves.toBeUndefined();
    await expect(runtime.kill(id)).resolves.toBeUndefined();
  }, 90_000);

  it('removes a container and then reports it as absent', async () => {
    const id = await launch('sleep 30');
    await runtime.start(id);

    await runtime.remove(id, { force: true });

    expect(await runtime.status(id)).toEqual({ exists: false, running: false });
    // Removing something already gone must not throw either.
    await expect(runtime.remove(id)).resolves.toBeUndefined();
  }, 90_000);

  it('lists its own managed containers by label', async () => {
    const id = await launch('sleep 30');

    const managed = await runtime.listManaged();
    const mine = managed.find((entry) => entry.id === id);

    expect(mine).toBeDefined();
    // Names come back from Docker with a leading slash that has to be stripped.
    expect(mine!.name.startsWith('/')).toBe(false);
    expect(mine!.name).toMatch(/^sf-selftest-/);
  }, 90_000);

  it('publishes a port binding on the host interface it was given', async () => {
    const hostPort = 25599;
    const id = await launch('sleep 30', {
      ports: [{ hostIp: '127.0.0.1', hostPort, containerPort: 25565, protocol: 'tcp' }],
    });
    await runtime.start(id);

    const info = await new Docker({ socketPath: SOCKET }).getContainer(id).inspect();
    expect(info.NetworkSettings.Ports['25565/tcp']).toEqual([
      { HostIp: '127.0.0.1', HostPort: String(hostPort) },
    ]);
  }, 90_000);

  it('runs a throwaway job, returning its exit code and output', async () => {
    const lines: string[] = [];
    const result = await runtime.runOnce({
      image: IMAGE,
      command: ['/bin/sh', '-c', 'echo installing; echo done; exit 3'],
      dataPath: dataRoot,
      onLine: (line) => lines.push(line),
    });

    expect(result.exitCode).toBe(3);
    expect(result.output).toContain('installing');
    expect(lines).toContain('done');
  }, 120_000);

  it('writes into the mounted data directory from a throwaway job', async () => {
    const result = await runtime.runOnce({
      image: IMAGE,
      command: ['/bin/sh', '-c', 'echo hello > /home/container/proof.txt && cat /home/container/proof.txt'],
      dataPath: dataRoot,
    });

    expect(result.exitCode).toBe(0);
    const { readFile } = await import('node:fs/promises');
    // The bind mount is the contract every install step depends on: if this
    // fails, downloads land inside a container that is then thrown away.
    await expect(readFile(path.join(dataRoot, 'proof.txt'), 'utf8')).resolves.toContain('hello');
  }, 120_000);

  it('reports no mount table when it is not running inside a container', async () => {
    // The tests run on the host, so the lookup 404s and the driver says so
    // with null rather than an empty list, which would read as "no mounts".
    expect(await runtime.selfMounts()).toBeNull();
  }, 30_000);
});
