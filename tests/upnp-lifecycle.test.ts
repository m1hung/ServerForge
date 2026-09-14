import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortForward } from '../packages/core/src/connectivity.js';
const state = vi.hoisted(() => ({
  rows: [] as PortForward[],
  settings: { upnpEnabled: true, leaseSeconds: 3600 },
  servers: [] as {
    id: string;
    uid: string;
    name: string;
    publicAccess: boolean;
    state: string;
    containerId: string;
    node: { transport: string };
    allocations: { ip: string; port: number; purpose: string };
  }[],
  discovery: {} as {
    gateway: { controlUrl: string; serviceType: string };
    routerError: string | null;
    lanHost: string;
  },
  status: vi.fn(),
  get: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@serverforge/db', () => ({ prisma: { server: { findMany: async () => state.servers } } }));
vi.mock('@serverforge/adapters', () => ({
  getAdapter: () => ({
    startup: () => ({
      ports: [
        { containerPort: 25565, purpose: 'game', protocol: 'tcp' },
        { containerPort: 25575, purpose: 'rcon', protocol: 'tcp' },
      ],
    }),
  }),
}));
vi.mock('../apps/api/src/routes/servers.js', () => ({
  runtime: { status: state.status },
  contextOf: (server: unknown) => server,
}));
vi.mock('../apps/api/src/lib/igd.js', () => ({
  addPortMapping: state.add,
  deletePortMapping: state.remove,
  getPortMapping: state.get,
}));
vi.mock('../apps/api/src/services/server-events.js', async () => {
  const { EventEmitter } = await import('node:events');
  return { activity: vi.fn().mockResolvedValue(undefined), serverEvents: new EventEmitter() };
});
vi.mock('../apps/api/src/services/connectivity.js', () => ({
  readNetworkConfiguration: async () => state.settings,
  readPortForwards: async () => structuredClone(state.rows),
  writePortForwards: async (rows: PortForward[]) => {
    state.rows = structuredClone(rows);
  },
  discoverNetwork: async () => state.discovery,
  validLanHost: () => true,
}));
import { reconcilePortMappings } from '../apps/api/src/services/upnp.js';
const row: PortForward = {
  serverUid: 'game',
  serverName: 'Friends',
  port: 25565,
  protocol: 'TCP',
  internalHost: '192.168.1.20',
  controlUrl: 'http://192.168.1.1/control',
  serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
  description: 'ServerForge:game:25565:tcp',
  leaseSeconds: 3600,
  state: 'active',
  verifiedAt: new Date().toISOString(),
  error: null,
};
const owned = {
  internalClient: row.internalHost,
  internalPort: row.port,
  description: row.description,
  enabled: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
  state.settings = { upnpEnabled: true, leaseSeconds: 3600 };
  state.servers = [
    {
      id: 'id',
      uid: 'game',
      name: 'Friends',
      publicAccess: true,
      state: 'running',
      containerId: 'container',
      node: { transport: 'docker' },
      allocations: [
        { ip: row.internalHost, port: 25565, purpose: 'game' },
        { ip: '0.0.0.0', port: 25575, purpose: 'rcon' },
      ],
    },
  ];
  state.discovery = {
    gateway: { controlUrl: row.controlUrl, serviceType: row.serviceType },
    routerError: null,
    lanHost: row.internalHost,
  };
  state.status.mockResolvedValue({ running: true });
  state.add.mockResolvedValue(3600);
  state.remove.mockResolvedValue(undefined);
  state.get.mockResolvedValue(owned);
});
describe('router rule lifecycle', () => {
  it('requires both panel and server opt-in before opening a port', async () => {
    state.settings.upnpEnabled = false;
    await reconcilePortMappings(true);
    state.settings.upnpEnabled = true;
    state.servers[0].publicAccess = false;
    await reconcilePortMappings(true);
    expect(state.add).not.toHaveBeenCalled();
    expect(state.rows).toEqual([]);
  });
  it('persists intent before adding and confirms ownership after the router accepts', async () => {
    state.get.mockResolvedValueOnce(null).mockResolvedValueOnce(owned);
    state.add.mockImplementationOnce(async () => {
      expect(state.rows[0]?.state).toBe('pending');
      return 3600;
    });
    await reconcilePortMappings(true);
    expect(state.rows[0]?.state).toBe('active');
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add.mock.calls[0]![1].externalPort).toBe(25565);
  });
  it('does not overwrite another application or open RCON', async () => {
    state.get.mockResolvedValue({ ...owned, description: 'Other app' });
    await reconcilePortMappings(true);
    expect(state.rows[0]?.state).toBe('conflict');
    expect(state.add).not.toHaveBeenCalled();
    expect(state.rows.map((row) => row.port)).not.toContain(25575);
  });
  it('never assumes failed ownership queries mean a free port', async () => {
    state.get.mockRejectedValue(new Error('Unsupported action'));
    await reconcilePortMappings(true);
    expect(state.rows[0]?.state).toBe('error');
    expect(state.add).not.toHaveBeenCalled();
  });
  it('removes only owned mappings when a server stops or opts out', async () => {
    state.rows = [{ ...row }];
    state.servers[0].state = 'offline';
    await reconcilePortMappings();
    expect(state.remove).toHaveBeenCalledWith(
      expect.objectContaining({ port: 25565 }),
      25565,
      'TCP',
    );
    expect(state.rows).toEqual([]);
  });
  it('forgets a replaced mapping without deleting its new owner', async () => {
    state.rows = [{ ...row }];
    state.servers = [];
    state.get.mockResolvedValue({ ...owned, internalClient: '192.168.1.90' });
    await reconcilePortMappings();
    expect(state.remove).not.toHaveBeenCalled();
    expect(state.rows).toEqual([]);
  });
  it('keeps cleanup intent when an unavailable router prevents deletion', async () => {
    state.rows = [{ ...row }];
    state.settings.upnpEnabled = false;
    state.get.mockRejectedValue(new Error('Router offline'));
    await reconcilePortMappings();
    expect(state.rows[0]).toMatchObject({ state: 'removing', error: 'Router offline' });
  });
  it('preserves live rules during discovery or external-IP failures', async () => {
    state.rows = [{ ...row }];
    state.discovery.routerError = 'Router timeout';
    await reconcilePortMappings(true);
    expect(state.rows[0]?.state).toBe('active');
    expect(state.get).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });
  it('cleans up a crashed container even before its stale database state catches up', async () => {
    state.rows = [{ ...row }];
    state.status.mockResolvedValue({ running: false });
    await reconcilePortMappings();
    expect(state.rows).toEqual([]);
    expect(state.remove).toHaveBeenCalledTimes(1);
  });
  it('recovers saved intent after an API restart and recreates rules lost by a router reboot', async () => {
    state.rows = [{ ...row, state: 'pending' }];
    state.get.mockResolvedValueOnce(null).mockResolvedValueOnce(owned);
    await reconcilePortMappings();
    expect(state.rows[0]?.state).toBe('active');
    expect(state.add).toHaveBeenCalledTimes(1);
  });
  it('does not repeatedly renew permanent leases returned by permanent-only routers', async () => {
    state.rows = [{ ...row, leaseSeconds: 0, verifiedAt: new Date().toISOString() }];
    await reconcilePortMappings();
    expect(state.add).not.toHaveBeenCalled();
  });
  it('marks unverified router acknowledgments as errors', async () => {
    state.get.mockResolvedValue(null);
    await reconcilePortMappings(true);
    expect(state.rows[0]?.state).toBe('error');
  });
});
