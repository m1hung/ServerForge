import http from 'node:http';
import net from 'node:net';
import type {
  HostNetworkSnapshot,
  NetworkConfiguration,
  TailnetStatus,
} from '@serverforge/core/connectivity';
import { badRequest, conflict } from '@serverforge/core';
import { config, cookieSecure } from '../lib/config.js';
import { classifyAddress } from './network.js';
import { validTailnetUrl } from './connectivity.js';

interface Status {
  BackendState?: string;
  AuthURL?: string;
  TailscaleIPs?: string[];
  Self?: { DNSName?: string; Online?: boolean; Expired?: boolean; KeyExpiry?: string };
  CertDomains?: string[];
  Health?: string[];
}
type ServeConfig = {
  TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string }>;
  Web?: Record<string, { Handlers: Record<string, { Proxy?: string; Path?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
};

/** Only fixed LocalAPI paths are called. The socket belongs to the dedicated panel sidecar. */
export function tailscaleRequest<T>(
  endpoint: string,
  method = 'GET',
  body?: object,
  etag?: string,
): Promise<{ data: T; etag?: string }> {
  return new Promise((resolve, reject) => {
    const content = body ? JSON.stringify(body) : undefined;
    const request = http.request(
      {
        socketPath: config.tailscaleSocket,
        host: 'local-tailscaled.sock',
        path: `/localapi/v0/${endpoint}`,
        method,
        headers: {
          'Sec-Tailscale': 'localapi',
          ...(content
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(content) }
            : {}),
          ...(etag ? { 'If-Match': etag } : {}),
        },
      },
      (response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of response) {
            size += chunk.length;
            if (size > 1024 * 1024) throw new Error('Tailscale response was too large.');
            chunks.push(Buffer.from(chunk));
          }
          const text = Buffer.concat(chunks).toString('utf8');
          if (!response.statusCode || response.statusCode >= 300)
            throw new Error(
              `Tailscale could not complete this action (${response.statusCode ?? 'unavailable'}). ${text.slice(0, 300)}`,
            );
          try {
            resolve({ data: (text ? JSON.parse(text) : null) as T, etag: response.headers.etag });
          } catch {
            throw new Error('Tailscale returned an invalid response.');
          }
        })().catch(reject);
      },
    );
    request.setTimeout(6000, () => request.destroy(new Error('Tailscale did not respond.')));
    request.on('error', reject);
    request.end(content);
  });
}

function loginUrl(value?: string) {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' && url.hostname === 'login.tailscale.com' ? url.href : null;
  } catch {
    return null;
  }
}
export async function sidecarStatus(force = false): Promise<TailnetStatus> {
  try {
    const [{ data }, { data: serving }, { data: certDomains }] = await Promise.all([
      tailscaleRequest<Status>('status?peers=false'),
      tailscaleRequest<ServeConfig | null>('serve-config'),
      tailscaleRequest<string[]>('cert-domains').catch(() => ({ data: [] as string[] })),
    ]);
    const dnsName = data.Self?.DNSName?.replace(/\.$/, '') ?? null;
    const domain = dnsName && validTailnetUrl(`https://${dnsName}`) ? dnsName : null;
    const target = domain ? serving?.Web?.[`${domain}:443`]?.Handlers?.['/']?.Proxy : null;
    const configured = !!serving?.TCP?.['443']?.HTTPS && target === config.tailscaleProxyTarget;
    const verified = configured && data.BackendState === 'Running' && !!domain && await checkDashboard(`https://${domain}`, force);
    const expired = data.Self?.Expired || (data.Self?.KeyExpiry && Date.parse(data.Self.KeyExpiry) < Date.now());
    return {
      mode: 'sidecar',
      available: true,
      state: expired ? 'AuthenticationExpired' : data.BackendState ?? 'Unknown',
      machineName: domain,
      ip: data.TailscaleIPs?.find((ip) => !ip.includes(':')) ?? null,
      dashboardUrl: verified ? `https://${domain}` : null,
      loginUrl: loginUrl(data.AuthURL),
      httpsReady: !!domain && (certDomains ?? data.CertDomains ?? []).includes(domain),
      serving: !!verified,
      error: expired ? 'Tailscale authentication expired. Reauthenticate this device.' : data.Health?.join(' ') || (configured && !verified ? 'Serve is configured but the dashboard could not be verified. Check access rules and service availability.' : null),
    };
  } catch {
    return {
      mode: 'sidecar',
      available: false,
      state: 'Unavailable',
      machineName: null,
      ip: null,
      dashboardUrl: null,
      loginUrl: null,
      httpsReady: false,
      serving: false,
      error: 'The Tailscale service is unavailable. Run serverforge access sidecar, or configure the host Tailscale address.',
    };
  }
}

const hostChecks = new Map<string, { until: number; ok: boolean }>();
async function checkDashboard(url: string, force: boolean) {
  const cached = hostChecks.get(url);
  if (!force && cached && cached.until > Date.now()) return cached.ok;
  let ok = false;
  try {
    const response = await fetch(`${url}/api/setup`, {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    const data = (await response.json()) as { needsSetup?: boolean };
    ok = response.ok && typeof data.needsSetup === 'boolean';
  } catch {
    /* Expose the connection failure in the UI, never guess it is online. */
  }
  if (hostChecks.size >= 8) hostChecks.clear();
  hostChecks.set(url, { until: Date.now() + 60000, ok });
  return ok;
}

export async function tailnetStatus(
  settings: NetworkConfiguration,
  host: HostNetworkSnapshot | null,
  force = false,
): Promise<TailnetStatus> {
  const detected = host?.tailscale;
  const useHost =
    settings.tailscaleMode === 'host' ||
    (settings.tailscaleMode === 'auto' && (settings.tailscaleUrl || detected?.state === 'Running'));
  if (!useHost) return sidecarStatus(force);
  // Serve may be enabled on the host after the last discovery snapshot.
  const url =
    settings.tailscaleUrl ||
    detected?.dashboardUrl ||
    (detected?.state === 'Running' && detected.dnsName ? `https://${detected.dnsName}` : null);
  const valid = !!url && validTailnetUrl(url);
  const secureUrl = valid && new URL(url).protocol === 'https:';
  const reachable = valid && (!cookieSecure() || secureUrl) && (await checkDashboard(url.replace(/\/$/, ''), force));
  const httpsVerified = !!reachable && !!secureUrl;
  const hostIp = detected?.ip;
  const candidate =
    !cookieSecure() &&
    detected?.state === 'Running' &&
    hostIp &&
    net.isIPv4(hostIp) &&
    classifyAddress(hostIp) === 'cgnat'
      ? `http://${hostIp}:${config.webPort}`
      : null;
  const directUrl =
    reachable && !secureUrl ? url.replace(/\/$/, '') : !reachable && candidate && (await checkDashboard(candidate, force)) ? candidate : null;
  return {
    mode: 'host',
    available: !!detected || valid,
    state: reachable ? 'Running' : (detected?.state ?? 'NeedsSetup'),
    machineName: detected?.dnsName ?? (valid ? new URL(url).hostname : null),
    ip: settings.tailscaleGameHost || detected?.ip || null,
    dashboardUrl: httpsVerified ? url.replace(/\/$/, '') : null,
    loginUrl: null,
    httpsReady: httpsVerified,
    serving: httpsVerified,
    directUrl,
    error:
      reachable || directUrl
        ? null
        : valid
          ? 'The HTTPS dashboard did not respond from the panel. Check Tailscale access rules and the host’s Serve configuration.'
          : 'Run serverforge network on the host to inspect Tailscale and existing Serve handlers before enabling HTTPS.',
  };
}

export async function connectTailscale() {
  const status = await sidecarStatus();
  if (!status.available) throw badRequest(status.error ?? 'Tailscale is unavailable.');
  if (status.state === 'Running') return status;
  await tailscaleRequest('start', 'POST', {});
  await tailscaleRequest('prefs', 'PATCH', {
    WantRunning: true,
    WantRunningSet: true,
    CorpDNS: false,
    CorpDNSSet: true,
    Hostname: config.tailscaleHostname,
    HostnameSet: true,
  });
  if (!status.loginUrl) await tailscaleRequest('login-interactive', 'POST');
  return sidecarStatus(true);
}

export async function configureTailnetDashboard(enabled: boolean) {
  const status = await sidecarStatus();
  if (!status.available || status.state !== 'Running' || !status.machineName)
    throw badRequest('Connect this Tailscale device first.');
  if (enabled && !status.httpsReady)
    throw badRequest(
      'Enable HTTPS certificates in your Tailscale DNS settings, then check the connection again.',
    );
  const { data, etag } = await tailscaleRequest<ServeConfig | null>('serve-config');
  const existing = data ?? {};
  const key = `${status.machineName}:443`;
  const handler = existing.Web?.[key]?.Handlers?.['/'];
  if (existing.TCP?.['443']?.TCPForward)
    throw conflict(
      'Tailscale port 443 is forwarding another application. Keep the existing connection.',
    );
  if (handler && handler.Proxy !== config.tailscaleProxyTarget)
    throw conflict(
      'Tailscale port 443 is already serving another application. Keep it or choose the existing host connection.',
    );
  if (Object.values(existing.AllowFunnel ?? {}).some(Boolean))
    throw conflict(
      'This device has public Funnel access enabled. Use a private Tailscale device for the dashboard.',
    );
  if (enabled) {
    existing.TCP = { ...existing.TCP, '443': { HTTPS: true } };
    existing.Web = {
      ...existing.Web,
      [key]: {
        Handlers: { ...existing.Web?.[key]?.Handlers, '/': { Proxy: config.tailscaleProxyTarget } },
      },
    };
  } else {
    if (existing.Web?.[key]) {
      delete existing.Web[key].Handlers['/'];
      if (!Object.keys(existing.Web[key].Handlers).length) {
        delete existing.Web[key];
        delete existing.TCP?.['443'];
      }
    }
  }
  await tailscaleRequest('serve-config', 'POST', existing, etag);
  return sidecarStatus(true);
}
