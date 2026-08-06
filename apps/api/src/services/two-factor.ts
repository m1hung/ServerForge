import { prisma } from '@serverforge/db';
import { unauthorized } from '@serverforge/core';
import { decryptSecret, encryptSecret, generateToken, hashToken } from '../lib/crypto.js';
import { keys, redis } from '../lib/redis.js';
import {
  generateRecoveryCodes,
  normaliseRecoveryCode,
  verifyTotp,
} from '../lib/totp.js';

/**
 * Two-factor sign-in.
 *
 * The parts that are easy to get subtly wrong, in one place:
 *
 *   - a code that has been used cannot be used again inside its window, so
 *     one observed over a shoulder or captured by a phishing page is spent;
 *   - the pending ticket between password and code is single-use, expires in
 *     five minutes, and is destroyed after a handful of wrong guesses, because
 *     six digits is only a million possibilities;
 *   - a recovery code is removed when it is accepted, so each works once.
 *
 * The secret is encrypted at rest with the same AES-256-GCM helper as every
 * other stored secret, which means a database dump alone does not let someone
 * generate codes.
 */

const TICKET_TTL_SECONDS = 300;
const MAX_TICKET_ATTEMPTS = 5;
/** Slightly longer than the ±1 verification window, so a code cannot be reused. */
const CODE_REPLAY_TTL_SECONDS = 120;

export interface TwoFactorUser {
  id: string;
  totpSecret: string | null;
  totpEnabledAt: Date | null;
  recoveryCodeHashes: string[];
}

/** True when this account must answer a challenge after its password. */
export function requiresTwoFactor(user: {
  totpEnabledAt: Date | null;
  totpSecret: string | null;
}): boolean {
  return Boolean(user.totpEnabledAt && user.totpSecret);
}

// ─────────────────────────────────────────────────────────────── the ticket ──

/**
 * Issues the short-lived handle that stands between a correct password and a
 * session. It is deliberately not a session: holding one lets you do nothing
 * except present a second factor.
 */
export async function issueTicket(userId: string): Promise<string> {
  const ticket = generateToken('sf2fa');
  await redis.set(keys.twoFactorTicket(hashToken(ticket)), userId, 'EX', TICKET_TTL_SECONDS);
  return ticket;
}

export async function consumeTicket(ticket: string): Promise<string> {
  const key = keys.twoFactorTicket(hashToken(ticket));
  const userId = await redis.get(key);
  if (!userId) {
    throw unauthorized('That sign-in attempt expired. Enter your password again.');
  }
  return userId;
}

/** Counts a wrong guess, and burns the ticket once there have been too many. */
export async function countTicketFailure(ticket: string): Promise<void> {
  const hashed = hashToken(ticket);
  const attemptsKey = keys.twoFactorAttempts(hashed);
  const attempts = await redis.incr(attemptsKey);
  if (attempts === 1) await redis.expire(attemptsKey, TICKET_TTL_SECONDS);
  if (attempts >= MAX_TICKET_ATTEMPTS) {
    await redis.del(keys.twoFactorTicket(hashed));
  }
}

export async function discardTicket(ticket: string): Promise<void> {
  const hashed = hashToken(ticket);
  await redis.del(keys.twoFactorTicket(hashed), keys.twoFactorAttempts(hashed));
}

// ──────────────────────────────────────────────────────────────── the check ──

/**
 * Accepts an app code or a recovery code, and spends whichever it was.
 *
 * Returns how many recovery codes are left when one was used, so the caller
 * can warn someone who is running out — discovering you have none left at the
 * moment you need one is the failure mode worth designing against.
 */
export async function verifySecondFactor(
  user: TwoFactorUser,
  submitted: string,
): Promise<{ ok: boolean; usedRecoveryCode: boolean; recoveryCodesLeft: number }> {
  const miss = { ok: false, usedRecoveryCode: false, recoveryCodesLeft: user.recoveryCodeHashes.length };
  if (!user.totpSecret) return miss;

  const code = submitted.trim();

  // App code first: it is what almost everyone submits.
  if (/^\d{6}$/.test(code.replace(/\s/g, ''))) {
    let secret: string;
    try {
      secret = decryptSecret(user.totpSecret);
    } catch {
      // An undecryptable secret means ENCRYPTION_KEY changed. Failing closed
      // is right; the recovery codes below are the way back in.
      return miss;
    }

    if (!verifyTotp(secret, code)) return miss;

    // One-time really means one time: a replayed code is refused even though
    // it is still inside its 30-second window.
    const replayKey = keys.totpUsed(user.id, code.replace(/\s/g, ''));
    const fresh = await redis.set(replayKey, '1', 'EX', CODE_REPLAY_TTL_SECONDS, 'NX');
    if (fresh !== 'OK') return miss;

    return { ok: true, usedRecoveryCode: false, recoveryCodesLeft: user.recoveryCodeHashes.length };
  }

  // Otherwise treat it as a recovery code.
  const hashed = hashToken(normaliseRecoveryCode(code));
  if (!user.recoveryCodeHashes.includes(hashed)) return miss;

  const remaining = user.recoveryCodeHashes.filter((entry) => entry !== hashed);
  await prisma.user.update({
    where: { id: user.id },
    data: { recoveryCodeHashes: remaining },
  });

  return { ok: true, usedRecoveryCode: true, recoveryCodesLeft: remaining.length };
}

// ──────────────────────────────────────────────────────────────── enrolment ──

/** Stores an unconfirmed secret. Sign-in is unaffected until it is confirmed. */
export async function beginEnrolment(userId: string, secret: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { totpSecret: encryptSecret(secret), totpEnabledAt: null },
  });
}

/**
 * Confirms enrolment and issues recovery codes.
 *
 * The codes are returned in plaintext exactly once and stored only as hashes —
 * the same bargain as an API key, and for the same reason.
 */
export async function completeEnrolment(user: {
  id: string;
  totpSecret: string | null;
}): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      totpEnabledAt: new Date(),
      recoveryCodeHashes: codes.map((code) => hashToken(normaliseRecoveryCode(code))),
    },
  });
  return codes;
}

export async function disableTwoFactor(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { totpSecret: null, totpEnabledAt: null, recoveryCodeHashes: [] },
  });
}

export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await prisma.user.update({
    where: { id: userId },
    data: { recoveryCodeHashes: codes.map((code) => hashToken(normaliseRecoveryCode(code))) },
  });
  return codes;
}
