import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { defaultsFor, isAppError, unauthorized } from '@serverforge/core';
import type { ServerWithAccess } from '@serverforge/db';
import type { PortForward, TailnetStatus, ServerConnections } from '@serverforge/core/connectivity';
import type { discoverNetwork } from '../apps/api/src/services/connectivity.js';
import { getAdapter } from '@serverforge/adapters';
const state = vi.hoisted(() => ({
  server: {} as ServerWithAccess,
  discovery: {} as Awaited<ReturnType<typeof discoverNetwork>>,
  forwards: [] as PortForward[],
  tailscale: {} as TailnetStatus,
  save: vi.fn(),
  reconcile: vi.fn().mockResolvedValue(undefined),
  connect: vi.fn(),
  serve: vi.fn(),
  runtimeStatus: vi.fn(),
}));
vi.mock('@serverforge/db', () => ({
  prisma: {
    server: {
      findUnique: async () => state.server,
      findMany: async () => [
        {
          uid: state.server.uid,
          name: state.server.name,
          state: state.server.state,
          publicAccess: state.server.publicAccess,
        },
      ],
      update: async ({ data }: { data: Partial<ServerWithAccess> }) => {
        Object.assign(state.server, data);
        return state.server;
      },
    },
    activity: { create: vi.fn().mockResolvedValue({}) },
  },
  uid: () => 'id',
  serializeBigInts: (value: unknown) => value,
}));
vi.mock('../apps/api/src/lib/config.js', () => ({
  config: { dockerSocket: '/none', dataRoot: '/tmp', hostDataRoot: '/tmp' },
  runningInContainer: () => false,
}));
vi.mock('../apps/api/src/plugins/auth.js', () => ({
  requireUser: (request: FastifyRequest) => {
    if (!request.headers['x-user']) throw unauthorized();
    return {
      id: request.headers['x-user'],
      role: request.headers['x-role'] || 'user',
      ...(request.headers['x-scopes']
        ? { scopes: String(request.headers['x-scopes']).split(',') }
        : {}),
    };
  },
}));
vi.mock('../apps/api/src/services/connectivity.js', async (original) => ({
  ...(await original<object>()),
  discoverNetwork: async () => state.discovery,
  readPortForwards: async () => state.forwards,
  writeNetworkConfiguration: state.save,
}));
vi.mock('../apps/api/src/services/tailscale.js', () => ({
  tailnetStatus: async () => state.tailscale,
  connectTailscale: state.connect,
  configureTailnetDashboard: state.serve,
}));
vi.mock('../apps/api/src/services/upnp.js', () => ({ reconcilePortMappings: state.reconcile }));
vi.mock('../apps/api/src/runtime/docker.js', () => ({
  DockerRuntime: class {
    status = state.runtimeStatus;
  },
}));
import { connectivityRoutes } from '../apps/api/src/routes/connectivity.js';
import { networkConfigurationSchema } from '../apps/api/src/services/connectivity.js';
let app: FastifyInstance;
const owner = { 'x-user': 'owner', 'x-role': 'owner' };
beforeEach(async () => {
  vi.clearAllMocks();
  state.reconcile.mockResolvedValue(undefined);
  state.save.mockResolvedValue(undefined);
  state.server = {
    id: 'id',
    uid: 'game',
    nodeId: 'local',
    name: 'Friends',
    ownerId: 'owner',
    owner: { passwordHash: 'secret-hash' },
    publicAccess: false,
    state: 'offline',
    gameId: 'minecraft-java',
    variantId: 'paper',
    version: '1.21.4',
    javaMajor: 21,
    memoryMib: 4096,
    cpuCores: 2,
    dataPath: '/tmp/game',
    settings: defaultsFor(getAdapter('minecraft-java').settingsSchema('paper')),
    environment: {},
    javaFlagsPreset: 'balanced',
    node: { transport: 'docker', publicHost: null },
    allocations: [
      { ip: '0.0.0.0', port: 25565, purpose: 'game', primary: true },
      { ip: '0.0.0.0', port: 25566, purpose: 'rcon' },
    ],
    subusers: [
      { userId: 'viewer', permissions: ['server.view'], roles: [] },
      { userId: 'settings-only', permissions: ['server.view', 'server.settings'], roles: [] },
    ],
  } as unknown as ServerWithAccess;
  state.discovery = {
    settings: networkConfigurationSchema.parse({ upnpEnabled: true }),
    host: { checkedAt: new Date().toISOString() },
    lanHost: '192.168.1.20',
    publicIp: '8.8.4.4',
    externalIp: '8.8.4.4',
    gateway: {
      controlUrl: 'http://192.168.1.1/control',
      serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
    },
    routerError: null,
    checkedAt: new Date().toISOString(),
  } as Awaited<ReturnType<typeof discoverNetwork>>;
  state.tailscale = {
    mode: 'host',
    available: true,
    serving: true,
    state: 'Running',
    ip: '100.80.1.20',
    dashboardUrl: 'https://host.example.ts.net',
    loginUrl: 'https://login.tailscale.com/secret-auth',
  } as TailnetStatus;
  state.forwards = [
    {
      serverUid: 'game',
      port: 25565,
      protocol: 'TCP',
      state: 'active',
      verifiedAt: new Date().toISOString(),
      error: null,
      controlUrl: 'private-router-url',
    },
  ] as PortForward[];
  app = Fastify();
  app.setErrorHandler((error, request, reply) =>
    reply
      .code(isAppError(error) ? error.status : error.name === 'ZodError' ? 400 : 500)
      .send({ error: { message: error.message } }),
  );
  await app.register(connectivityRoutes);
});
afterEach(async () => app.close());
describe('network access permissions and sharing', () => {
  it('limits panel network reports and actions to unscoped administrators', async () => {
    expect((await app.inject('/network')).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/network', headers: { 'x-user': 'viewer' } })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: '/network', headers: { ...owner, 'x-scopes': 'server.view' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: '/network', headers: { ...owner, 'x-scopes': '*' } })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/network/tailscale/connect',
          headers: { 'x-user': 'viewer' },
        })
      ).statusCode,
    ).toBe(403);
    expect(state.connect).not.toHaveBeenCalled();
  });
  it('shares local, public, and host-tailnet addresses without admin configuration or secrets', async () => {
    const response = await app.inject({
      url: '/servers/game/connections',
      headers: { 'x-user': 'viewer' },
    });
    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .addresses.map((address: ServerConnections['addresses'][number]) => address.address),
    ).toEqual(['192.168.1.20:25565', '8.8.4.4:25565', '100.80.1.20:25565']);
    expect(response.json()).toMatchObject({
      canManage: false,
      canConfigureNetwork: false,
      ports: [{ port: 25565, protocol: 'TCP', purpose: 'game' }],
    });
    for (const secret of ['secret-hash', 'private-router-url', 'secret-auth', '25566'])
      expect(response.body).not.toContain(secret);
  });
  it('never advertises a dashboard sidecar as a game tunnel', async () => {
    state.tailscale.mode = 'sidecar';
    const response = await app.inject({ url: '/servers/game/connections', headers: owner });
    expect(response.json().addresses[2].address).toBeNull();
    expect(response.json().addresses[2].note).toContain('dashboard traffic only');
  });
  it('requires both settings and power access to expose a game', async () => {
    for (const user of ['viewer', 'settings-only'])
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/servers/game/connections',
            headers: { 'x-user': user },
            payload: { publicAccess: true },
          })
        ).statusCode,
      ).toBe(404);
    expect(state.server.publicAccess).toBe(false);
  });
  it('does not let a scoped owner bypass required permissions', async () => {
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/servers/game/connections',
          headers: { ...owner, 'x-scopes': 'server.settings' },
          payload: { publicAccess: true },
        })
      ).statusCode,
    ).toBe(404);
  });
  it('enables explicit game access only after the global switch and reconciles asynchronously', async () => {
    state.discovery.settings.upnpEnabled = false;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/servers/game/connections',
          headers: owner,
          payload: { publicAccess: true },
        })
      ).statusCode,
    ).toBe(400);
    state.discovery.settings.upnpEnabled = true;
    const response = await app.inject({
      method: 'PATCH',
      url: '/servers/game/connections',
      headers: owner,
      payload: { publicAccess: true },
    });
    expect(response.statusCode).toBe(200);
    expect(state.server.publicAccess).toBe(true);
    expect(state.reconcile).toHaveBeenCalledWith(true);
  });
  it('allows disabling an existing opt-in even after the global switch is off', async () => {
    state.discovery.settings.upnpEnabled = false;
    state.server.publicAccess = true;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/servers/game/connections',
          headers: owner,
          payload: { publicAccess: false },
        })
      ).statusCode,
    ).toBe(200);
    expect(state.server.publicAccess).toBe(false);
  });
  it('flags upstream NAT and does not describe a router rule as verified internet reachability', async () => {
    state.discovery.externalIp = '100.80.0.1';
    const response = await app.inject({ url: '/network', headers: owner });
    expect(response.json().router.behindNat).toBe(true);
    const share = await app.inject({ url: '/servers/game/connections', headers: owner });
    expect(share.json().addresses[1].note).toContain('another NAT');
  });
  it('generates a private uncached QR code for the chosen address', async () => {
    const response = await app.inject({
      url: '/servers/game/connections/qr?kind=local',
      headers: owner,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/svg+xml');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toContain('<svg');
  });
  it('rejects unsafe router and Tailscale configuration before saving', async () => {
    for (const payload of [
      { routerUrl: 'http://localhost/admin' },
      { tailscaleUrl: 'https://evil.example' },
      { publicHost: 'example.com:25565' },
      { leaseSeconds: 1 },
    ])
      expect(
        (await app.inject({ method: 'PUT', url: '/network', headers: owner, payload })).statusCode,
      ).toBe(400);
    expect(state.save).not.toHaveBeenCalled();
  });
  it('keeps running game ports unchanged', async () => {
    state.server.state = 'running';
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/servers/game/connections/port',
          headers: owner,
          payload: { port: 25570 },
        })
      ).statusCode,
    ).toBe(409);
  });
});
