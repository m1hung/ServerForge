const PROVIDERS = {
  duckdns: {
    zone: 'duckdns.org',
    update: 'https://www.duckdns.org/update',
  },
} as const;

export type DdnsProviderId = keyof typeof PROVIDERS;

export function isDdnsProvider(value: unknown): value is DdnsProviderId {
  return typeof value === 'string' && value in PROVIDERS;
}

export function normaliseHostname(provider: DdnsProviderId, hostname: string): string {
  const zone = PROVIDERS[provider].zone;
  let value = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (value.endsWith(`.${zone}`)) value = value.slice(0, -(zone.length + 1));
  return value;
}

export function fullHostname(provider: DdnsProviderId, hostname: string): string {
  const zone = PROVIDERS[provider].zone;
  const short = normaliseHostname(provider, hostname);
  return `${short}.${zone}`;
}

export function buildUpdateRequest(
  provider: DdnsProviderId,
  credentials: { hostname: string; token: string },
  ipv4: string,
): { url: string; redactedUrl: string } {
  const domains = normaliseHostname(provider, credentials.hostname);
  const url = new URL(PROVIDERS[provider].update);
  url.searchParams.set('domains', domains);
  url.searchParams.set('token', credentials.token);
  url.searchParams.set('ip', ipv4);
  const redacted = new URL(url);
  redacted.searchParams.set('token', '***');
  return { url: url.toString(), redactedUrl: redacted.toString() };
}

export function interpretResponse(
  provider: DdnsProviderId,
  status: number,
  body: string,
): { ok: boolean; message: string } {
  const text = body.trim();
  if (provider === 'duckdns') {
    if (status === 200 && /^OK$/i.test(text)) return { ok: true, message: 'Updated.' };
    if (status === 200 && /^KO$/i.test(text)) {
      return { ok: false, message: 'DuckDNS rejected the token.' };
    }
  }
  if (status >= 200 && status < 300 && text === '') {
    return { ok: false, message: 'The provider answered without a recognisable body.' };
  }
  return { ok: false, message: text || `HTTP ${status}` };
}
