/* eslint-disable @typescript-eslint/no-explicit-any -- Stateful database fixtures. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { isAppError, unauthorized } from '@serverforge/core';

const state = vi.hoisted(() => ({
  root: '',
  server: null as null | Record<string, unknown>,
  create: vi.fn(),
  logs: [] as string[],
  attempts: [] as any[],
  ids: 0,
}));
vi.mock('../apps/api/src/services/platform.js', () => ({ selectGamePlatform: async () => 'linux/amd64' }));
vi.mock('../apps/api/src/services/resources.js', () => ({
  validateAllocation: async () => undefined,
  nodeCapacity: async () => null,
  requireFreeSpace: async () => undefined,
  measuredServerBytes: () => null,
}));
vi.mock('@serverforge/db', () => ({
  prisma: {
    async $transaction(work: any) {
      return Array.isArray(work) ? Promise.all(work) : work(this);
    },
    node: { findFirst: async () => ({ id: 'local', name: 'Local' }) },
    allocation: {
      findMany: async () =>
        [25565, 25566, 25567].map((port) => ({ id: String(port), ip: '0.0.0.0', port })),
      updateMany: async () => ({ count: 1 }),
    },
    server: {
      create: state.create,
      findUniqueOrThrow: async () => state.server,
      findUnique: async () => state.server,
      update: async ({ data }: { data: Record<string, unknown> }) =>
        (state.server = { ...state.server, ...data }),
    },
    installLog: {
      create: async ({ data }: { data: { message: string } }) => state.logs.push(data.message),
    },
    installationAttempt: {
      findFirst: async () => state.attempts.at(-1) ?? null,
      findUniqueOrThrow: async ({ where }: any) => state.attempts.find((a) => a.id === where.id),
      create: async ({ data }: any) => {
        const attempt = {
          ...data,
          id: data.uid,
          state: 'queued',
          phase: 'preparing',
          progress: 0,
          cancelRequestedAt: null,
        };
        state.attempts.push(attempt);
        return attempt;
      },
      update: async ({ where, data }: any) =>
        Object.assign(
          state.attempts.find((a) => a.id === where.id),
          data,
        ),
      updateMany: async ({ where, data }: any) => {
        const rows = state.attempts.filter(
          (a) =>
            (!where.id || a.id === where.id) &&
            (where.cancelRequestedAt !== null || a.cancelRequestedAt === null) &&
            (!where.state ||
              (typeof where.state === 'string'
                ? a.state === where.state
                : where.state.in.includes(a.state))),
        );
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
      delete: async ({ where }: any) => {
        state.attempts = state.attempts.filter((a) => a.id !== where.id);
      },
    },
  },
  serializeBigInts: (value: unknown) => value,
  uid: () => (state.ids++ ? `attempt-${state.ids}` : 'uploaded-server'),
}));
vi.mock('../apps/api/src/lib/config.js', () => ({
  config: {
    get dataRoot() {
      return state.root;
    },
    get hostDataRoot() {
      return state.root;
    },
    dockerSocket: '/unused',
  },
  runningInContainer: () => false,
}));
vi.mock('../apps/api/src/plugins/auth.js', () => ({
  requireAdmin: (request: FastifyRequest) => {
    if (!request.headers['x-user']) throw unauthorized();
    return { id: 'owner', role: 'owner' };
  },
  requireUser: (request: FastifyRequest) => {
    if (!request.headers['x-user']) throw unauthorized();
    return { id: 'owner', role: 'user' };
  },
}));
vi.mock('../apps/api/src/lib/server-files.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prepareServerOwnership: async () => undefined,
}));
import { serverRoutes } from '../apps/api/src/routes/servers.js';
import { drainServerOperations } from '../apps/api/src/services/server-lock.js';
import { getAdapter } from '@serverforge/adapters';

let app: FastifyInstance;
const configuration = {
  name: 'Uploaded pack',
  gameId: 'minecraft-java',
  variantId: 'custom-modpack',
  version: 'latest',
  limits: { memoryMib: 6144, cpuCores: 2.5, diskMib: 20480 },
  settings: { motd: 'Our uploaded world' },
  acceptedEula: 'minecraft-eula',
  startOnCreate: false,
};

beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-upload-pack-'));
  state.server = null;
  state.logs = [];
  state.attempts = [];
  state.ids = 0;
  state.create.mockReset().mockImplementation(
    async ({ data }) =>
      (state.server = {
        ...data,
        id: 'new-server',
        allocations: [{ port: 25565, purpose: 'game', primary: true }],
        node: { name: 'Local' },
        environment: {},
        build: null,
        javaMajor: null,
        startupOverride: null,
        javaFlagsPreset: 'balanced',
        customJavaFlags: null,
        installedAt: null,
        subusers: [],
      }),
  );
  app = Fastify();
  await app.register(multipart);
  app.addHook('preHandler', async (request) => {
    // Exercise the real streaming limit without sending a 2 GiB test fixture.
    if (request.headers['x-small-limit']) {
      const parts = request.parts.bind(request);
      request.parts = (options) =>
        parts({ ...options, limits: { ...options?.limits, fileSize: 32 } });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (isAppError(error)) return reply.code(error.status).send(error.toJSON());
    return reply
      .code(error.statusCode ?? (error.name === 'ZodError' ? 400 : 500))
      .send({ error: { message: error.message } });
  });
  await app.register(serverRoutes);
});
afterEach(async () => {
  await drainServerOperations();
  vi.restoreAllMocks();
  await app.close();
  await fs.rm(state.root, { recursive: true, force: true });
});

async function upload(
  options: {
    name?: string;
    contents?: Buffer;
    configuration?: object;
    authenticated?: boolean;
    smallLimit?: boolean;
  } = {},
) {
  const contents =
    options.contents ?? (await fs.readFile('tests/fixtures/mod-zips/upload-pack.zip'));
  return app.inject({
    method: 'POST',
    url: '/servers',
    headers: {
      'content-type': 'multipart/form-data; boundary=packboundary',
      ...(options.authenticated !== false ? { 'x-user': 'owner' } : {}),
      ...(options.smallLimit ? { 'x-small-limit': 'true' } : {}),
    },
    payload: Buffer.concat([
      Buffer.from(
        `--packboundary\r\nContent-Disposition: form-data; name="configuration"\r\n\r\n${JSON.stringify(options.configuration ?? configuration)}\r\n`,
      ),
      Buffer.from(
        `--packboundary\r\nContent-Disposition: form-data; name="pack"; filename="${options.name ?? 'CurseForge Server Pack.zip'}"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
      contents,
      Buffer.from('\r\n--packboundary--\r\n'),
    ]),
  });
}

describe('server pack upload', () => {
  it('identifies a single-manifest client export and preserves its original upload for retry', async () => {
    const contents = await fs.readFile('tests/fixtures/client-profile-export.zip');
    const response = await upload({ contents });
    expect(response.statusCode, response.body).toBe(202);
    await drainServerOperations();
    expect(state.server?.state).toBe('install_failed');
    expect(state.attempts[0].error).toContain('CurseForge client/profile export');
    expect(await fs.readFile(state.attempts[0].sourcePackPath)).toEqual(contents);
  });
  it('streams a ZIP, installs its wrapped server files, and preserves configuration and hardware', async () => {
    const response = await upload();
    expect(response.statusCode, response.body).toBe(202);
    await vi.waitFor(() => expect(state.server?.state).toBe('offline'));
    const root = path.join(state.root, 'uploaded-server');
    expect(await fs.readFile(path.join(root, 'server.jar'), 'utf8')).toBe('test server launcher');
    expect(await fs.readFile(path.join(root, 'mods/example.jar'), 'utf8')).toBe('test mod');
    expect(await fs.readFile(path.join(root, 'config/example.toml'), 'utf8')).toBe(
      'enabled = true\n',
    );
    expect(await fs.readFile(path.join(root, 'server.properties'), 'utf8')).toContain(
      'motd=Our uploaded world',
    );
    expect(state.server).toMatchObject({
      memoryMib: 6144,
      cpuCores: 2.5,
      version: '1.20.1',
      javaMajor: 17,
    });
    expect(state.logs.some((message) => message.includes('you uploaded'))).toBe(true);
    expect(await fs.readdir(path.join(root, '.serverforge'))).toEqual(['installation.json']);
    await drainServerOperations();
    expect(state.attempts[0].state).toBe('completed');
    expect(await fs.stat(state.attempts[0].sourcePackPath).catch(() => null)).toBeNull();
  });
  it('requires authentication and EULA acceptance before creating or storing a pack', async () => {
    expect((await upload({ authenticated: false })).statusCode).toBe(401);
    expect(
      (await upload({ configuration: { ...configuration, acceptedEula: '' } })).statusCode,
    ).toBe(400);
    expect(state.create).not.toHaveBeenCalled();
    expect(await fs.readdir(state.root)).toEqual([]);
  });
  it('rejects uploads for other editions, missing packs, invalid ZIPs, and empty uploads', async () => {
    for (const options of [
      { configuration: { ...configuration, variantId: 'paper' } },
      { name: 'pack.jar' },
      { contents: Buffer.from('not a zip') },
      { contents: Buffer.alloc(0) },
    ]) {
      const response = await upload(options);
      expect(response.statusCode, response.body).toBe(400);
      expect(await fs.readdir(state.root)).toEqual([]);
    }
    expect(state.create).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/servers',
          headers: { 'x-user': 'owner' },
          payload: configuration,
        })
      ).statusCode,
    ).toBe(400);
  });
  it('removes partial files when the streaming size limit is reached or database creation fails', async () => {
    const limited = await upload({ smallLimit: true });
    expect([400, 413]).toContain(limited.statusCode);
    expect(await fs.readdir(state.root)).toEqual([]);
    expect(state.create).not.toHaveBeenCalled();
    state.create.mockRejectedValueOnce(new Error('Database unavailable'));
    expect((await upload()).statusCode).toBe(500);
    expect(await fs.readdir(state.root)).toEqual([]);
  });
  it.each(['traversal.zip', 'symlink.zip'])(
    'rejects unsafe %s during installation without writing outside the server',
    async (name) => {
      const response = await upload({
        contents: await fs.readFile(`tests/fixtures/mod-zips/${name}`),
      });
      expect(response.statusCode).toBe(202);
      await vi.waitFor(() => expect(state.server?.state).toBe('install_failed'));
      await drainServerOperations();
      expect((await fs.readdir(state.root)).sort()).toEqual(['.operations', 'uploaded-server']);
      expect(state.attempts[0].state).toBe('failed');
      expect(await fs.stat(state.attempts[0].sourcePackPath)).toBeTruthy();
    },
  );
  it('keeps the uploaded pack after a failed attempt and retries using a fresh staging directory', async () => {
    const install = vi.spyOn(getAdapter('minecraft-java'), 'install');
    install.mockImplementationOnce(async (_ctx, tools) => {
      await tools.remove('.serverforge/pack.zip');
      await tools.writeFile('broken.txt', 'partial installation');
      throw new Error('Test installer failed');
    });
    expect((await upload()).statusCode).toBe(202);
    await vi.waitFor(() => expect(state.server?.state).toBe('install_failed'));
    await drainServerOperations();
    expect(state.attempts[0].error).toContain('Test installer failed');
    expect(await fs.stat(state.attempts[0].sourcePackPath)).toBeTruthy();
    expect(await fs.stat(state.attempts[0].stagingPath).catch(() => null)).toBeNull();
    const retry = await app.inject({
      method: 'POST',
      url: '/servers/uploaded-server/installation/retry',
      headers: { 'x-user': 'owner' },
    });
    expect(retry.statusCode, retry.body).toBe(202);
    await drainServerOperations();
    expect(state.attempts.map((a) => a.state)).toEqual(['failed', 'completed']);
    expect(state.attempts[0].stagingPath).not.toBe(state.attempts[1].stagingPath);
    expect(
      await fs.stat(path.join(state.root, 'uploaded-server/broken.txt')).catch(() => null),
    ).toBeNull();
  });

  it('records cancellation, preserves the pack, and never commits cancelled staging files', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(getAdapter('minecraft-java'), 'install').mockImplementationOnce(
      async (_ctx, tools, report) => {
        await report.phase('downloading', 'Waiting in test', 20);
        await waiting;
        await tools.writeFile('cancelled.txt', 'must not reach the live directory');
      },
    );
    expect((await upload()).statusCode).toBe(202);
    await vi.waitFor(() => expect(state.attempts[0]?.phase).toBe('downloading'));
    const cancel = await app.inject({
      method: 'POST',
      url: '/servers/uploaded-server/installation/cancel',
      headers: { 'x-user': 'owner' },
    });
    release();
    expect(cancel.statusCode, cancel.body).toBe(202);
    await drainServerOperations();
    expect(state.attempts[0].state).toBe('cancelled');
    expect(await fs.stat(state.attempts[0].sourcePackPath)).toBeTruthy();
    expect(
      await fs.stat(path.join(state.root, 'uploaded-server/cancelled.txt')).catch(() => null),
    ).toBeNull();
  });
});
