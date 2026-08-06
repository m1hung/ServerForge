import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238) and the base32 alphabet they are
 * exchanged in (RFC 4648).
 *
 * Written out rather than pulled from a package because both specs are short,
 * both publish official test vectors, and `tests/totp.test.ts` pins this
 * implementation against them — which is stronger assurance than a dependency
 * nobody in the project has read.
 *
 * Deliberately pure: no config, no database, no clock of its own beyond the
 * argument it is given, so every case here is testable.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  // RFC 4648 pads to a multiple of 8 characters. Authenticator apps do not
  // care, but the round trip should match the spec.
  while (output.length % 8 !== 0) output += '=';
  return output;
}

export function base32Decode(input: string): Buffer {
  // Humans retype these off a screen, so spaces and case are forgiven.
  const cleaned = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`"${char}" is not a base32 character`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/** A new secret. 160 bits is what RFC 4226 requires for HMAC-SHA1. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20)).replace(/=+$/, '');
}

/**
 * The HOTP value for a counter (RFC 4226 §5.3), which TOTP defines as the
 * number of time steps since the epoch.
 */
export function hotp(secret: string, counter: number, digits = 6): string {
  const key = base32Decode(secret);

  const message = Buffer.alloc(8);
  // Counters stay well inside 2^53, so the high word is written separately
  // rather than reaching for BigInt.
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', key).update(message).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export const TIME_STEP_SECONDS = 30;

export function totp(secret: string, atMs = Date.now(), digits = 6): string {
  return hotp(secret, Math.floor(atMs / 1000 / TIME_STEP_SECONDS), digits);
}

/**
 * Checks a submitted code.
 *
 * `window` is how many steps either side are accepted; 1 means the code from
 * the previous 30 seconds still works, which is what makes the difference
 * between "usable" and "infuriating" for a phone whose clock has drifted.
 * Comparison is constant-time so a near-miss cannot be distinguished by
 * timing from a wrong first digit.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { atMs?: number; window?: number; digits?: number } = {},
): boolean {
  const { atMs = Date.now(), window = 1, digits = 6 } = options;

  const cleaned = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(cleaned)) return false;

  const step = Math.floor(atMs / 1000 / TIME_STEP_SECONDS);
  const submitted = Buffer.from(cleaned);

  let matched = false;
  for (let drift = -window; drift <= window; drift++) {
    const expected = Buffer.from(hotp(secret, step + drift, digits));
    // No early exit: every candidate is compared so the work does not depend
    // on which step matched.
    if (expected.length === submitted.length && timingSafeEqual(expected, submitted)) {
      matched = true;
    }
  }
  return matched;
}

/**
 * The `otpauth://` URI an authenticator app consumes.
 *
 * The issuer appears twice on purpose — once as a label prefix and once as a
 * parameter — because older apps read only one of the two.
 */
export function otpauthUri(input: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: String(TIME_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Formats a secret in groups of four, which is how people retype it. */
export function formatSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}

/**
 * The same `otpauth://` URI as a scannable PNG, base64 in a data URI.
 *
 * Every authenticator app accepts a typed setup key, so this is a convenience
 * rather than a requirement — but "point your camera at this" is the whole
 * difference between enrolling and giving up for someone who has never done
 * it. Rendered server-side so the browser never needs a QR library, and the
 * colours are fixed black-on-white because scanners want contrast, not theme
 * consistency.
 */
export async function otpauthQr(uri: string): Promise<string> {
  const { toDataURL } = await import('qrcode');
  return toDataURL(uri, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 232,
    color: { dark: '#000000', light: '#ffffff' },
  });
}

// ────────────────────────────────────────────────────────── recovery codes ──

/** Excludes characters that are misread on paper: 0/O, 1/I/L, U/V. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789';
export const RECOVERY_CODE_COUNT = 10;

/**
 * One-time codes for when the phone is gone.
 *
 * Two groups of five from a 29-character alphabet is a little over 48 bits,
 * which is far beyond guessable given they are also rate limited, and short
 * enough that someone will actually write them down.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let index = 0; index < count; index++) {
    const bytes = randomBytes(10);
    let code = '';
    for (let position = 0; position < 10; position++) {
      code += RECOVERY_ALPHABET[(bytes[position] as number) % RECOVERY_ALPHABET.length];
    }
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return codes;
}

/** Normalises what someone typed so case and dashes do not matter. */
export function normaliseRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}
