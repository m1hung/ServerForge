import { brand } from '@serverforge/core';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import {
  addPortMapping,
  deletePortMapping,
  describeGateway,
  discoverGateway,
  gatewayFromControlUrl,
  gatewayHost,
  getPortMapping,
  IGD_CONFLICT,
  IgdError,
  localAddressFor,
  type Gateway,
} from '../lib/igd.js';
import { getSetting, NETWORK_FORWARDING } from '../lib/settings.js';
import { detectContainer } from './network.js';
import type { PortBinding } from './ports.js';

/**
 * Automatic router port forwarding.
 *
 * Two rules govern everything here.
 *
 * **Only the game port is ever forwarded.** An adapter declares several ports
 * per server — game, rcon, query — and they are not equivalent. rcon is a
 * remote console: forwarding it publishes an unauthenticated-until-you-guess
 * command channel to the internet. This module filters on `purpose === 'game'`
 * and there is no configuration option to widen that.
 *
 * **Failure never blocks a server.** A router that refuses, times out or lies
 * produces a warning and nothing else. The alternative — a server that will
 * not start because the router is grumpy — is worse than a server nobody
 * outside the LAN can reach.
 *
 * Mappings are held open by re-assertion on a timer rather than by lease
 * duration, because the failure mode that actually happens on a home network
 * is the router rebooting and forgetting everything, which no lease survives.
 */

/** Re-assert every mapping this often. Cheap, and idempotent on every router. */
const RENEW_INTERVAL_MS = 15 * 60 * 1000;

interface Desired {
  serverUid: string;
  externalPort: number;
  internalPort: number;
  protocol: 'TCP' | 'UDP';
}

/**
 * What *should* be mapped right now, keyed by port+protocol.
 *
 * The router is the source of truth for what *is* mapped; this is the intent
 * we keep re-asserting against it.
 */
const desired = new Map<string, Desired>();

let cachedGateway: Gateway | null = null;
let renewTimer: NodeJS.Timeout | null = null;

const key = (port: number, protocol: string) => `${protocol}:${port}`;

/**
 * Whether forwarding is on.
 *
 * The stored setting wins because the setup wizard writes it, and someone who
 * clicked "just my network" in the dashboard should not have that silently
 * overridden by an environment variable they have never seen. `UPNP_ENABLED`
 * remains the default for a deployment that has never run the wizard.
 */
async function forwardingEnabled(): Promise<boolean> {
  const stored = await getSetting<boolean | null>(NETWORK_FORWARDING, null);
  return stored ?? config.upnpEnabled;
}

/**
 * Bindings to router mappings. The caller is responsible for having filtered
 * these through `forwardablePorts` — that is where the game-only rule lives.
 */
function toDesired(serverUid: string, bindings: PortBinding[]): Desired[] {
  return bindings.map((binding) => ({
    serverUid,
    externalPort: binding.hostPort,
    internalPort: binding.hostPort,
    protocol: binding.protocol.toUpperCase() as 'TCP' | 'UDP',
  }));
}

async function resolveGateway(): Promise<Gateway | null> {
  if (cachedGateway) return cachedGateway;

  if (config.UPNP_CONTROL_URL) {
    // Accept either a control URL or a device-description URL: telling them
    // apart by eye is not something anyone should have to do.
    const configured = config.UPNP_CONTROL_URL;
    cachedGateway = configured.endsWith('.xml')
      ? await describeGateway(configured).catch(() => null)
      : gatewayFromControlUrl(configured);

    if (!cachedGateway) {
      logger.warn({ url: configured }, 'UPNP_CONTROL_URL did not describe a WAN connection service');
    }
    return cachedGateway;
  }

  cachedGateway = await discoverGateway().catch(() => null);
  if (!cachedGateway) {
    logger.warn(
      'UPnP is enabled but no gateway answered. If the API runs in a container, ' +
        'set UPNP_CONTROL_URL — SSDP discovery cannot cross the Docker bridge.',
    );
  }
  return cachedGateway;
}

/**
 * The LAN address the router should forward to.
 *
 * Auto-detection asks the kernel which source address it would use to reach
 * the gateway. Inside a container that answer is the container's own bridge
 * address — 172.17.x.x — which the router cannot route to. The mapping would
 * be accepted and be silently useless, which is worse than not making it, so
 * a containerised panel must be told the host's address explicitly.
 */
async function internalAddress(gateway: Gateway): Promise<string | null> {
  if (config.UPNP_INTERNAL_IP) return config.UPNP_INTERNAL_IP;

  if (detectContainer()) {
    logger.warn(
      'refusing to forward ports to a container address: set UPNP_INTERNAL_IP to ' +
        "this machine's LAN address, or the router would point at an unreachable client",
    );
    return null;
  }

  return localAddressFor(gatewayHost(gateway));
}

/**
 * Applies one mapping.
 *
 * A conflict is the interesting case: the external port is already mapped.
 * If it points at us it is our own mapping from a previous run and the job is
 * already done. If it points somewhere else, another device on the LAN has
 * claimed that port and silently stealing it would break whatever that is —
 * so we log which host holds it and leave it alone.
 */
async function apply(gateway: Gateway, client: string, entry: Desired): Promise<boolean> {
  const description = `${brand.name} ${entry.serverUid}`.slice(0, 64);

  try {
    await addPortMapping(gateway, {
      externalPort: entry.externalPort,
      internalPort: entry.internalPort,
      internalClient: client,
      protocol: entry.protocol,
      description,
      leaseSeconds: config.UPNP_LEASE_SECONDS,
    });
    return true;
  } catch (error) {
    if (error instanceof IgdError && error.code === IGD_CONFLICT) {
      const existing = await getPortMapping(gateway, entry.externalPort, entry.protocol).catch(
        () => null,
      );

      if (existing && existing.internalClient === client && existing.internalPort === entry.internalPort) {
        return true;
      }

      logger.warn(
        {
          port: entry.externalPort,
          protocol: entry.protocol,
          heldBy: existing?.internalClient ?? 'unknown',
          serverUid: entry.serverUid,
        },
        'router port already forwarded to another device — leaving it alone',
      );
      return false;
    }

    logger.warn(
      { error, port: entry.externalPort, protocol: entry.protocol, serverUid: entry.serverUid },
      'could not create router port forward',
    );
    return false;
  }
}

/**
 * Opens the router for a server's game ports.
 *
 * `bindings` must come from `forwardablePorts` — passing raw `mapPorts` output
 * would forward rcon along with the game port.
 */
export async function openGamePorts(serverUid: string, bindings: PortBinding[]): Promise<void> {
  if (!(await forwardingEnabled())) return;

  const entries = toDesired(serverUid, bindings);
  if (entries.length === 0) {
    // Not an error — some games declare no player-facing port to forward —
    // but silence here was one of the reasons a missing forward took so long
    // to explain.
    logger.info({ serverUid }, 'no player-facing port to forward for this server');
    return;
  }

  for (const entry of entries) desired.set(key(entry.externalPort, entry.protocol), entry);

  const gateway = await resolveGateway();
  if (!gateway) return;

  const client = await internalAddress(gateway);
  if (!client) {
    logger.warn('could not determine this machine LAN address — set UPNP_INTERNAL_IP');
    return;
  }

  for (const entry of entries) {
    const ok = await apply(gateway, client, entry);
    if (ok) {
      logger.info(
        { serverUid, port: entry.externalPort, protocol: entry.protocol, client },
        'router port forward active',
      );
    }
  }
}

/**
 * Tears down a set of mappings.
 *
 * Not gated on the enabled flag: this is what runs when forwarding is being
 * turned *off*, and refusing to close ports because forwarding is disabled
 * would leave them open forever.
 */
async function remove(entries: Desired[]): Promise<void> {
  for (const entry of entries) desired.delete(key(entry.externalPort, entry.protocol));
  if (entries.length === 0) return;

  const gateway = await resolveGateway();
  if (!gateway) return;

  for (const entry of entries) {
    await deletePortMapping(gateway, entry.externalPort, entry.protocol)
      .then(() =>
        logger.info(
          { serverUid: entry.serverUid, port: entry.externalPort, protocol: entry.protocol },
          'router port forward removed',
        ),
      )
      .catch((error) =>
        logger.warn(
          { error, port: entry.externalPort, serverUid: entry.serverUid },
          'could not remove router port forward',
        ),
      );
  }
}

/** Closes whatever this module opened for a server. */
export async function closeGamePorts(serverUid: string): Promise<void> {
  await remove([...desired.values()].filter((entry) => entry.serverUid === serverUid));
}

/**
 * Switches forwarding on or off at runtime.
 *
 * Called by the setup wizard so a choice takes effect immediately: turning it
 * on maps the servers that are already running, and turning it off closes what
 * is open rather than waiting for each server to be stopped.
 */
export async function applyForwardingSetting(enabled: boolean): Promise<void> {
  if (!enabled) {
    await remove([...desired.values()]);
    return;
  }

  await adoptRunningServers().catch((error) =>
    logger.warn({ error }, 'UPnP could not adopt running servers'),
  );
  await reassert().catch((error) => logger.warn({ error }, 'UPnP assertion failed'));
}

/**
 * Re-asserts every desired mapping.
 *
 * Runs on a timer and after a router reboot has thrown the table away. The
 * gateway cache is dropped first so a router that came back on a new
 * description URL is rediscovered rather than retried forever.
 */
async function reassert(): Promise<void> {
  // Re-derive intent from the database first, every cycle.
  //
  // The desired-state map is memory, and the only other things that write to
  // it are a server start and this function. A start asks the router in the
  // background, deliberately, so that an uncooperative router cannot fail a
  // start that otherwise worked — but that means a forward lost to a router
  // that was busy, rebooting, or briefly unreachable was never retried by
  // anything. The server ran, the panel looked healthy, and players got a
  // connection timeout with nothing anywhere saying why.
  //
  // Reading the running servers back each time makes the loop self-healing:
  // whatever should be forwarded gets asserted, whether or not the start
  // managed it.
  await adoptRunningServers().catch((error) =>
    logger.warn({ error }, 'could not read running servers while renewing port forwards'),
  );

  if (desired.size === 0) return;

  cachedGateway = null;
  const gateway = await resolveGateway();
  if (!gateway) return;

  const client = await internalAddress(gateway);
  if (!client) return;

  for (const entry of desired.values()) {
    await apply(gateway, client, entry);
  }
}

/**
 * Rebuilds intent from the servers that are actually running.
 *
 * Called at boot — the desired-state map lives in memory, so without this a
 * panel restart would leave running servers unmapped — and again before every
 * renewal, which is what makes a forward that failed at start time recoverable
 * rather than permanent.
 */
async function adoptRunningServers(): Promise<void> {
  // Imported lazily: services/servers.ts imports this module, and a static
  // import here would close the cycle.
  const { prisma } = await import('@serverforge/db');
  const { getAdapter } = await import('@serverforge/adapters');
  const { buildContext } = await import('./servers.js');
  const { forwardablePorts } = await import('./ports.js');

  const running = await prisma.server.findMany({
    where: { state: { in: ['running', 'starting'] } },
    include: { allocations: true, node: true },
  });

  for (const server of running) {
    try {
      const adapter = getAdapter(server.gameId);
      const plan = adapter.startup(buildContext(server as never));

      for (const entry of toDesired(
        server.uid,
        forwardablePorts(plan.ports, server.allocations),
      )) {
        desired.set(key(entry.externalPort, entry.protocol), entry);
      }
    } catch (error) {
      logger.warn({ error, serverUid: server.uid }, 'could not determine game ports for UPnP');
    }
  }
}

export async function startPortForwarding(): Promise<void> {
  if (!(await forwardingEnabled())) return;

  await adoptRunningServers().catch((error) =>
    logger.warn({ error }, 'UPnP could not adopt running servers'),
  );
  await reassert().catch((error) => logger.warn({ error }, 'initial UPnP assertion failed'));

  renewTimer = setInterval(() => {
    void reassert().catch((error) => logger.warn({ error }, 'UPnP renewal failed'));
  }, RENEW_INTERVAL_MS);
  // Never hold the process open just to renew a port mapping.
  renewTimer.unref();
}

export function stopPortForwarding(): void {
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = null;
}

/** Test seam: drops the gateway cache and all intent. */
export function resetPortForwarding(): void {
  desired.clear();
  cachedGateway = null;
}
