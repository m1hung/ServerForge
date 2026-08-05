import { hash, verify } from '@node-rs/argon2';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../config.js';

/**
 * All cryptography lives here so there is exactly one place to audit.
 *
 * Password hashing: Argon2id at the OWASP 2024 interactive baseline.
 * Tokens: 256 bits of entropy, stored only as SHA-256 — a database dump
 * therefore cannot be replayed as a session.
 */

const ARGON2_OPTIONS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain);
  } catch {
    // A malformed hash in the DB must read as "wrong password", never as a 500.
    return false;
  }
}

/** Opaque session/API token. Prefixed so leaked keys are greppable in logs. */
export function generateToken(prefix = 'sf'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ─────────────────────────────────────────────── secrets at rest (AES-GCM) ──

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function key(): Buffer {
  return Buffer.from(config.ENCRYPTION_KEY, 'hex');
}

/**
 * Encrypts a secret for storage. Output is `iv:tag:ciphertext` in base64url,
 * self-describing enough to rotate later without a schema change.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

export function decryptSecret(encoded: string): string {
  const [ivPart, tagPart, dataPart] = encoded.split(':');
  if (!ivPart || !tagPart || !dataPart) throw new Error('Malformed encrypted value');

  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('Malformed encrypted value');
  }

  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function sha256File(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
