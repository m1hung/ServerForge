import { afterEach, describe, expect, it, vi } from 'vitest';
import type os from 'node:os';

/**
 * The setup wizard's safety rule, pinned.
 *
 * The wizard asks one question — who should be able to join — and a beginner
 * clicking the default must never end up with a server exposed to the
 * internet. Everything that decides that is pure, so it is asserted here
 * rather than by driving a browser at a router.
 *
 * `network.ts` reads config at import time, so each case loads it after env is
 * in place, the same way tests/storage-paths.test.ts does.
 */
const env = {
  SESSION_SECRET: 'a'.repeat(64),
  ENCRYPTION_KEY: 'b'.repeat(64),
  DATABASE_URL: 'postgresql://serverforge:x@localhost:5432/serverforge',
};

async function loadNetwork() {
  vi.resetModules();
  delete process.env.UPNP_ENABLED;
  delete process.env.UPNP_CONTROL_URL;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  return import('../apps/api/src/services/network.js');
}

afterEach(() => {
  vi.resetModules();
});

/** Minimal shape of what os.networkInterfaces() hands back. */
function iface(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  } as os.NetworkInterfaceInfo;
}

describe('classifyAddress', () => {
  it('recognises a routable address', async () => {
    const { classifyAddress } = await loadNetwork();
    expect(classifyAddress('98.35.140.29')).toBe('public');
    expect(classifyAddress('8.8.8.8')).toBe('public');
  });

  it('recognises carrier-grade NAT, where forwarding can never work', async () => {
    const { classifyAddress } = await loadNetwork();
    // RFC 6598 is 100.64.0.0/10 — the second octet runs 64..127 only.
    expect(classifyAddress('100.64.0.1')).toBe('cgnat');
    expect(classifyAddress('100.127.255.254')).toBe('cgnat');
    // Neighbouring space that is ordinary public address, not CGNAT.
    expect(classifyAddress('100.63.0.1')).toBe('public');
    expect(classifyAddress('100.128.0.1')).toBe('public');
  });

  it('recognises a router with no real upstream address', async () => {
    const { classifyAddress } = await loadNetwork();
    expect(classifyAddress('10.0.0.1')).toBe('private');
    expect(classifyAddress('192.168.1.1')).toBe('private');
    expect(classifyAddress('172.16.0.1')).toBe('private');
    expect(classifyAddress('172.32.0.1')).toBe('public');
    expect(classifyAddress('169.254.1.1')).toBe('private');
  });

  it('does not guess at nonsense', async () => {
    const { classifyAddress } = await loadNetwork();
    expect(classifyAddress(null)).toBe('unknown');
    expect(classifyAddress('not-an-ip')).toBe('unknown');
    expect(classifyAddress('1.2.3')).toBe('unknown');
    expect(classifyAddress('999.1.1.1')).toBe('unknown');
  });
});

describe('readInterfaces', () => {
  it('never offers a Docker bridge as the address to give players', async () => {
    const { readInterfaces } = await loadNetwork();
    const { lanIp } = readInterfaces({
      lo: [iface('127.0.0.1', true)],
      docker0: [iface('172.17.0.1')],
      'br-9f21': [iface('172.18.0.1')],
      veth0: [iface('172.19.0.1')],
      enp2s0: [iface('10.0.0.215')],
    });

    expect(lanIp).toBe('10.0.0.215');
  });

  it('separates VPN interfaces from the LAN', async () => {
    const { readInterfaces } = await loadNetwork();
    const { lanIp, vpn } = readInterfaces({
      enp2s0: [iface('10.0.0.215')],
      tailscale0: [iface('100.96.52.45')],
      wg0: [iface('10.8.0.2')],
    });

    expect(lanIp).toBe('10.0.0.215');
    expect(vpn.map((entry) => entry.kind)).toEqual(['tailscale', 'wireguard']);
    // A VPN address must never be mistaken for the LAN one.
    expect(vpn.map((entry) => entry.address)).not.toContain(lanIp);
  });
});

describe('resolveNetworkChoice', () => {
  const report = {
    lanIp: '10.0.0.215',
    vpn: [{ name: 'tailscale0', address: '100.96.52.45', kind: 'tailscale' as const }],
    router: { available: true, externalIp: '98.35.140.29', controlUrl: 'http://10.0.0.1/ctl' },
  };

  it('never enables forwarding for a local-only choice', async () => {
    const { resolveNetworkChoice } = await loadNetwork();
    const result = resolveNetworkChoice({ mode: 'lan' }, report);

    expect(result.publicHost).toBe('10.0.0.215');
    // The router is available and would happily oblige. It is not asked.
    expect(result.forwarding).toBe(false);
  });

  it('never enables forwarding for a VPN choice', async () => {
    const { resolveNetworkChoice } = await loadNetwork();
    const result = resolveNetworkChoice({ mode: 'vpn' }, report);

    expect(result.publicHost).toBe('100.96.52.45');
    expect(result.forwarding).toBe(false);
  });

  it('enables forwarding only when the internet is chosen deliberately', async () => {
    const { resolveNetworkChoice } = await loadNetwork();
    const result = resolveNetworkChoice({ mode: 'public' }, report);

    expect(result.publicHost).toBe('98.35.140.29');
    expect(result.forwarding).toBe(true);
  });

  it('still sets the address when the router cannot be driven', async () => {
    const { resolveNetworkChoice } = await loadNetwork();
    const result = resolveNetworkChoice(
      { mode: 'public' },
      { ...report, router: { available: false, externalIp: '98.35.140.29', controlUrl: null } },
    );

    // Someone may have forwarded the port by hand; the address is still right.
    expect(result.publicHost).toBe('98.35.140.29');
    expect(result.forwarding).toBe(false);
  });

  it('prefers a custom hostname over the detected address', async () => {
    const { resolveNetworkChoice } = await loadNetwork();
    const result = resolveNetworkChoice({ mode: 'public', host: 'play.example.com' }, report);

    expect(result.publicHost).toBe('play.example.com');
    expect(result.forwarding).toBe(true);
  });

  it('reports rather than guesses when nothing was detected', async () => {
    const { resolveNetworkChoice } = await loadNetwork();
    const empty = { lanIp: null, vpn: [], router: { available: false, externalIp: null, controlUrl: null } };

    expect(resolveNetworkChoice({ mode: 'lan' }, empty).error).toBeTruthy();
    expect(resolveNetworkChoice({ mode: 'vpn' }, empty).error).toBeTruthy();
    expect(resolveNetworkChoice({ mode: 'public' }, empty).error).toBeTruthy();
    // And none of those failures quietly turn forwarding on.
    expect(resolveNetworkChoice({ mode: 'public' }, empty).forwarding).toBe(false);
  });
});
