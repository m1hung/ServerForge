import { badRequest } from '@serverforge/core';
import net from 'node:net';

function ipv4FromMapped(address: string): string | null {
  const encoded = address.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (encoded) {
    const high = parseInt(encoded[1]!, 16),
      low = parseInt(encoded[2]!, 16);
    return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  }
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1] ?? null;
  const nat64 = address.match(/^64:ff9b::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i);
  if (nat64) return nat64[1] ?? null;
  const hex = address.match(/^64:ff9b::(?:ffff:)?([0-9a-f:]+)$/i);
  if (hex) {
    const parts = hex[1]!.split(':');
    const last = parts[parts.length - 1];
    if (last && last.length === 8 && /^[0-9a-f]+$/i.test(last)) {
      const n = parseInt(last, 16);
      return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
    }
  }
  return null;
}

function ipv4Octets(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function isBlockedIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === undefined || b === undefined) return true;
  if (a === 0 || a === 10 || a === 127 || a === 224 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 255) return true;
  return false;
}

function isBlockedIpv6(address: string): boolean {
  // BlockList understands compressed and IPv4-mapped IPv6 spellings.
  const blocked = new net.BlockList();
  for (const [subnet, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) {
    blocked.addSubnet(subnet, prefix, 'ipv6');
  }
  for (const [subnet, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['100.64.0.0', 10],
    ['224.0.0.0', 3],
  ] as const) {
    blocked.addSubnet(subnet, prefix, 'ipv4');
  }
  if (blocked.check(address, 'ipv6')) return true;
  const lower = address.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe80')) return true;
  if (lower.startsWith('ff')) return true;
  return false;
}

export function isBlockedAddress(address: string): boolean {
  const mapped = ipv4FromMapped(address);
  if (mapped) return isBlockedAddress(mapped);
  if (net.isIPv4(address)) {
    const octets = ipv4Octets(address);
    return !octets || isBlockedIpv4(octets);
  }
  if (net.isIPv6(address)) return isBlockedIpv6(address);
  return true;
}

export function checkWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('That webhook address is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('Webhooks must use http or https.');
  }
  if (url.username || url.password) {
    throw badRequest('Webhook URLs cannot include a username or password.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host)) {
    throw badRequest('That webhook points at a private or local address.');
  }
  return url;
}
