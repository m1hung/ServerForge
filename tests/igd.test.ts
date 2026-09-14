import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addPortMapping,
  deletePortMapping,
  describeGateway,
  getExternalIp,
  getPortMapping,
  validateGatewayUrl,
  gatewayFromControlUrl,
} from '../apps/api/src/lib/igd.js';
const gateway = {
  controlUrl: 'http://192.168.1.1:49152/control',
  serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:2',
};
const mapping = {
  externalPort: 25565,
  internalPort: 25565,
  internalClient: '192.168.1.20',
  protocol: 'TCP' as const,
  description: 'ServerForge:game&friends',
  leaseSeconds: 3600,
};
function respond(body: string, status = 200) {
  return new Response(body, { status });
}
const fault = (code: number) =>
  respond(
    `<s:Fault><u:errorCode>${code}</u:errorCode><u:errorDescription>Router rejected action</u:errorDescription></s:Fault>`,
    500,
  );
afterEach(() => vi.unstubAllGlobals());
describe('UPnP protocol', () => {
  it.each([
    'http://127.0.0.1/',
    'http://100.64.0.1/',
    'http://example.com/',
    'http://8.8.8.8/',
    'file:///etc/passwd',
    'http://user:password@192.168.1.1/',
    'http://[::1]/',
  ])('rejects non-router URL %s', (value) => {
    expect(() => validateGatewayUrl(value)).toThrow();
  });
  it('accepts private router URLs and supported service versions', () => {
    expect(validateGatewayUrl(gateway.controlUrl).hostname).toBe('192.168.1.1');
    expect(gatewayFromControlUrl(gateway.controlUrl, gateway.serviceType)).toEqual(gateway);
    expect(() => gatewayFromControlUrl(gateway.controlUrl, 'bad-service')).toThrow();
  });
  it('reads namespaced device descriptions and keeps control URLs on the same router', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          respond(
            `<root><d:service><d:serviceType>${gateway.serviceType}</d:serviceType><d:controlURL>/control?a=1&amp;b=2</d:controlURL></d:service></root>`,
          ),
        ),
    );
    expect(await describeGateway('http://192.168.1.1:49152/root.xml')).toEqual({
      ...gateway,
      controlUrl: `${gateway.controlUrl}?a=1&b=2`,
    });
  });
  it('rejects off-router control URLs, XML entities, and oversized responses', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    fetcher.mockResolvedValueOnce(
      respond(
        `<service><serviceType>${gateway.serviceType}</serviceType><controlURL>http://192.168.1.2/control</controlURL></service>`,
      ),
    );
    expect(await describeGateway('http://192.168.1.1/root.xml')).toBeNull();
    fetcher.mockResolvedValueOnce(
      respond('<!DOCTYPE test [<!ENTITY read SYSTEM "file:///etc/passwd">]>'),
    );
    await expect(describeGateway('http://192.168.1.1/root.xml')).rejects.toThrow(
      'Unsupported router XML',
    );
    fetcher.mockResolvedValueOnce(respond('a'.repeat(1024 * 1024 + 1)));
    await expect(getExternalIp(gateway)).rejects.toThrow('too large');
  });
  it('only treats error 714 as an unoccupied port', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(fault(714))
      .mockResolvedValueOnce(fault(401))
      .mockRejectedValueOnce(new Error('timeout'));
    vi.stubGlobal('fetch', fetcher);
    expect(await getPortMapping(gateway, 25565, 'TCP')).toBeNull();
    await expect(getPortMapping(gateway, 25565, 'TCP')).rejects.toMatchObject({ code: 401 });
    await expect(getPortMapping(gateway, 25565, 'TCP')).rejects.toThrow('timeout');
  });
  it('preserves mapping ownership and enabled state from namespaced responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          respond(
            '<u:NewInternalClient>192.168.1.20</u:NewInternalClient><NewInternalPort>25565</NewInternalPort><NewEnabled>1</NewEnabled><NewPortMappingDescription>ServerForge:game&amp;friends</NewPortMappingDescription>',
          ),
        ),
    );
    expect(await getPortMapping(gateway, 25565, 'TCP')).toEqual({
      internalClient: mapping.internalClient,
      internalPort: 25565,
      enabled: true,
      description: mapping.description,
    });
  });
  it('escapes SOAP values and retries permanent-only routers without changing the target', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(fault(725))
      .mockResolvedValueOnce(respond('<ok/>'));
    vi.stubGlobal('fetch', fetcher);
    expect(await addPortMapping(gateway, mapping)).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const first = fetcher.mock.calls[0]![1];
    const second = fetcher.mock.calls[1]![1];
    expect(first.body).toContain('<NewLeaseDuration>3600</NewLeaseDuration>');
    expect(first.body).toContain('ServerForge:game&amp;friends');
    expect(second.body).toContain('<NewLeaseDuration>0</NewLeaseDuration>');
    expect(first.redirect).toBe('error');
    expect(first.headers.SOAPAction).toContain('#AddPortMapping');
  });
  it('does not retry conflicting mappings', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(fault(718));
    vi.stubGlobal('fetch', fetcher);
    await expect(addPortMapping(gateway, mapping)).rejects.toMatchObject({ code: 718 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('deletes the exact protocol/port and validates external IPv4', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(respond('<ok/>'))
      .mockResolvedValueOnce(respond('<NewExternalIPAddress>8.8.4.4</NewExternalIPAddress>'))
      .mockResolvedValueOnce(respond('<NewExternalIPAddress>garbage</NewExternalIPAddress>'));
    vi.stubGlobal('fetch', fetcher);
    await deletePortMapping(gateway, 25565, 'UDP');
    expect(fetcher.mock.calls[0]![1].body).toContain('<NewProtocol>UDP</NewProtocol>');
    expect(await getExternalIp(gateway)).toBe('8.8.4.4');
    expect(await getExternalIp(gateway)).toBeNull();
  });
});
