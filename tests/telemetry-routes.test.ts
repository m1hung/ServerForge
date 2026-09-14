import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { isAppError, unauthorized } from '@serverforge/core';

const state = vi.hoisted(() => ({
  server: {} as Record<string, unknown>,
  stats: vi.fn(),
  streamLogs: vi.fn(),
  close: vi.fn(),
  installs: vi.fn(),
}));
vi.mock('@serverforge/db', () => ({
  prisma: {
    server: { findUnique: async () => state.server },
    installLog: { findMany: state.installs },
  },
  serializeBigInts: (value: unknown) => value,
  uid: () => 'unused',
}));
vi.mock('../apps/api/src/plugins/auth.js', () => ({
  requireUser: (request: FastifyRequest) => {
    if (!request.headers['x-user']) throw unauthorized();
    return { id: request.headers['x-user'], role: 'user' };
  },
}));
vi.mock('../apps/api/src/lib/config.js', () => ({
  config: { dockerSocket: '/none', dataRoot: '/tmp' },
  runningInContainer: () => false,
}));
vi.mock('../apps/api/src/runtime/docker.js', () => ({
  DockerRuntime: class {
    stats = state.stats;
    streamLogs = state.streamLogs;
  },
}));
import { serverRoutes } from '../apps/api/src/routes/servers.js';

let app: FastifyInstance;
let controller: AbortController | undefined;
beforeEach(async () => {
  vi.clearAllMocks();
  state.server = {
    id: 'id',
    uid: 'test',
    name: 'Test',
    ownerId: 'owner',
    containerId: 'container',
    gameId: 'minecraft-java',
    variantId: 'fabric',
    state: 'running',
    dataPath: '/nonexistent/serverforge-test',
    allocations: [],
    subusers: [{ userId: 'viewer', permissions: ['server.view'], roles: [] }],
  };
  state.stats.mockResolvedValue({ cpuPercent: 37, memoryBytes: 123456 });
  state.installs.mockResolvedValue([]);
  state.streamLogs.mockImplementation(async (_id, options) => {
    options.onLine('\u001b[32mReady\u001b[0m', 'stdout');
    options.onLine('Warning', 'stderr');
    return { close: state.close };
  });
  app = Fastify();
  await app.register(cors, { origin: 'http://localhost:3000', credentials: true });
  app.setErrorHandler((error, _request, reply) => {
    if (isAppError(error)) return reply.code(error.status).send(error.toJSON());
    return reply.code(500).send({ error: { message: error.message } });
  });
  await app.register(serverRoutes);
});
afterEach(async () => {
  controller?.abort();
  controller = undefined;
  await app.close();
});

async function stream() {
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  controller = new AbortController();
  const response = await fetch(`${origin}/servers/test/console/stream`, {
    headers: { 'x-user': 'owner', origin: 'http://localhost:3000' },
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  let received = '';
  return {
    response,
    async until(text: string) {
      while (!received.includes(text)) {
        const part = await reader.read();
        if (part.done) throw new Error(`Stream ended before ${text}`);
        received += new TextDecoder().decode(part.value);
      }
      return received;
    },
  };
}

describe('server telemetry HTTP API', () => {
  it('requires authentication and console permission before opening a stream', async () => {
    expect((await app.inject('/servers/test/console/stream')).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/servers/test/console/stream', headers: { 'x-user': 'viewer' } }))
        .statusCode,
    ).toBe(404);
    expect(state.streamLogs).not.toHaveBeenCalled();
  });
  it('allows resource readings with view permission but rejects non-members', async () => {
    expect(
      (
        await app.inject({ url: '/servers/test/resources', headers: { 'x-user': 'viewer' } })
      ).json(),
    ).toMatchObject({ containerId: 'container', usage: { cpuPercent: 37 } });
    expect(state.stats).toHaveBeenCalledWith('container');
    expect(
      (await app.inject({ url: '/servers/test/resources', headers: { 'x-user': 'stranger' } }))
        .statusCode,
    ).toBe(404);
    state.server.containerId = null;
    expect(
      (await app.inject({ url: '/servers/test/resources', headers: { 'x-user': 'owner' } })).json()
        .usage,
    ).toBeNull();
  });
  it('streams actual sanitized stdout/stderr and releases Docker on disconnect', async () => {
    const connection = await stream();
    expect(connection.response.headers.get('content-type')).toContain('text/event-stream');
    expect(connection.response.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:3000',
    );
    expect(connection.response.headers.get('access-control-allow-credentials')).toBe('true');
    const text = await connection.until('Warning');
    expect(text).toContain('event: reset');
    expect(text).toContain('"line":"Ready","stream":"stdout"');
    expect(text).toContain('"line":"Warning","stream":"stderr"');
    expect(text).not.toContain('\\u001b');
    expect(state.streamLogs).toHaveBeenCalledWith(
      'container',
      expect.objectContaining({ tail: 500 }),
    );
    controller!.abort();
    await vi.waitFor(() => expect(state.close).toHaveBeenCalledOnce());
  });
  it('replays installation history in chronological order before a game container exists', async () => {
    state.server.containerId = null;
    state.server.state = 'offline';
    state.installs.mockResolvedValue([
      { id: 2n, phase: 'done', message: 'Installed' },
      { id: 1n, phase: 'download', message: 'Downloading' },
    ]);
    const connection = await stream();
    const text = await connection.until('Installed');
    expect(text.indexOf('Downloading')).toBeLessThan(text.indexOf('Installed'));
    expect(state.streamLogs).not.toHaveBeenCalled();
  });
  it('exposes read-only consoles without pretending commands work', async () => {
    state.server.gameId = 'valheim';
    state.server.variantId = 'valheim';
    const metadata = (
      await app.inject({ url: '/servers/test', headers: { 'x-user': 'owner' } })
    ).json();
    expect(metadata.server.console).toMatchObject({ canRead: true, acceptsCommands: false });
    const command = await app.inject({
      method: 'POST',
      url: '/servers/test/console',
      headers: { 'x-user': 'owner' },
      payload: { command: 'help' },
    });
    expect(command.statusCode).toBe(400);
  });
});
