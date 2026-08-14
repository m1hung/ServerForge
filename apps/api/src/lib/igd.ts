import dgram from 'node:dgram';
import net from 'node:net';

/**
 * UPnP Internet Gateway Device client.
 *
 * Hand-rolled rather than pulled from npm. The protocol we actually need is
 * four SOAP calls and one multicast probe; the popular packages wrap that in a
 * dependency tree, and this panel already holds the Docker socket — every
 * package added here is a package that inherits that. See the same reasoning
 * in scripts/compose.mjs.
 *
 * Nothing in this module throws for a *network* reason. A router that does not
 * answer, or answers with a fault, is an expected outcome on a home network:
 * callers get null or an IgdError they can log and move past. Failing to open
 * a port must never be the reason a game server refuses to start.
 */

export interface Gateway {
  /** Absolute SOAP control endpoint. */
  controlUrl: string;
  /** urn:schemas-upnp-org:service:WANIPConnection:1 or the PPP variant. */
  serviceType: string;
}

export interface PortMapping {
  externalPort: number;
  internalPort: number;
  internalClient: string;
  protocol: 'TCP' | 'UDP';
  description: string;
  /** Seconds. 0 means permanent — see addPortMapping for why that is default. */
  leaseSeconds?: number;
}

export class IgdError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'IgdError';
  }
}

/** UPnP error codes we can do something intelligent about. */
export const IGD_CONFLICT = 718;
export const IGD_ONLY_PERMANENT_LEASES = 725;

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

/** Both spellings exist in the wild; PPP is common on DSL gateways. */
const WAN_SERVICES = [
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function tag(xml: string, name: string): string | null {
  // Service descriptions are small and machine-generated; a parser dependency
  // buys nothing over a scoped match here.
  const match = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return match?.[1]?.trim() ?? null;
}

/**
 * Finds the gateway by SSDP multicast.
 *
 * Returns null rather than throwing when nothing answers — which is the normal
 * result when UPnP is switched off, or when this process is in a bridged
 * container where multicast never reaches the LAN. That second case is why
 * `gatewayFromControlUrl` exists.
 */
export async function discoverGateway(timeoutMs = 3000): Promise<Gateway | null> {
  const locations = await probe(timeoutMs);

  for (const location of locations) {
    const gateway = await describeGateway(location).catch(() => null);
    if (gateway) return gateway;
  }
  return null;
}

function probe(timeoutMs: number): Promise<string[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const locations = new Set<string>();

    socket.on('message', (buffer) => {
      const location = buffer
        .toString()
        .split('\r\n')
        .find((line) => line.toLowerCase().startsWith('location:'))
        ?.slice('location:'.length)
        .trim();
      if (location) locations.add(location);
    });

    socket.on('error', () => {
      // A bound-socket or permission failure is just "no gateway" to us.
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve([]);
    });

    socket.bind(() => {
      for (const searchTarget of ['urn:schemas-upnp-org:device:InternetGatewayDevice:1']) {
        const message = Buffer.from(
          [
            'M-SEARCH * HTTP/1.1',
            `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
            'MAN: "ssdp:discover"',
            'MX: 2',
            `ST: ${searchTarget}`,
            '',
            '',
          ].join('\r\n'),
        );
        socket.send(message, SSDP_PORT, SSDP_ADDRESS);
      }

      setTimeout(() => {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        resolve([...locations]);
      }, timeoutMs);
    });
  });
}

/**
 * Reads a device description and picks out the WAN connection service.
 *
 * Exported because the control URL can also be configured directly: SSDP is
 * multicast and does not cross Docker's bridge, but the SOAP calls that follow
 * are ordinary unicast HTTP and work fine from inside a container.
 */
export async function describeGateway(location: string): Promise<Gateway | null> {
  const response = await fetch(location, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) return null;
  const xml = await response.text();

  for (const block of xml.match(/<service>[\s\S]*?<\/service>/g) ?? []) {
    const serviceType = tag(block, 'serviceType');
    const controlPath = tag(block, 'controlURL');
    if (!serviceType || !controlPath) continue;
    if (!WAN_SERVICES.includes(serviceType)) continue;

    return { serviceType, controlUrl: new URL(controlPath, location).toString() };
  }
  return null;
}

/** Builds a Gateway from a pre-known control URL, skipping discovery. */
export function gatewayFromControlUrl(controlUrl: string, serviceType?: string): Gateway {
  return { controlUrl, serviceType: serviceType ?? WAN_SERVICES[0]! };
}

const IGD_DESCRIPTION_PATHS = [
  '/IGDdevicedesc_brlan0.xml',
  '/rootDesc.xml',
  '/igddesc.xml',
  '/gatedesc.xml',
  '/description.xml',
];

function tcpOpen(host: string, port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function controlUrlReachable(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    return tcpOpen(parsed.hostname, port, 400);
  } catch {
    return false;
  }
}

/**
 * Finds an IGD on the same host as a configured URL, when that URL's port is dead.
 *
 * Xfinity (and some other consumer gateways) pick a new high port every time
 * UPnP is toggled. SSDP multicast cannot reach the LAN from a bridged
 * container, but a unicast GET to the gateway IP can. Nearby ports are tried
 * first, then the common 49152–49220 range.
 */
export async function discoverGatewayNear(hintUrl: string): Promise<Gateway | null> {
  let host: string;
  let hintPort: number | undefined;
  try {
    const parsed = new URL(hintUrl);
    host = parsed.hostname;
    hintPort = parsed.port ? Number(parsed.port) : undefined;
  } catch {
    return null;
  }

  const ports: number[] = [];
  const seen = new Set<number>();
  const add = (port: number) => {
    if (port < 1 || port > 65535 || seen.has(port)) return;
    seen.add(port);
    ports.push(port);
  };

  if (hintPort) {
    for (const delta of [0, 1, -1, 2, -2, 3, -3, 4, -4, 8, -8]) add(hintPort + delta);
  }
  for (let port = 49152; port <= 49220; port++) add(port);

  const open: number[] = [];
  const batchSize = 20;
  for (let i = 0; i < ports.length; i += batchSize) {
    const batch = ports.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (port) => ({ port, ok: await tcpOpen(host, port) })));
    open.push(...results.filter((row) => row.ok).map((row) => row.port));
  }

  for (const port of open) {
    for (const path of IGD_DESCRIPTION_PATHS) {
      const gateway = await describeGateway(`http://${host}:${port}${path}`).catch(() => null);
      if (gateway) return gateway;
    }
  }
  return null;
}

/**
 * Resolves a configured control or description URL, rediscovering nearby if it
 * no longer answers.
 */
export async function gatewayFromConfiguredUrl(url: string): Promise<Gateway | null> {
  if (url.endsWith('.xml')) {
    const described = await describeGateway(url).catch(() => null);
    if (described) return described;
  } else if (await controlUrlReachable(url)) {
    return gatewayFromControlUrl(url);
  }

  return discoverGatewayNear(url);
}

async function soap(
  gateway: Gateway,
  action: string,
  args: [string, string | number][] = [],
): Promise<string> {
  const body = args
    .map(([key, value]) => `<${key}>${escapeXml(String(value))}</${key}>`)
    .join('');

  const envelope =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"' +
    ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    `<u:${action} xmlns:u="${gateway.serviceType}">${body}</u:${action}>` +
    '</s:Body></s:Envelope>';

  const response = await fetch(gateway.controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${gateway.serviceType}#${action}"`,
    },
    body: envelope,
    signal: AbortSignal.timeout(8000),
  });

  const text = await response.text();
  if (response.ok) return text;

  // A UPnP fault arrives as HTTP 500 with the real reason in the body. The
  // numeric code is the only part worth branching on; the string is vendor
  // prose and differs on every router.
  const code = Number(tag(text, 'errorCode') ?? '0');
  const description = tag(text, 'errorDescription') ?? `HTTP ${response.status}`;
  throw new IgdError(code, `${action} failed: ${description}`);
}

export async function getExternalIp(gateway: Gateway): Promise<string | null> {
  const xml = await soap(gateway, 'GetExternalIPAddress');
  const ip = tag(xml, 'NewExternalIPAddress');
  return ip && net.isIPv4(ip) ? ip : null;
}

export interface ExistingMapping {
  internalClient: string;
  internalPort: number;
  description: string;
  enabled: boolean;
}

/** Returns the mapping currently holding `externalPort`, or null if it is free. */
export async function getPortMapping(
  gateway: Gateway,
  externalPort: number,
  protocol: 'TCP' | 'UDP',
): Promise<ExistingMapping | null> {
  try {
    const xml = await soap(gateway, 'GetSpecificPortMappingEntry', [
      ['NewRemoteHost', ''],
      ['NewExternalPort', externalPort],
      ['NewProtocol', protocol],
    ]);

    return {
      internalClient: tag(xml, 'NewInternalClient') ?? '',
      internalPort: Number(tag(xml, 'NewInternalPort') ?? '0'),
      description: tag(xml, 'NewPortMappingDescription') ?? '',
      enabled: tag(xml, 'NewEnabled') !== '0',
    };
  } catch (error) {
    // "No such entry" is the expected answer for an unmapped port, and every
    // vendor picks its own code for it. Anything that is not a fault — a
    // timeout, a refused connection — is a real problem and propagates.
    if (error instanceof IgdError) return null;
    throw error;
  }
}

/**
 * Creates or replaces a mapping.
 *
 * The default lease is permanent (0). Finite leases sound tidier, but a router
 * that reboots forgets everything either way, and a lease that expires while
 * someone is mid-session drops them with no explanation. Re-asserting on a
 * timer is the mechanism that keeps mappings alive; the lease is not.
 *
 * Argument order is significant: several IGD implementations bind SOAP
 * arguments positionally and reject a correctly-named payload in the wrong
 * sequence.
 */
export async function addPortMapping(gateway: Gateway, mapping: PortMapping): Promise<void> {
  const lease = mapping.leaseSeconds ?? 0;

  const args: [string, string | number][] = [
    ['NewRemoteHost', ''],
    ['NewExternalPort', mapping.externalPort],
    ['NewProtocol', mapping.protocol],
    ['NewInternalPort', mapping.internalPort],
    ['NewInternalClient', mapping.internalClient],
    ['NewEnabled', 1],
    ['NewPortMappingDescription', mapping.description],
    ['NewLeaseDuration', lease],
  ];

  try {
    await soap(gateway, 'AddPortMapping', args);
  } catch (error) {
    // Some gateways only accept permanent leases and say so explicitly.
    if (error instanceof IgdError && error.code === IGD_ONLY_PERMANENT_LEASES && lease !== 0) {
      await soap(gateway, 'AddPortMapping', [...args.slice(0, 7), ['NewLeaseDuration', 0]]);
      return;
    }
    throw error;
  }
}

export async function deletePortMapping(
  gateway: Gateway,
  externalPort: number,
  protocol: 'TCP' | 'UDP',
): Promise<void> {
  await soap(gateway, 'DeletePortMapping', [
    ['NewRemoteHost', ''],
    ['NewExternalPort', externalPort],
    ['NewProtocol', protocol],
  ]);
}

/**
 * The LAN address the router should forward to.
 *
 * Read from a UDP socket "connected" to the gateway — no packet is sent, but
 * the kernel picks the source address it would use, which is exactly the
 * answer we want. Enumerating interfaces instead gets this wrong on any host
 * with Docker bridges, VPN tunnels or multiple NICs, and this machine has all
 * three.
 */
export function localAddressFor(gatewayHost: string): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.on('error', () => {
      socket.close();
      resolve(null);
    });
    try {
      socket.connect(SSDP_PORT, gatewayHost, () => {
        const address = socket.address().address;
        socket.close();
        resolve(net.isIPv4(address) && address !== '0.0.0.0' ? address : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Host portion of a control URL, for localAddressFor. */
export function gatewayHost(gateway: Gateway): string {
  try {
    return new URL(gateway.controlUrl).hostname;
  } catch {
    return '';
  }
}
