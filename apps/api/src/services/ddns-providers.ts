/**
 * Dynamic DNS providers.
 *
 * Kept import-free and pure, like ports.ts: building a URL and reading a
 * response are exactly the parts worth testing, and neither needs config, a
 * database or the network.
 *
 * The rule every provider here follows: **always send the IPv4 address
 * explicitly.** Left to infer it from the connection, providers use whichever
 * family the request happened to arrive on — and on a host with working IPv6
 * that means the A record gets replaced by an AAAA, or deleted outright. That
 * is not hypothetical; it is the deSEC behaviour that produced a hostname with
 * no address on this very machine.
 */

export type DdnsProviderId = 'duckdns';

export interface DdnsCredentials {
  hostname: string;
  token: string;
}

export interface DdnsRequest {
  url: string;
  /** Same URL with the token replaced — the only form safe to log. */
  redactedUrl: string;
  headers?: Record<string, string>;
}

export interface DdnsOutcome {
  ok: boolean;
  message: string;
}

export interface DdnsProviderInfo {
  id: DdnsProviderId;
  label: string;
  /** Shown under the hostname field. */
  hostnameHint: string;
  /** Shown under the token field. */
  tokenHint: string;
  /** Where to go and get the token. */
  consoleUrl: string;
}

export const DDNS_PROVIDERS: DdnsProviderInfo[] = [
  {
    id: 'duckdns',
    label: 'DuckDNS',
    hostnameHint: 'Your DuckDNS name, e.g. myserver.duckdns.org',
    tokenHint: 'The token shown at the top of duckdns.org once you sign in',
    consoleUrl: 'https://www.duckdns.org',
  },
];

export function isDdnsProvider(value: unknown): value is DdnsProviderId {
  return typeof value === 'string' && DDNS_PROVIDERS.some((entry) => entry.id === value);
}

/**
 * The label DuckDNS wants.
 *
 * Their API takes the subdomain only — `myserver`, not `myserver.duckdns.org` —
 * but the full name is what people copy off the site and what they think of as
 * "my hostname". Accept either.
 */
export function normaliseHostname(provider: DdnsProviderId, hostname: string): string {
  const trimmed = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (provider === 'duckdns') return trimmed.replace(/\.duckdns\.org$/, '');
  return trimmed;
}

/** The name that should be handed to players and stored as publicHost. */
export function fullHostname(provider: DdnsProviderId, hostname: string): string {
  const label = normaliseHostname(provider, hostname);
  if (provider === 'duckdns') return `${label}.duckdns.org`;
  return label;
}

export function buildUpdateRequest(
  provider: DdnsProviderId,
  credentials: DdnsCredentials,
  ipv4: string,
): DdnsRequest {
  if (provider === 'duckdns') {
    const domains = encodeURIComponent(normaliseHostname(provider, credentials.hostname));
    const ip = encodeURIComponent(ipv4);
    const build = (token: string) =>
      `https://www.duckdns.org/update?domains=${domains}&token=${encodeURIComponent(token)}&ip=${ip}`;

    return {
      url: build(credentials.token),
      redactedUrl: build('***'),
    };
  }

  throw new Error(`Unsupported dynamic DNS provider: ${provider as string}`);
}

/**
 * Reads a provider's answer.
 *
 * DuckDNS replies with a bare `OK` or `KO` and HTTP 200 either way, so status
 * code alone would report every failure as a success — including a wrong
 * token, which is the single most likely thing to be wrong.
 */
export function interpretResponse(
  provider: DdnsProviderId,
  status: number,
  body: string,
): DdnsOutcome {
  const text = body.trim();

  if (provider === 'duckdns') {
    if (status !== 200) return { ok: false, message: `DuckDNS returned HTTP ${status}.` };
    if (/^OK/i.test(text)) return { ok: true, message: 'Address published.' };
    if (/^KO/i.test(text)) {
      return {
        ok: false,
        message: 'DuckDNS rejected the update — check the name and token are both correct.',
      };
    }
    return { ok: false, message: `Unexpected reply from DuckDNS: ${text.slice(0, 60) || '(empty)'}` };
  }

  return { ok: false, message: `Unsupported dynamic DNS provider: ${provider as string}` };
}
