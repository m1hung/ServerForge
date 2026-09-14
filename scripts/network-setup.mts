#!/usr/bin/env node
/** Refresh host-only discovery for Docker; --tailscale also enables a private HTTPS dashboard. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  discoverGateway,
  discoverGatewayNear,
  validateGatewayUrl,
  gatewayFromConfiguredUrl,
  gatewayHost,
  localAddressFor,
} from '../apps/api/src/lib/igd.js';
import type { HostNetworkSnapshot } from '../packages/core/src/connectivity.js';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(root, '.env'), 'utf8').catch(() => '');
function env(key: string, fallback = '') {
  const line = source.split(/\r?\n/).find((line) => line.startsWith(`${key}=`));
  return (
    process.env[key] ??
    line
      ?.slice(key.length + 1)
      .trim()
      .replace(/^["']|["']$/g, '') ??
    fallback
  );
}
const folder = path.join(path.resolve(root, env('HOST_DATA_ROOT', 'data/servers')), '.network');
const port = Number(env('WEB_PORT', '3000'));
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('WEB_PORT must be a valid port.');
let gateway = await discoverGateway(1800).catch(() => null);
if (!gateway && env('UPNP_CONTROL_URL'))
  gateway = await gatewayFromConfiguredUrl(env('UPNP_CONTROL_URL')).catch(() => null);
// Some host firewalls drop multicast replies. Probe only the known default
// router's bounded IGD port range; never guess or scan the surrounding LAN.
if (!gateway && process.platform === 'linux') {
  try {
    const routes = JSON.parse(
      (await exec('ip', ['-j', 'route', 'show', 'default'], { timeout: 3000 })).stdout,
    ) as { gateway?: string; dev?: string }[];
    const route = routes.find(
      (row) => row.gateway && !/^(tailscale|wg|tun|tap)/.test(row.dev ?? ''),
    );
    if (route?.gateway) {
      const hint = validateGatewayUrl(`http://${route.gateway}`);
      gateway = await discoverGatewayNear(hint.href);
    }
  } catch {
    /* Manual router configuration remains available. */
  }
}
const interfaces = Object.entries(os.networkInterfaces())
  .filter(([name]) => !/^(lo$|docker|br-|veth|tailscale|wg|tun|tap)/.test(name))
  .flatMap(([, entries]) => entries ?? []);
const lanHost =
  env('UPNP_INTERNAL_IP') ||
  (gateway ? await localAddressFor(gatewayHost(gateway)) : null) ||
  interfaces.find(
    (row) =>
      row.family === 'IPv4' &&
      !row.internal &&
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(row.address),
  )?.address ||
  null;
let tailscale: HostNetworkSnapshot['tailscale'] = null;
try {
  const { stdout } = await exec('tailscale', ['status', '--json'], {
    timeout: 8000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const status = JSON.parse(stdout);
  const dnsName = status.Self?.DNSName?.replace(/\.$/, '') ?? null;
  const ip = status.TailscaleIPs?.find((value: string) => !value.includes(':')) ?? null;
  tailscale = { state: status.BackendState ?? 'Unknown', ip, dnsName, dashboardUrl: null };
  const { stdout: serving } = await exec('tailscale', ['serve', 'status', '--json'], {
    timeout: 8000,
  });
  let serve = JSON.parse(serving || '{}');
  const key = `${dnsName}:443`,
    target = `http://127.0.0.1:${port}`;
  if (process.argv.includes('--tailscale')) {
    if (tailscale.state !== 'Running' || !dnsName)
      throw new Error('Sign in to Tailscale on this host first, then run network setup again.');
    const handler = serve.Web?.[key]?.Handlers?.['/'];
    if (serve.TCP?.['443']?.TCPForward || (handler && handler.Proxy !== target))
      throw new Error(
        'Tailscale port 443 already serves another application. Its configuration was preserved.',
      );
    if (Object.values(serve.AllowFunnel ?? {}).some(Boolean))
      throw new Error(
        'This host has public Funnel access enabled. Use a private Tailscale Serve connection for the dashboard.',
      );
    try {
      const result = await exec('tailscale', ['serve', '--bg', target], { timeout: 25000 });
      if (result.stdout.trim()) console.log(result.stdout.trim());
    } catch (error) {
      const detail = error as { stdout?: string; stderr?: string; message?: string };
      console.error(
        (detail.stdout || detail.stderr || detail.message || 'Tailscale Serve needs setup.').trim(),
      );
      process.exitCode = 1;
    }
    serve = JSON.parse(
      (await exec('tailscale', ['serve', 'status', '--json'], { timeout: 8000 })).stdout || '{}',
    );
  }
  if (
    dnsName &&
    serve.TCP?.['443']?.HTTPS &&
    serve.Web?.[key]?.Handlers?.['/']?.Proxy === target &&
    !Object.values(serve.AllowFunnel ?? {}).some(Boolean)
  )
    tailscale.dashboardUrl = `https://${dnsName}`;
} catch (error) {
  if (process.argv.includes('--tailscale')) {
    console.error(error instanceof Error ? error.message : 'Tailscale setup failed.');
    process.exitCode = 1;
  }
}
const snapshot: HostNetworkSnapshot = {
  checkedAt: new Date().toISOString(),
  lanHost,
  gateway,
  tailscale,
};
await fs.mkdir(folder, { recursive: true, mode: 0o700 });
const temporary = path.join(folder, `host.${process.pid}.json`);
await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
await fs.rename(temporary, path.join(folder, 'host.json'));
console.log(`Local network: ${lanHost ?? 'not detected'}`);
console.log(
  `UPnP router: ${gateway ? new URL(gateway.controlUrl).hostname : 'not detected; manual forwarding or a router URL can be configured in the dashboard'}`,
);
console.log(
  `Tailscale: ${tailscale?.dashboardUrl ?? tailscale?.state ?? 'not installed on the host'}`,
);
