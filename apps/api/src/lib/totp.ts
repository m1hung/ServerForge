import { createHmac, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789';

export function base32Encode(input: Buffer): string {
  if (input.length === 0) return '';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  while (output.length % 8 !== 0) output += '=';
  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (cleaned === '') return Buffer.alloc(0);
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const idx = ALPHABET.indexOf(char);
    if (idx < 0) throw new Error('Invalid base32 character.');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function secretBytes(secret: string): Buffer {
  return base32Decode(secret);
}

export function hotp(secret: string, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', secretBytes(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const mod = 10 ** digits;
  return String(code % mod).padStart(digits, '0');
}

export function totp(secret: string, atMs = Date.now(), digits = 6, period = 30): string {
  const counter = Math.floor(atMs / 1000 / period);
  return hotp(secret, counter, digits);
}

export function verifyTotp(
  secret: string,
  code: string,
  options: { atMs?: number; window?: number; digits?: number; period?: number } = {},
): boolean {
  const cleaned = code.replace(/\s+/g, '');
  const digits = options.digits ?? 6;
  if (!new RegExp(`^\\d{${digits}}$`).test(cleaned)) return false;
  const atMs = options.atMs ?? Date.now();
  const period = options.period ?? 30;
  const window = options.window ?? 1;
  const counter = Math.floor(atMs / 1000 / period);
  for (let delta = -window; delta <= window; delta += 1) {
    if (hotp(secret, counter + delta, digits) === cleaned) return true;
  }
  return false;
}

export function generateSecret(): string {
  return base32Encode(randomBytes(20)).replace(/=+$/, '');
}

export function otpauthUri(options: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${options.issuer}:${options.account}`);
  const params = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    period: '30',
    digits: '6',
    algorithm: 'SHA1',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export async function otpauthQr(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, { margin: 1, width: 256, errorCorrectionLevel: 'M' });
}

export function formatSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

export function generateRecoveryCodes(count = 10): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    let raw = '';
    while (raw.length < 10) {
      const byte = randomBytes(1)[0]!;
      raw += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    }
    codes.add(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return [...codes];
}

export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}
