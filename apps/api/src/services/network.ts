import os from 'node:os';
import { config } from '../lib/config.js';

export type AddressKind = 'public' | 'private' | 'cgnat' | 'unknown';

export function classifyAddress(address: string | null | undefined): AddressKind {
  if (!address) return 'unknown';
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return 'unknown';
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10 || a === 127 || (a === 192 && b === 168) || (a === 169 && b === 254)) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  return 'public';
}

export function localConnectAddress(
  advertised: string,
  lanIp: string | null | undefined,
  port?: number,
): string | null {
  if (!lanIp || !port) return null;
  if (advertised === lanIp) return null;
  return `${lanIp}:${port}`;
}

function isDockerIface(name: string): boolean {
  return (
    name === 'docker0' ||
    name.startsWith('br-') ||
    name.startsWith('veth') ||
    name.startsWith('docker')
  );
}

function vpnKind(name: string): 'tailscale' | 'wireguard' | 'vpn' | null {
  if (name.startsWith('tailscale') || name === 'tailscale0') return 'tailscale';
  if (name.startsWith('wg')) return 'wireguard';
  if (name.startsWith('tun') || name.startsWith('tap')) return 'vpn';
  return null;
}

export function readInterfaces(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): {
  lanIp: string | null;
  vpn: { name: string; address: string; kind: 'tailscale' | 'wireguard' | 'vpn' }[];
} {
  const vpn: { name: string; address: string; kind: 'tailscale' | 'wireguard' | 'vpn' }[] = [];
  let lanIp: string | null = null;

  for (const [name, entries] of Object.entries(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      const family = String(entry.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (entry.internal) continue;
      const kind = vpnKind(name);
      if (kind) {
        vpn.push({ name, address: entry.address, kind });
        continue;
      }
      if (isDockerIface(name)) continue;
      if (classifyAddress(entry.address) === 'private' && !lanIp) lanIp = entry.address;
      if (classifyAddress(entry.address) === 'public' && !lanIp) lanIp = entry.address;
    }
  }
  return { lanIp, vpn };
}

export function lanHost(): string | null {
  if (config.upnpInternalIp) return config.upnpInternalIp;
  return readInterfaces().lanIp;
}

export function resolveNetworkChoice(
  choice: { mode: 'lan' | 'vpn' | 'public'; host?: string },
  report: {
    lanIp: string | null;
    vpn: { name: string; address: string; kind: string }[];
    router: { available: boolean; externalIp: string | null; controlUrl: string | null };
  },
): { publicHost: string | null; forwarding: boolean; error?: string } {
  if (choice.mode === 'lan') {
    if (!report.lanIp) return { publicHost: null, forwarding: false, error: 'No LAN address was found.' };
    return { publicHost: report.lanIp, forwarding: false };
  }
  if (choice.mode === 'vpn') {
    const vpn = report.vpn[0];
    if (!vpn) return { publicHost: null, forwarding: false, error: 'No VPN interface was found.' };
    return { publicHost: vpn.address, forwarding: false };
  }
  const host = choice.host || report.router.externalIp;
  if (!host) return { publicHost: null, forwarding: false, error: 'No public address was found.' };
  return { publicHost: host, forwarding: report.router.available };
}
