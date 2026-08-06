import dns from 'node:dns/promises';
import net from 'node:net';
import { conflict } from '@serverforge/core';

/**
 * Guards for URLs a user typed.
 *
 * Everything else in the panel fetches from a fixed list of upstreams, so
 * `net.ts` can follow redirects and trust the host. A webhook URL is different:
 * it is attacker-controlled input that the *server* then requests, from inside
 * whatever network the panel is on. Unguarded, that is a probe for the Docker
 * API on localhost, a router admin page on the LAN, or the cloud metadata
 * service on 169.254.169.254 — which on a hosted box hands out credentials.
 *
 * Three things make this safe, and all three are needed:
 *   1. every address the hostname resolves to is checked, not just the first;
 *   2. redirects are never followed, or a public host could bounce the request
 *      to a private one after passing the check;
 *   3. the check runs again at send time, because DNS can change between the
 *      moment a schedule is saved and the moment it fires.
 */

/** Parses dotted-quad IPv4 into its four octets, or null. */
function ipv4Octets(ip: string): [number, number, number, number] | null {
  if (net.isIPv4(ip) !== true) return null;
  const parts = ip.split('.').map(Number);
  return parts as [number, number, number, number];
}

/**
 * True for any IPv4 address that is not a normal routable internet host.
 *
 * Deliberately broader than RFC 1918: link-local carries the cloud metadata
 * endpoint, CGNAT space is other customers of the same ISP, and the reserved
 * and test ranges have no business being a webhook target either.
 */
function isBlockedIpv4(ip: string): boolean {
  const octets = ipv4Octets(ip);
  if (!octets) return true;
  const [a, b] = octets;

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 CGNAT
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 0) return true; // protocol assignments + TEST-NET-1
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast

  return false;
}

/** Expands an IPv6 address to its eight 16-bit groups, or null if malformed. */
function ipv6Groups(ip: string): number[] | null {
  if (net.isIPv6(ip) !== true) return null;

  // A zone id ("fe80::1%eth0") is not part of the address.
  const bare = ip.split('%')[0] ?? ip;

  // An IPv4-mapped tail ("::ffff:192.168.0.1") has to become two groups.
  const mapped = bare.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/);
  let text = bare;
  if (mapped) {
    const octets = ipv4Octets(mapped[2] as string);
    if (!octets) return null;
    const [a, b, c, d] = octets;
    text = `${mapped[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head, tail] = text.split('::');
  const parse = (chunk: string | undefined) =>
    chunk && chunk.length > 0 ? chunk.split(':').filter(Boolean).map((g) => parseInt(g, 16)) : [];

  const left = parse(head);
  const right = parse(tail);

  if (text.includes('::')) {
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    return [...left, ...Array<number>(fill).fill(0), ...right];
  }

  return left.length === 8 ? left : null;
}

function isBlockedIpv6(ip: string): boolean {
  const groups = ipv6Groups(ip);
  if (!groups) return true;
  const [g0, g1] = groups as number[];

  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) both carry a real
  // IPv4 destination in the low groups. Judge them as that address, or
  // ::ffff:127.0.0.1 walks straight past an IPv6-only check.
  const isMapped =
    groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const isNat64 = g0 === 0x0064 && g1 === 0xff9b && groups.slice(2, 6).every((g) => g === 0);
  if (isMapped || isNat64) {
    const hi = groups[6] as number;
    const lo = groups[7] as number;
    return isBlockedIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }

  if (groups.every((g) => g === 0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  if ((g0 as number) === 0x0100 && groups.slice(1, 4).every((g) => g === 0)) return true; // 100::/64 discard
  if (((g0 as number) & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if (((g0 as number) & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if (((g0 as number) & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if ((g0 as number) === 0x2001 && (g1 as number) === 0x0db8) return true; // documentation

  return false;
}

/** True when an address must never be the target of a server-side request. */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  if (net.isIPv6(ip)) return isBlockedIpv6(ip);
  return true;
}

/**
 * Checks everything about a URL that does not need the network.
 *
 * Run at save time so a typo is a form error rather than a task that quietly
 * fails at 4am. A hostname is not resolved here — that happens at send time,
 * where the answer is still current.
 */
export function checkWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw conflict('That webhook address is not a valid URL.', 'It should start with https://');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw conflict(
      `${url.protocol.replace(':', '')} links cannot be used as webhooks.`,
      'Use an https:// address.',
    );
  }

  if (url.username || url.password) {
    throw conflict(
      'A webhook address cannot carry a username or password.',
      'Put the secret in the path or a query parameter, the way Discord and Slack do.',
    );
  }

  // A literal private address is refused outright — there is no DNS answer
  // that could later make it acceptable.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host)) {
    throw conflict(
      'That address is on a private network.',
      'Webhooks are sent by the panel itself, so it will only send them to addresses on the public internet.',
    );
  }

  return url;
}

/**
 * The send-time check: resolves the hostname and refuses if *any* answer is
 * private. Returns the addresses so the caller can log what it dialled.
 */
export async function resolvePublicHost(hostname: string): Promise<string[]> {
  const host = hostname.replace(/^\[|\]$/g, '');

  if (net.isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new Error(`${host} is a private address`);
    }
    return [host];
  }

  let addresses: string[];
  try {
    const answers = await dns.lookup(host, { all: true, verbatim: true });
    addresses = answers.map((answer) => answer.address);
  } catch {
    throw new Error(`could not resolve ${host}`);
  }

  if (addresses.length === 0) throw new Error(`could not resolve ${host}`);

  const blocked = addresses.find((address) => isBlockedAddress(address));
  if (blocked) {
    throw new Error(`${host} resolves to ${blocked}, which is on a private network`);
  }

  return addresses;
}
