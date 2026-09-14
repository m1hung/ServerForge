import { prisma, type Prisma, type User } from '@serverforge/db';
import { z } from 'zod';
import { forbidden, tooManyRequests, unauthorized } from '@serverforge/core';
import type { FastifyRequest } from 'fastify';
import { requireUser } from '../plugins/auth.js';
import { decryptSecret, sha256, verifyPassword } from '../lib/crypto.js';
import { matchingTotpCounter, normaliseRecoveryCode } from '../lib/totp.js';

export const proofSchema = z.object({ password: z.string().min(1).max(200), code: z.string().max(32).optional() });
const attempts = new Map<string, { count: number; until: number }>();
export function accountRateLimit(key: string, limit = 15) {
  const now = Date.now();
  for (const [id, value] of attempts) if (value.until <= now) attempts.delete(id);
  if (attempts.size > 10000) throw tooManyRequests('Too many requests. Try again later.');
  const value = attempts.get(key) ?? { count: 0, until: now + 60000 };
  if (++value.count > limit) throw tooManyRequests('Too many attempts. Wait one minute before trying again.');
  attempts.set(key, value);
}
export function sessionUser(request: FastifyRequest) {
  const user = requireUser(request);
  if (user.scopes) throw forbidden('Sign in with your account to manage security settings.');
  return user;
}
export async function consumeSecondFactor(tx: Prisma.TransactionClient, user: User, code = '') {
  const recovery = sha256(normaliseRecoveryCode(code));
  if (user.recoveryCodeHashes.includes(recovery)) {
    await tx.user.update({ where: { id: user.id }, data: { recoveryCodeHashes: user.recoveryCodeHashes.filter((hash) => hash !== recovery) } });
    return;
  }
  const counter = user.totpSecret ? matchingTotpCounter(decryptSecret(user.totpSecret), code) : null;
  if (counter === null || counter <= (user.totpLastCounter ?? -1)) throw unauthorized('Enter a fresh authenticator code or an unused recovery code.');
  await tx.user.update({ where: { id: user.id }, data: { totpLastCounter: counter } });
}
export async function withAccountProof<T>(request: FastifyRequest, proof: z.infer<typeof proofSchema>, action: (tx: Prisma.TransactionClient, user: User) => Promise<T>) {
  const actor = sessionUser(request);
  accountRateLimit(`proof:${actor.id}`);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(193608, hashtext(${actor.id}))`;
    const user = await tx.user.findUnique({ where: { id: actor.id } });
    if (!user || user.suspended || !await verifyPassword(user.passwordHash, proof.password)) throw unauthorized('Your current password is incorrect.');
    if (user.totpEnabledAt) await consumeSecondFactor(tx, user, proof.code);
    return action(tx, user);
  });
}
export async function audit(tx: Prisma.TransactionClient, request: FastifyRequest, action: string, targetType: string, targetId?: string, metadata?: Prisma.InputJsonValue) {
  await tx.auditLog.create({ data: { actorId: request.user?.id, action, targetType, targetId, ip: request.ip, ...(metadata ? { metadata } : {}) } });
}
