import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { config } from '../config.js';
import {
  describeGateway,
  discoverGateway,
  gatewayFromControlUrl,
  gatewayHost,
  getExternalIp,
  localAddressFor,
} from '../lib/igd.js';

/**
 * Answers the only networking question a new user actually has:
 * *who will be able to join, and what address do I give them?*
 *
 * Everything here is detection. Nothing is changed, and nothing is sent
 * off-machine: the public address comes from asking the router over the LAN,
 * not from an external "what is my IP" service, so running the wizard does not
 * disclose the panel's existence to anybody.
 */

export type Reachability = 'public' | 'cgnat' | 'private' | 'unknown';

export interface VpnInterface {
  /** Interface name, e.g. tailscale0. */
  name: string;
  address: string;
  /** Recognised product, for wording the option in the UI. */
  kind: 'tailscale' | 'wireguard' | 'zerotier' | 'other';
}

export interface NetworkReport {
  lanIp: string | null;
  vpn: VpnInterface[];
  router: {
    /** True when a UPnP gateway answered — i.e. forwarding can be automatic. */
    available: boolean;
    externalIp: string | null;
    controlUrl: string | null;
  };
  /** What the external address means for inbound connections. */
  reachability: Reachability;
  forwardingEnabled: boolean;
  publicHost: string | null;
  gamePorts: number[];
  /**
   * True when the panel is itself containerised.
   *
   * Changes the meaning of `router.available: false` entirely: from inside a
   * container, SSDP multicast never reaches the LAN, so the router is not
   * missing — it is merely invisible from here. Without this the wizard would
   * tell someone their router does not support automatic setup when it does.
   */
  inContainer: boolean;
}

export function detectContainer(): boolean {
  if (existsSync('/.dockerenv')) return true;
  try {
    return /docker|containerd|kubepods|libpod/.test(readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Classifies an external address.
 *
 * The distinction that matters is carrier-grade NAT: an ISP that hands out
 * 100.64.0.0/10 has put thousands of customers behind one real address, and no
 * amount of port forwarding will make an inbound connection arrive. Telling
 * someone that up front saves an evening of blaming their router.
 */
export function classifyAddress(ip: string | null): Reachability {
  if (!ip) return 'unknown';
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return 'unknown';
  }
  const [a, b] = parts as [number, number, number, number];

  // RFC 6598, the shared address space ISPs use for CGNAT.
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';

  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 127 || a === 0) return 'private';
  // 169.254 — the router has no upstream lease at all.
  if (a === 169 && b === 254) return 'private';

  return 'public';
}

function vpnKind(name: string): VpnInterface['kind'] | null {
  if (/^tailscale/i.test(name)) return 'tailscale';
  if (/^(wg|wireguard)/i.test(name)) return 'wireguard';
  if (/^zt/i.test(name)) return 'zerotier';
  if (/^(tun|utun)/i.test(name)) return 'other';
  return null;
}

/** Interfaces that are never the address a player should be given. */
function isLocalOnly(name: string): boolean {
  return /^(lo|docker|br-|veth|virbr)/i.test(name);
}

export function readInterfaces(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): {
  lanIp: string | null;
  vpn: VpnInterface[];
} {
  const vpn: VpnInterface[] = [];
  let lanIp: string | null = null;

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const entry of addresses ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;

      const kind = vpnKind(name);
      if (kind) {
        vpn.push({ name, address: entry.address, kind });
        continue;
      }

      // Docker bridges are real, non-internal IPv4 addresses that no player can
      // ever reach; without this the wizard would confidently offer 172.17.0.1.
      if (isLocalOnly(name)) continue;
      lanIp ??= entry.address;
    }
  }

  return { lanIp, vpn };
}

async function resolveRouter(): Promise<NetworkReport['router'] & { lanIp: string | null }> {
  const gateway = config.UPNP_CONTROL_URL
    ? config.UPNP_CONTROL_URL.endsWith('.xml')
      ? await describeGateway(config.UPNP_CONTROL_URL).catch(() => null)
      : gatewayFromControlUrl(config.UPNP_CONTROL_URL)
    : await discoverGateway().catch(() => null);

  if (!gateway) return { available: false, externalIp: null, controlUrl: null, lanIp: null };

  const externalIp = await getExternalIp(gateway).catch(() => null);
  // The address the router would forward to is more trustworthy than picking
  // an interface, because it is the one the kernel actually routes through.
  const lanIp = await localAddressFor(gatewayHost(gateway)).catch(() => null);

  return { available: true, externalIp, controlUrl: gateway.controlUrl, lanIp };
}

export async function inspectNetwork(): Promise<NetworkReport> {
  const { prisma } = await import('@serverforge/db');
  const { getSetting, NETWORK_FORWARDING } = await import('../lib/settings.js');

  const [router, node, allocations] = await Promise.all([
    resolveRouter(),
    prisma.node.findFirst({ select: { publicHost: true } }),
    prisma.allocation.findMany({ where: { purpose: 'game' }, select: { port: true } }),
  ]);

  const fromInterfaces = readInterfaces(os.networkInterfaces());
  const forwardingEnabled = await getSetting<boolean | null>(NETWORK_FORWARDING, null);

  return {
    lanIp: router.lanIp ?? fromInterfaces.lanIp,
    vpn: fromInterfaces.vpn,
    router: { available: router.available, externalIp: router.externalIp, controlUrl: router.controlUrl },
    reachability: classifyAddress(router.externalIp),
    forwardingEnabled: forwardingEnabled ?? config.upnpEnabled,
    publicHost: node?.publicHost ?? null,
    gamePorts: allocations.map((allocation) => allocation.port).sort((a, b) => a - b),
    inContainer: detectContainer(),
  };
}

export type ReachMode = 'lan' | 'vpn' | 'public';

export interface NetworkChoice {
  mode: ReachMode;
  /** Explicit address or hostname. Required for 'public' with a custom name. */
  host?: string;
}

/**
 * Turns a wizard answer into the two values that get written.
 *
 * Pure, so the rule that forwarding is only ever enabled for a deliberate
 * 'public' choice is testable without a router, a database or a browser. That
 * rule is the whole safety story of the wizard: picking "just my network"
 * must never open anything.
 */
export function resolveNetworkChoice(
  choice: NetworkChoice,
  report: Pick<NetworkReport, 'lanIp' | 'vpn' | 'router'>,
): { publicHost: string | null; forwarding: boolean; error?: string } {
  if (choice.mode === 'lan') {
    const host = choice.host?.trim() || report.lanIp;
    if (!host) return { publicHost: null, forwarding: false, error: 'No local network address was detected.' };
    return { publicHost: host, forwarding: false };
  }

  if (choice.mode === 'vpn') {
    const host = choice.host?.trim() || report.vpn[0]?.address;
    if (!host) return { publicHost: null, forwarding: false, error: 'No VPN interface was detected.' };
    return { publicHost: host, forwarding: false };
  }

  const host = choice.host?.trim() || report.router.externalIp;
  if (!host) {
    return {
      publicHost: null,
      forwarding: false,
      error: 'No public address was detected. Enter a hostname instead.',
    };
  }

  // Forwarding is only automatic when the router actually speaks UPnP. With a
  // manually forwarded port the address is still correct, so this succeeds
  // either way rather than refusing the whole choice.
  return { publicHost: host, forwarding: report.router.available };
}
