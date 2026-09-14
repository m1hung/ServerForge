import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { z } from 'zod';
import { prisma } from '@serverforge/db';
import type {
  HostNetworkSnapshot,
  NetworkConfiguration,
  PortForward,
} from '@serverforge/core/connectivity';
import { config, runningInContainer } from '../lib/config.js';
import {
  discoverGateway,
  gatewayFromConfiguredUrl,
  getExternalIp,
  validateGatewayUrl,
  type Gateway,
} from '../lib/igd.js';
import { readInterfaces, classifyAddress } from './network.js';

export const NETWORK_KEY = 'network.configuration';
export const FORWARDS_KEY = 'network.port-forwards';

export function validHost(value: string) {
  if (!value) return true;
  if (/^[\d.]+$/.test(value)) return net.isIP(value) !== 0;
  return (
    net.isIP(value) !== 0 ||
    (value.length <= 253 &&
      value.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part)))
  );
}
export function validLanHost(value: string) {
  if (!value) return true;
  if (!net.isIPv4(value)) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}
export function validTailnetUrl(value: string) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || (url.protocol === 'http:' && !!url.port)) &&
      (url.hostname.endsWith('.ts.net') || (net.isIPv4(url.hostname) && classifyAddress(url.hostname) === 'cgnat' && !!url.port)) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export const networkConfigurationSchema = z.object({
  lanHost: z
    .string()
    .trim()
    .max(64)
    .default('')
    .refine(validLanHost, 'Use the host’s LAN IPv4 address, such as 192.168.1.20.'),
  publicHost: z
    .string()
    .trim()
    .max(253)
    .default('')
    .refine(validHost, 'Enter an IP address or hostname, without a URL or port.'),
  routerUrl: z
    .string()
    .trim()
    .max(2048)
    .default('')
    .refine((value) => {
      try {
        if (value) validateGatewayUrl(value);
        return true;
      } catch {
        return false;
      }
    }, 'Use the router’s HTTP or HTTPS control/description URL with a LAN IPv4 address.'),
  upnpEnabled: z.boolean().default(false),
  leaseSeconds: z
    .number()
    .int()
    .min(0)
    .max(86400)
    .default(3600)
    .refine(
      (value) => value === 0 || value >= 300,
      'Use 300–86400 seconds, or 0 for a permanent lease.',
    ),
  tailscaleMode: z.enum(['auto', 'host', 'sidecar']).default('auto'),
  tailscaleUrl: z
    .string()
    .trim()
    .max(512)
    .default('')
    .refine(validTailnetUrl, 'Use the complete Tailscale dashboard URL, including its port when required.'),
  tailscaleGameHost: z
    .string()
    .trim()
    .max(253)
    .default('')
    .refine(
      (value) =>
        !value ||
        (net.isIPv4(value) && classifyAddress(value) === 'cgnat') ||
        /^[a-z0-9.-]+\.ts\.net$/i.test(value),
      'Use the host’s Tailscale IP or MagicDNS hostname.',
    ),
});

export async function readNetworkConfiguration(): Promise<NetworkConfiguration> {
  const row = await prisma.setting.findUnique({ where: { key: NETWORK_KEY } });
  return networkConfigurationSchema.parse(
    row?.value ?? {
      lanHost: config.upnpInternalIp || '',
      routerUrl: config.upnpControlUrl || '',
      upnpEnabled: config.upnpEnabled ?? false,
      leaseSeconds: config.upnpLeaseSeconds ?? 3600,
    },
  );
}
export async function writeNetworkConfiguration(value: NetworkConfiguration) {
  const checked = networkConfigurationSchema.parse(value);
  await prisma.setting.upsert({
    where: { key: NETWORK_KEY },
    create: { key: NETWORK_KEY, value: checked },
    update: { value: checked },
  });
  clearNetworkCache();
}
export async function readPortForwards(): Promise<PortForward[]> {
  const row = await prisma.setting.findUnique({ where: { key: FORWARDS_KEY } });
  return Array.isArray(row?.value) ? (row.value as unknown as PortForward[]) : [];
}
export async function writePortForwards(rows: PortForward[]) {
  const value = JSON.parse(JSON.stringify(rows));
  await prisma.setting.upsert({
    where: { key: FORWARDS_KEY },
    create: { key: FORWARDS_KEY, value },
    update: { value },
  });
}
export async function readHostNetwork(): Promise<HostNetworkSnapshot | null> {
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(config.dataRoot, '.network', 'host.json'), 'utf8'),
    ) as HostNetworkSnapshot;
    if (
      !raw.checkedAt ||
      !Number.isFinite(Date.parse(raw.checkedAt)) ||
      (raw.lanHost && !validLanHost(raw.lanHost))
    )
      return null;
    if (raw.gateway) validateGatewayUrl(raw.gateway.controlUrl);
    return raw;
  } catch {
    return null;
  }
}

type Discovery = {
  settings: NetworkConfiguration;
  host: HostNetworkSnapshot | null;
  lanHost: string | null;
  gateway: Gateway | null;
  externalIp: string | null;
  publicIp: string | null;
  routerError: string | null;
  checkedAt: string;
};
let cached: { until: number; promise: Promise<Discovery> } | null = null;
export function clearNetworkCache() {
  cached = null;
}
export async function discoverNetwork(force = false): Promise<Discovery> {
  if (!force && cached && cached.until > Date.now()) return cached.promise;
  const promise = (async () => {
    const [settings, host] = await Promise.all([readNetworkConfiguration(), readHostNetwork()]);
    const lanHost =
      settings.lanHost || host?.lanHost || (!runningInContainer() ? readInterfaces().lanIp : null);
    let gateway: Gateway | null = null,
      externalIp: string | null = null,
      routerError: string | null = null;
    try {
      gateway = settings.routerUrl
        ? await gatewayFromConfiguredUrl(settings.routerUrl)
        : (host?.gateway ?? (!runningInContainer() ? await discoverGateway(1500) : null));
      if (gateway) externalIp = await getExternalIp(gateway);
      else
        routerError =
          'No compatible router was detected. Run network setup on the host or enter its UPnP URL below.';
    } catch (error) {
      routerError = error instanceof Error ? error.message : 'The router did not respond.';
    }
    let publicIp = externalIp && classifyAddress(externalIp) === 'public' ? externalIp : null;
    if (!publicIp) {
      try {
        const response = await fetch('https://api.ipify.org?format=json', {
          signal: AbortSignal.timeout(3500),
          redirect: 'error',
        });
        const body = (await response.json()) as { ip?: string };
        if (response.ok && body.ip && net.isIPv4(body.ip) && classifyAddress(body.ip) === 'public')
          publicIp = body.ip;
      } catch {
        /* A configured hostname still works without IP discovery. */
      }
    }
    return {
      settings,
      host,
      lanHost,
      gateway,
      externalIp,
      publicIp,
      routerError,
      checkedAt: new Date().toISOString(),
    };
  })();
  cached = { until: Date.now() + 60000, promise };
  try {
    return await promise;
  } catch (error) {
    cached = null;
    throw error;
  }
}
