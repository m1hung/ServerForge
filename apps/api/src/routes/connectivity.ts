import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import QRCode from 'qrcode';
import { badRequest, forbidden, conflict, canAccessServer } from '@serverforge/core';
import {
  formatJoinAddress,
  type NetworkReport,
  type ServerConnections,
} from '@serverforge/core/connectivity';
import { prisma } from '@serverforge/db';
import { getAdapter } from '@serverforge/adapters';
import { requireUser } from '../plugins/auth.js';
import { loadServer, contextOf, accessInput, runtime } from './servers.js';
import {
  discoverNetwork,
  networkConfigurationSchema,
  readPortForwards,
  writeNetworkConfiguration,
} from '../services/connectivity.js';
import { classifyAddress } from '../services/network.js';
import { withServerLock } from '../services/server-lock.js';
import { allocateServerPorts } from '../services/port-allocation.js';
import { forwardablePorts } from '../services/ports.js';
import {
  tailnetStatus,
  connectTailscale,
  configureTailnetDashboard,
} from '../services/tailscale.js';
import { reconcilePortMappings } from '../services/upnp.js';
import { logger } from '../lib/logger.js';
import { activity } from '../services/server-events.js';

function admin(request: FastifyRequest) {
  const user = requireUser(request);
  if (!['owner', 'admin'].includes(user.role) || (user.scopes && !user.scopes.includes('*')))
    throw forbidden('Only workspace administrators can change network access.');
  return user;
}
function serverUid(request: FastifyRequest) {
  return z.object({ uid: z.string().min(1).max(64) }).parse(request.params).uid;
}
function reconcile() {
  void reconcilePortMappings(true).catch((error) =>
    logger.warn('network reconciliation failed', {
      message: error instanceof Error ? error.message : 'Router unavailable.',
    }),
  );
}
export async function networkReport(force = false): Promise<NetworkReport> {
  const discovery = await discoverNetwork(force);
  const [tailscale, forwards, servers] = await Promise.all([
    tailnetStatus(discovery.settings, discovery.host, force),
    readPortForwards(),
    prisma.server.findMany({
      select: { uid: true, name: true, state: true, publicAccess: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  return {
    configuration: discovery.settings,
    checkedAt: discovery.checkedAt,
    hostDetectedAt: discovery.host?.checkedAt ?? null,
    lanHost: discovery.lanHost,
    publicHost: discovery.settings.publicHost || discovery.publicIp,
    publicIp: discovery.publicIp,
    router: {
      available: !!discovery.gateway && !discovery.routerError,
      controlUrl: discovery.gateway?.controlUrl ?? null,
      serviceType: discovery.gateway?.serviceType ?? null,
      externalIp: discovery.externalIp,
      issue: discovery.routerError,
      behindNat: !!discovery.externalIp && classifyAddress(discovery.externalIp) !== 'public',
    },
    tailscale,
    forwards,
    servers,
  };
}
async function serverConnections(request: FastifyRequest): Promise<ServerConnections> {
  const user = requireUser(request);
  const server = await loadServer(serverUid(request), user);
  const [discovery, forwards] = await Promise.all([discoverNetwork(), readPortForwards()]);
  const tailnet = await tailnetStatus(discovery.settings, discovery.host);
  const plan = getAdapter(server.gameId).startup(contextOf(server));
  const bindings = forwardablePorts(plan.ports, server.allocations);
  const ports = bindings.map((binding) => ({
    port: binding.hostPort,
    protocol: binding.protocol.toUpperCase(),
    purpose: server.allocations.find((a) => a.port === binding.hostPort)?.purpose ?? 'game',
  }));
  const game =
    server.allocations.find((a) => a.primary) ??
    server.allocations.find((a) => a.purpose === 'game');
  const local = server.node.transport === 'docker';
  const localHost = local ? discovery.lanHost : null;
  const publicHost = local
    ? discovery.settings.publicHost || discovery.publicIp
    : server.node.publicHost;
  const vpnHost = local && tailnet.mode === 'host' ? tailnet.ip : null;
  const address = (host: string | null) =>
    host && game ? formatJoinAddress(host, game.port) : null;
  const has = (permission: 'server.settings' | 'server.power') =>
    canAccessServer(accessInput(user, server), permission) &&
    (!user.scopes || user.scopes.includes('*') || user.scopes.includes(permission));
  const lanBound = !!game && (game.ip === '0.0.0.0' || game.ip === localHost);
  return {
    checkedAt: discovery.checkedAt,
    publicAccess: server.publicAccess,
    upnpEnabled: discovery.settings.upnpEnabled,
    canManage: has('server.settings') && has('server.power'),
    canConfigureNetwork:
      ['owner', 'admin'].includes(user.role) && (!user.scopes || user.scopes.includes('*')),
    ports,
    addresses: [
      {
        kind: 'local',
        label: 'Local network',
        host: lanBound ? localHost : null,
        address: lanBound ? address(localHost) : null,
        note: lanBound
          ? 'For players on the same Wi-Fi or wired network. Allow the game ports through the host firewall.'
          : 'Set the host LAN address in Network & access and bind the game port to that interface or 0.0.0.0.',
      },
      {
        kind: 'public',
        label: 'Public internet',
        host: publicHost,
        address: address(publicHost),
        note:
          discovery.externalIp && classifyAddress(discovery.externalIp) !== 'public'
            ? 'Your router is behind another NAT. A router rule alone will not make this address reachable. Use host Tailscale or arrange a public IP with your ISP.'
            : 'Requires every listed port to reach this host through the router and firewall. An address or UPnP rule does not verify internet reachability.',
      },
      {
        kind: 'tailscale',
        label: 'Tailscale',
        host: vpnHost,
        address: address(vpnHost),
        note: vpnHost
          ? 'Players must join your tailnet or have this host shared with them. Tailscale access rules must allow the game ports.'
          : 'Game access needs Tailscale installed on the game host. The dashboard’s container connection carries dashboard traffic only.',
      },
    ],
    forwards: forwards
      .filter((row) => row.serverUid === server.uid)
      .map(({ port, protocol, state, verifiedAt, error }) => ({
        port,
        protocol,
        state,
        verifiedAt,
        error,
      })),
  };
}
export async function connectivityRoutes(app: FastifyInstance) {
  app.get('/network', async (request) => {
    admin(request);
    return networkReport();
  });
  app.post('/network/refresh', async (request) => {
    admin(request);
    const report = await networkReport(true);
    reconcile();
    return report;
  });
  app.put('/network', async (request) => {
    admin(request);
    await writeNetworkConfiguration(networkConfigurationSchema.parse(request.body));
    reconcile();
    return networkReport(true);
  });
  app.post('/network/tailscale/connect', async (request) => {
    admin(request);
    return { tailscale: await connectTailscale() };
  });
  app.post('/network/tailscale/serve', async (request) => {
    admin(request);
    const body = z.object({ enabled: z.boolean() }).parse(request.body);
    return { tailscale: await configureTailnetDashboard(body.enabled) };
  });
  app.get('/servers/:uid/connections', serverConnections);
  app.patch('/servers/:uid/connections', async (request) => {
    const user = requireUser(request),
      id = serverUid(request);
    const server = await loadServer(id, user, 'server.settings');
    await loadServer(id, user, 'server.power');
    const { publicAccess } = z.object({ publicAccess: z.boolean() }).parse(request.body);
    const discovery = await discoverNetwork();
    if (publicAccess && !discovery.settings.upnpEnabled)
      throw badRequest('A workspace administrator must enable UPnP in Network & access first.');
    if (publicAccess && server.node.transport !== 'docker')
      throw badRequest('Automatic router forwarding is available for games on this host.');
    await prisma.server.update({ where: { id: server.id }, data: { publicAccess } });
    await activity(
      server.id,
      'network.access',
      publicAccess
        ? 'Automatic public game access enabled.'
        : 'Automatic public game access disabled.',
      user.id,
    );
    reconcile();
    return serverConnections(request);
  });
  app.put('/servers/:uid/connections/port', async (request) => {
    const user = requireUser(request),
      id = serverUid(request);
    const body = z.object({ port: z.number().int().min(1024).max(65535) }).parse(request.body);
    return withServerLock(id, async () => {
      const server = await loadServer(id, user, 'server.settings');
      await loadServer(id, user, 'server.power');
      if (
        !['offline', 'crashed'].includes(server.state) ||
        (server.containerId && (await runtime.status(server.containerId)).running)
      )
        throw conflict('Stop the server before changing its game port.');
      const purposes = getAdapter(server.gameId).requiredPorts(server.variantId);
      await prisma.$transaction((tx) =>
        allocateServerPorts(tx, server.nodeId, server.id, purposes, body.port),
      );
      await activity(server.id, 'network.port', `Game port changed to ${body.port}.`, user.id);
      reconcile();
      return serverConnections(request);
    });
  });
  app.get('/servers/:uid/connections/qr', async (request, reply) => {
    const { kind } = z
      .object({ kind: z.enum(['local', 'public', 'tailscale']) })
      .parse(request.query);
    const connections = await serverConnections(request),
      selected = connections.addresses.find((row) => row.kind === kind);
    if (!selected?.address) throw badRequest('This connection address is not available yet.');
    const svg = await QRCode.toString(selected.address, { type: 'svg', margin: 2, width: 200 });
    return reply.header('Cache-Control', 'private, no-store').type('image/svg+xml').send(svg);
  });
}
