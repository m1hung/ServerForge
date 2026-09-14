import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const state = vi.hoisted(() => ({ socket: '', secureCookies: false }));
vi.mock('../apps/api/src/lib/config.js', () => ({
  cookieSecure: () => state.secureCookies,
  config: {
    get tailscaleSocket() {
      return state.socket;
    },
    tailscaleProxyTarget: 'http://web:3000',
    tailscaleHostname: 'serverforge',
    webPort: 3000,
  },
}));
vi.mock('../apps/api/src/services/connectivity.js', () => ({
  validTailnetUrl: (value: string) => /^https?:\/\/[a-z0-9.-]+\.ts\.net(?::\d+)?\/?$/.test(value),
}));
import {
  configureTailnetDashboard,
  connectTailscale,
  sidecarStatus,
  tailscaleRequest,
  tailnetStatus,
} from '../apps/api/src/services/tailscale.js';
let daemon: http.Server,
  folder: string,
  status: {
    BackendState: string;
    Self: { DNSName: string };
    TailscaleIPs: string[];
    AuthURL?: string;
  },
  serving: {
    TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string }>;
    Web?: Record<string, { Handlers: Record<string, { Proxy: string }> }>;
    AllowFunnel?: Record<string, boolean>;
  },
  certs: string[];
let calls: { path: string; method: string; body: unknown; etag?: string }[], etagMismatch: boolean;
const domain = 'serverforge.example.ts.net';
beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ needsSetup: false })));
  state.secureCookies = false;
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-tailnet-'));
  state.socket = path.join(folder, 'localapi.sock');
  status = {
    BackendState: 'Running',
    Self: { DNSName: `${domain}.` },
    TailscaleIPs: ['100.100.1.2'],
  };
  serving = {};
  certs = [domain];
  calls = [];
  etagMismatch = false;
  daemon = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({
      path: request.url!,
      method: request.method!,
      body,
      etag: request.headers['if-match'],
    });
    response.setHeader('Content-Type', 'application/json');
    if (request.headers['sec-tailscale'] !== 'localapi') {
      response.writeHead(403);
      response.end('{}');
      return;
    }
    if (request.url?.endsWith('/serve-config')) {
      response.setHeader('ETag', 'current');
      if (request.method === 'POST') {
        if (etagMismatch || request.headers['if-match'] !== 'current') {
          response.writeHead(412);
          response.end('{"error":"changed"}');
          return;
        }
        serving = body;
      }
      response.end(JSON.stringify(serving));
    } else if (request.url?.endsWith('/status?peers=false')) response.end(JSON.stringify(status));
    else if (request.url?.endsWith('/cert-domains')) response.end(JSON.stringify(certs));
    else if (request.url?.endsWith('/login-interactive')) {
      status.AuthURL = 'https://login.tailscale.com/a/authorize-test';
      response.end('{}');
    } else response.end('{}');
  });
  await new Promise<void>((resolve) => daemon.listen(state.socket, resolve));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => daemon.close(() => resolve()));
  await fs.rm(folder, { recursive: true, force: true });
});
describe('private Tailscale dashboard', () => {
  it('reads actual LocalAPI status and certificate capability', async () => {
    expect(await sidecarStatus()).toMatchObject({
      mode: 'sidecar',
      available: true,
      state: 'Running',
      httpsReady: true,
      serving: false,
      dashboardUrl: null,
    });
  });
  it('preserves unrelated routes and uses ETag when enabling the fixed HTTPS proxy', async () => {
    serving = {
      TCP: { '8443': { HTTPS: true } },
      Web: { [`${domain}:8443`]: { Handlers: { '/': { Proxy: 'http://other:3000' } } } },
    };
    expect((await configureTailnetDashboard(true)).serving).toBe(true);
    expect(serving.Web![`${domain}:8443`].Handlers['/'].Proxy).toBe('http://other:3000');
    expect(serving.Web![`${domain}:443`].Handlers['/'].Proxy).toBe('http://web:3000');
    expect(serving.AllowFunnel).toBeUndefined();
    expect(
      calls.find((call) => call.method === 'POST' && call.path.endsWith('/serve-config'))?.etag,
    ).toBe('current');
  });
  it.each([
    { TCP: { '443': { TCPForward: 'localhost:22' } } },
    { Web: { [`domain-placeholder:443`]: { Handlers: { '/': { Proxy: 'http://other:3000' } } } } },
    { AllowFunnel: { 'any:443': true } },
  ])('refuses to replace another service or publish through Funnel', async (config) => {
    serving = JSON.parse(JSON.stringify(config).replace('domain-placeholder', domain));
    await expect(configureTailnetDashboard(true)).rejects.toThrow();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });
  it('does not lose concurrent Serve changes', async () => {
    etagMismatch = true;
    await expect(configureTailnetDashboard(true)).rejects.toThrow('412');
    expect(serving).toEqual({});
  });
  it('disables only its own handler while preserving sibling routes', async () => {
    serving = {
      TCP: { '443': { HTTPS: true } },
      Web: {
        [`${domain}:443`]: {
          Handlers: {
            '/': { Proxy: 'http://web:3000' },
            '/other/': { Proxy: 'http://other:3000' },
          },
        },
      },
    };
    expect((await configureTailnetDashboard(false)).serving).toBe(false);
    expect(serving.Web![`${domain}:443`].Handlers['/other/']).toBeDefined();
    expect(serving.TCP!['443'].HTTPS).toBe(true);
  });
  it('requires connection and HTTPS capability before enabling remote access', async () => {
    certs = [];
    await expect(configureTailnetDashboard(true)).rejects.toThrow('HTTPS certificates');
    status.BackendState = 'NeedsLogin';
    await expect(configureTailnetDashboard(true)).rejects.toThrow('Connect');
  });
  it('starts an interactive login without restarting tailscaled or requiring an auth key', async () => {
    status.BackendState = 'NeedsLogin';
    certs = [];
    expect((await connectTailscale()).loginUrl).toBe(
      'https://login.tailscale.com/a/authorize-test',
    );
    expect(calls.find((call) => call.path.endsWith('/prefs'))?.body).toMatchObject({
      WantRunning: true,
      WantRunningSet: true,
      CorpDNS: false,
      Hostname: 'serverforge',
    });
    expect(calls.filter((call) => call.path.endsWith('/login-interactive'))).toHaveLength(1);
    await connectTailscale();
    expect(calls.filter((call) => call.path.endsWith('/login-interactive'))).toHaveLength(1);
  });
  it('does not return an untrusted login URL', async () => {
    status.AuthURL = 'https://evil.example/authorize';
    expect((await sidecarStatus()).loginUrl).toBeNull();
  });
  it('reports a missing daemon honestly', async () => {
    state.socket = path.join(folder, 'missing.sock');
    expect(await sidecarStatus()).toMatchObject({
      available: false,
      serving: false,
      state: 'Unavailable',
    });
    await expect(tailscaleRequest('status')).rejects.toThrow();
  });
});

describe('existing host Tailscale access', () => {
  const settings = {
    lanHost: '',
    publicHost: '',
    routerUrl: '',
    upnpEnabled: false,
    leaseSeconds: 3600,
    tailscaleMode: 'auto' as const,
    tailscaleUrl: '',
    tailscaleGameHost: '',
  };
  const host = {
    checkedAt: new Date().toISOString(),
    lanHost: '192.168.1.20',
    gateway: null,
    tailscale: {
      state: 'Running',
      ip: '100.80.1.20',
      dnsName: 'host.example.ts.net',
      dashboardUrl: null as string | null,
    },
  };
  it('preserves a working host DNS address including its HTTP port', async () => {
    expect(await tailnetStatus({ ...settings, tailscaleUrl: 'http://willusshost.golden-royal.ts.net:3000' }, host, true)).toMatchObject({ directUrl: 'http://willusshost.golden-royal.ts.net:3000', dashboardUrl: null, serving: false, httpsReady: false });
  });
  it('offers verified direct tailnet access without requiring sudo or HTTPS Serve', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(Response.json({ needsSetup: false }));
    vi.stubGlobal('fetch', fetcher);
    expect(await tailnetStatus(settings, host, true)).toMatchObject({
      mode: 'host',
      directUrl: 'http://100.80.1.20:3000',
      serving: false,
      httpsReady: false,
      error: null,
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://host.example.ts.net/api/setup',
      'http://100.80.1.20:3000/api/setup',
    ]);
  });
  it('detects host HTTPS enabled after the discovery snapshot was saved', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ needsSetup: false }));
    vi.stubGlobal('fetch', fetcher);
    expect(await tailnetStatus(settings, host, true)).toMatchObject({
      serving: true,
      httpsReady: true,
      directUrl: null,
      dashboardUrl: 'https://host.example.ts.net',
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://host.example.ts.net/api/setup',
    ]);
  });
  it('prefers a verified HTTPS dashboard when available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ needsSetup: false })));
    const result = await tailnetStatus(
      settings,
      { ...host, tailscale: { ...host.tailscale, dashboardUrl: 'https://host.example.ts.net' } },
      true,
    );
    expect(result).toMatchObject({
      serving: true,
      directUrl: null,
      dashboardUrl: 'https://host.example.ts.net',
    });
  });
  it('does not label an unreachable or unrelated HTTP service as a connected dashboard', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ otherApp: true })));
    expect((await tailnetStatus(settings, host, true)).directUrl).toBeNull();
  });
  it('never generates a direct URL for a non-tailnet address or a stopped host connection', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(
      (
        await tailnetStatus(
          settings,
          { ...host, tailscale: { ...host.tailscale, ip: '127.0.0.1' } },
          true,
        )
      ).directUrl,
    ).toBeNull();
    expect(
      (
        await tailnetStatus(
          { ...settings, tailscaleMode: 'host' },
          { ...host, tailscale: { ...host.tailscale, state: 'Stopped' } },
          true,
        )
      ).directUrl,
    ).toBeNull();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://host.example.ts.net/api/setup',
    ]);
  });
});

it('does not offer HTTP dashboard access when the installation requires Secure cookies', async () => {
  state.secureCookies = true;
  const settings = {
    lanHost: '',
    publicHost: '',
    routerUrl: '',
    upnpEnabled: false,
    leaseSeconds: 3600,
    tailscaleMode: 'host' as const,
    tailscaleUrl: '',
    tailscaleGameHost: '',
  };
  const host = {
    checkedAt: new Date().toISOString(),
    lanHost: '192.168.1.20',
    gateway: null,
    tailscale: {
      state: 'Running',
      ip: '100.80.1.20',
      dnsName: 'host.example.ts.net',
      dashboardUrl: null,
    },
  };
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect((await tailnetStatus(settings, host, true)).directUrl).toBeNull();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://host.example.ts.net/api/setup']);
});
