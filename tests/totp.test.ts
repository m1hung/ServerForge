import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  formatSecret,
  generateRecoveryCodes,
  generateSecret,
  hotp,
  normaliseRecoveryCode,
  otpauthUri,
  totp,
  verifyTotp,
} from '../apps/api/src/lib/totp.js';

/**
 * This is a hand-written implementation of two specs, so it is checked against
 * the specs' own published vectors rather than against itself.
 */

describe('base32 (RFC 4648 §10)', () => {
  const vectors: [string, string][] = [
    ['', ''],
    ['f', 'MY======'],
    ['fo', 'MZXQ===='],
    ['foo', 'MZXW6==='],
    ['foob', 'MZXW6YQ='],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI======'],
  ];

  it.each(vectors)('encodes %j', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(encoded);
  });

  it.each(vectors)('decodes back to %j', (plain, encoded) => {
    expect(base32Decode(encoded).toString()).toBe(plain);
  });

  it('forgives the spacing and case people type', () => {
    expect(base32Decode('mzxw 6ytb').toString()).toBe('fooba');
    expect(base32Decode('MZXW-6YTB').toString()).toBe('fooba');
  });

  it('rejects a character outside the alphabet', () => {
    expect(() => base32Decode('MZXW6YT!')).toThrow();
    // 0, 1 and 8 are not in the base32 alphabet.
    expect(() => base32Decode('MZXW6YT0')).toThrow();
  });
});

/**
 * RFC 6238 Appendix B. The published table is for 8-digit codes with the ASCII
 * secret "12345678901234567890"; the 6-digit values are its last six digits,
 * which is what an authenticator app actually shows.
 */
describe('TOTP (RFC 6238 Appendix B)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  const vectors: [number, string, string][] = [
    [59, '94287082', '287082'],
    [1111111109, '07081804', '081804'],
    [1111111111, '14050471', '050471'],
    [1234567890, '89005924', '005924'],
    [2000000000, '69279037', '279037'],
    [20000000000, '65353130', '353130'],
  ];

  it.each(vectors)('at t=%i produces %s', (seconds, eightDigits, sixDigits) => {
    expect(totp(secret, seconds * 1000, 8)).toBe(eightDigits);
    expect(totp(secret, seconds * 1000, 6)).toBe(sixDigits);
  });

  it('steps every 30 seconds and not before', () => {
    const base = 1_700_000_000_000 - (1_700_000_000_000 % 30_000);
    expect(totp(secret, base)).toBe(totp(secret, base + 29_999));
    expect(totp(secret, base)).not.toBe(totp(secret, base + 30_000));
  });

  it('handles a counter above 2^32, which 8-byte framing is there for', () => {
    // t=20000000000 is counter 666666666, but this pins the wide path itself.
    expect(() => hotp(secret, 2 ** 35)).not.toThrow();
    expect(hotp(secret, 2 ** 35)).toMatch(/^\d{6}$/);
  });
});

describe('verifyTotp', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const now = 1111111109 * 1000;

  it('accepts the current code', () => {
    expect(verifyTotp(secret, '081804', { atMs: now })).toBe(true);
  });

  it('accepts a code from one step either side, for clock drift', () => {
    const previous = totp(secret, now - 30_000);
    const next = totp(secret, now + 30_000);
    expect(verifyTotp(secret, previous, { atMs: now })).toBe(true);
    expect(verifyTotp(secret, next, { atMs: now })).toBe(true);
  });

  it('refuses a code two steps away', () => {
    const stale = totp(secret, now - 60_000);
    expect(verifyTotp(secret, stale, { atMs: now })).toBe(false);
  });

  it('can be told not to allow any drift', () => {
    const previous = totp(secret, now - 30_000);
    expect(verifyTotp(secret, previous, { atMs: now, window: 0 })).toBe(false);
  });

  it('ignores spaces, since apps display codes as "081 804"', () => {
    expect(verifyTotp(secret, '081 804', { atMs: now })).toBe(true);
  });

  it('rejects anything that is not six digits', () => {
    expect(verifyTotp(secret, '', { atMs: now })).toBe(false);
    expect(verifyTotp(secret, '81804', { atMs: now })).toBe(false);
    expect(verifyTotp(secret, '0818040', { atMs: now })).toBe(false);
    expect(verifyTotp(secret, 'abcdef', { atMs: now })).toBe(false);
  });

  it('rejects a wrong code', () => {
    expect(verifyTotp(secret, '000000', { atMs: now })).toBe(false);
  });
});

describe('generateSecret', () => {
  it('produces 160 bits, unpadded, in the base32 alphabet', () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it('does not repeat', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateSecret()));
    expect(secrets.size).toBe(50);
  });

  it('round-trips through the code generator', () => {
    const secret = generateSecret();
    expect(verifyTotp(secret, totp(secret))).toBe(true);
  });
});

describe('otpauthUri', () => {
  it('carries the issuer in both places apps look for it', () => {
    const uri = otpauthUri({ secret: 'ABCD', account: 'will', issuer: 'ServerForge' });
    expect(uri.startsWith('otpauth://totp/ServerForge%3Awill?')).toBe(true);
    expect(uri).toContain('issuer=ServerForge');
    expect(uri).toContain('secret=ABCD');
    expect(uri).toContain('period=30');
  });

  it('escapes a name that would otherwise break the URI', () => {
    const uri = otpauthUri({ secret: 'ABCD', account: 'a b/c', issuer: 'My Panel' });
    expect(uri).not.toContain(' ');
    expect(() => new URL(uri)).not.toThrow();
  });
});

describe('formatSecret', () => {
  it('groups in fours for retyping', () => {
    expect(formatSecret('ABCDEFGH')).toBe('ABCD EFGH');
  });

  it('survives a length that is not a multiple of four', () => {
    expect(formatSecret('ABCDE')).toBe('ABCD E');
  });
});

describe('recovery codes', () => {
  it('makes ten distinct codes by default', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });

  it('avoids characters that are misread on paper', () => {
    const codes = generateRecoveryCodes(200).join('');
    expect(codes).not.toMatch(/[01ILOUV]/);
  });

  it('normalises the ways someone might retype one', () => {
    const [code] = generateRecoveryCodes(1) as [string];
    expect(normaliseRecoveryCode(code.toLowerCase())).toBe(normaliseRecoveryCode(code));
    expect(normaliseRecoveryCode(code.replace('-', ' '))).toBe(normaliseRecoveryCode(code));
    expect(normaliseRecoveryCode(code)).not.toContain('-');
  });
});
