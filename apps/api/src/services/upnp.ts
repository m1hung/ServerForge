import type { PortForward } from '@serverforge/core/connectivity';
import type { ServerEvent } from '@serverforge/core';
import { prisma } from '@serverforge/db';
import { getAdapter } from '@serverforge/adapters';
import {
  addPortMapping,
  deletePortMapping,
  getPortMapping,
  type ExistingMapping,
} from '../lib/igd.js';
import { runtime, contextOf } from '../routes/servers.js';
import { forwardablePorts } from './ports.js';
import {
  discoverNetwork,
  readNetworkConfiguration,
  readPortForwards,
  writePortForwards,
  validLanHost,
} from './connectivity.js';
import { activity, serverEvents } from './server-events.js';
import { logger } from '../lib/logger.js';

const key = (row: PortForward) =>
  `${row.controlUrl}|${row.protocol}|${row.port}|${row.internalHost}`;
export function ownsMapping(row: PortForward, existing: ExistingMapping | null) {
  return (
    !!existing &&
    existing.internalClient === row.internalHost &&
    existing.internalPort === row.port &&
    existing.description === row.description
  );
}

let syncing: Promise<void> | null = null,
  again = false,
  forced = false;
// ponytail: one API worker owns router reconciliation; use distributed locking before API replicas.
export function reconcilePortMappings(force = false): Promise<void> {
  forced ||= force;
  if (syncing) {
    again = true;
    return syncing;
  }
  syncing = (async () => {
    do {
      again = false;
      const check = forced;
      forced = false;
      await reconcile(check);
    } while (again);
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

async function reconcile(force: boolean) {
  const [settings, saved, servers] = await Promise.all([
    readNetworkConfiguration(),
    readPortForwards(),
    prisma.server.findMany({
      include: {
        allocations: true,
        node: true,
        owner: true,
        subusers: { include: { roles: true } },
      },
    }),
  ]);
  const active = settings.upnpEnabled
    ? servers.filter(
        (s) =>
          s.publicAccess &&
          ['running', 'starting'].includes(s.state) &&
          s.containerId &&
          s.node.transport === 'docker',
      )
    : [];
  if (!saved.length && !active.length) return;
  const discovery = active.length ? await discoverNetwork() : null;
  const desired: PortForward[] = [];
  if (
    discovery?.gateway &&
    !discovery.routerError &&
    discovery.lanHost &&
    validLanHost(discovery.lanHost)
  ) {
    for (const server of active) {
      if (!(await runtime.status(server.containerId!)).running) continue;
      const plan = getAdapter(server.gameId).startup(contextOf(server));
      for (const binding of forwardablePorts(plan.ports, server.allocations)) {
        const bound = ['0.0.0.0', discovery.lanHost].includes(binding.hostIp);
        desired.push({
          serverUid: server.uid,
          serverName: server.name,
          port: binding.hostPort,
          protocol: binding.protocol.toUpperCase() as 'TCP' | 'UDP',
          internalHost: discovery.lanHost,
          ...discovery.gateway,
          description: `ServerForge:${server.uid}:${binding.hostPort}:${binding.protocol}`,
          leaseSeconds: settings.leaseSeconds,
          state: bound ? 'pending' : 'error',
          verifiedAt: null,
          error: bound
            ? null
            : 'This game port is not bound to the host LAN interface. Check its allocation.',
        });
      }
    }
  }
  // Keep desired intent during a temporary router outage. Otherwise a failed discovery
  // would unnecessarily remove working leases on a router that still accepts SOAP calls.
  const wanted = new Set(desired.map(key));
  const activeUids = new Set(active.map((s) => s.uid));
  const rows = [...saved];
  for (const row of [...rows]) {
    if (
      wanted.has(key(row)) ||
      ((!discovery?.gateway || discovery.routerError || !discovery.lanHost) &&
        activeUids.has(row.serverUid))
    )
      continue;
    try {
      row.state = 'removing';
      await writePortForwards(rows);
      const existing = await getPortMapping(row, row.port, row.protocol);
      if (ownsMapping(row, existing)) await deletePortMapping(row, row.port, row.protocol);
      rows.splice(rows.indexOf(row), 1);
      await writePortForwards(rows);
    } catch (error) {
      row.error = error instanceof Error ? error.message : 'Could not remove the router rule.';
      await writePortForwards(rows);
    }
  }
  for (const item of desired) {
    let row = rows.find((candidate) => key(candidate) === key(item));
    const priorState = row?.state;
    if (!row) {
      row = item;
      rows.push(row);
      await writePortForwards(rows);
    }
    row.serverName = item.serverName;
    if (item.error) {
      row.state = 'error';
      row.error = item.error;
      await writePortForwards(rows);
      continue;
    }
    const age = Date.now() - Date.parse(row.verifiedAt ?? '');
    const renewAfter = row.leaseSeconds ? Math.min(300000, row.leaseSeconds * 500) : 300000;
    if (!force && row.state === 'active' && Number.isFinite(age) && age < renewAfter) continue;
    try {
      const existing = await getPortMapping(row, row.port, row.protocol);
      if (existing && !ownsMapping(row, existing)) {
        row.state = 'conflict';
        row.error =
          'Another application owns this router port. Choose a different game port or review the rule in your router.';
      } else {
        const lease = await addPortMapping(row, {
          externalPort: row.port,
          internalPort: row.port,
          internalClient: row.internalHost,
          protocol: row.protocol,
          description: row.description,
          leaseSeconds: settings.leaseSeconds,
        });
        const verified = await getPortMapping(row, row.port, row.protocol);
        if (!ownsMapping(row, verified) || !verified?.enabled)
          throw new Error('The router accepted the rule but did not confirm it as active.');
        row.state = 'active';
        row.error = null;
        row.leaseSeconds = lease;
        row.verifiedAt = new Date().toISOString();
      }
    } catch (error) {
      row.state = 'error';
      row.error = error instanceof Error ? error.message : 'Router forwarding failed.';
    }
    await writePortForwards(rows);
    if (row.state !== priorState) {
      const server = servers.find((s) => s.uid === row.serverUid);
      if (server)
        await activity(
          server.id,
          `network.${row.state}`,
          row.error || `Router forwarding active on ${row.port}/${row.protocol}.`,
        ).catch(() => undefined);
    }
  }
}

export function requestPortReconciliation() {
  void reconcilePortMappings().catch((error) =>
    logger.warn('router reconciliation failed', {
      message: error instanceof Error ? error.message : 'Router unavailable.',
    }),
  );
}
export function startNetworkWorker() {
  requestPortReconciliation();
  const timer = setInterval(requestPortReconciliation, 60000);
  timer.unref();
  const listener = (event: ServerEvent) => {
    if (['server.stopped', 'server.crashed', 'server.ready'].includes(event.type))
      requestPortReconciliation();
  };
  serverEvents.on('server', listener);
  return () => {
    clearInterval(timer);
    serverEvents.off('server', listener);
  };
}
