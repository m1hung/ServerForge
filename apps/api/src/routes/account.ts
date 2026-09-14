import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { prisma, uid } from '@serverforge/db';
import { API_KEY_SCOPES, passwordSchema, badRequest } from '@serverforge/core';
import { config } from '../lib/config.js';
import { clearSessionCookie } from '../plugins/auth.js';
import { randomToken, sha256, hashPassword, encryptSecret, decryptSecret } from '../lib/crypto.js';
import { generateSecret, generateRecoveryCodes, normaliseRecoveryCode, matchingTotpCounter, otpauthUri, otpauthQr } from '../lib/totp.js';
import { audit, proofSchema, sessionUser, withAccountProof } from '../services/account-security.js';
import { closeConsoleStreams } from '../services/console-stream.js';

export async function accountRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.get('/account', async (request) => {
    const actor = sessionUser(request);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { uid: true, username: true, displayName: true, role: true, createdAt: true, totpEnabledAt: true, recoveryCodeHashes: true } });
    const { recoveryCodeHashes, ...visible } = user;
    return { user: { ...visible, recoveryCodesRemaining: recoveryCodeHashes.length } };
  });
  app.post('/account/password', async (request, reply) => {
    const body = proofSchema.extend({ newPassword: passwordSchema }).parse(request.body);
    await withAccountProof(request, body, async (tx, user) => {
      const passwordHash = await hashPassword(body.newPassword);
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: user.id } });
      await audit(tx, request, 'account.password_changed', 'user', user.id);
    });
    closeConsoleStreams(); clearSessionCookie(reply);
    return { ok: true, signInRequired: true };
  });
  app.get('/account/sessions', async (request) => {
    const user = sessionUser(request);
    const current = sha256(request.cookies.sf_session || request.headers.authorization?.replace(/^Bearer /, '') || '');
    const rows = await prisma.session.findMany({ where: { userId: user.id, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, take: 100 });
    return { sessions: rows.map(({ tokenHash, userId: _userId, ...row }) => ({ ...row, current: tokenHash === current })) };
  });
  app.delete('/account/sessions/:id', async (request) => {
    const { id } = z.object({ id: z.string().max(128) }).parse(request.params);
    await withAccountProof(request, proofSchema.parse(request.body), async (tx, user) => {
      await tx.session.deleteMany({ where: { userId: user.id, ...(id === 'all' ? {} : { id }) } });
      await audit(tx, request, 'account.session_revoked', 'user', user.id, { all: id === 'all' });
    });
    closeConsoleStreams(); return { ok: true };
  });
  app.post('/account/totp/enroll', async (request) => {
    const secret = generateSecret();
    const user = await withAccountProof(request, proofSchema.parse(request.body), async (tx, user) => {
      if (user.totpEnabledAt) throw badRequest('Two-factor authentication is already enabled.');
      await tx.user.update({ where: { id: user.id }, data: { totpSecret: encryptSecret(secret), totpLastCounter: null } });
      await audit(tx, request, 'account.totp_enrollment_started', 'user', user.id);
      return user;
    });
    const uri = otpauthUri({ secret, account: user.username, issuer: config.brand.name });
    return { secret, uri, qr: await otpauthQr(uri) };
  });
  app.post('/account/totp/confirm', async (request) => {
    const body = proofSchema.extend({ code: z.string().min(6).max(32) }).parse(request.body);
    const recoveryCodes = generateRecoveryCodes();
    await withAccountProof(request, body, async (tx, user) => {
      if (user.totpEnabledAt || !user.totpSecret) throw badRequest('Start a new authenticator enrollment first.');
      const counter = matchingTotpCounter(decryptSecret(user.totpSecret), body.code);
      if (counter === null) throw badRequest('That authenticator code is incorrect.');
      await tx.user.update({ where: { id: user.id }, data: { totpEnabledAt: new Date(), totpLastCounter: counter, recoveryCodeHashes: recoveryCodes.map((code) => sha256(normaliseRecoveryCode(code))) } });
      await audit(tx, request, 'account.totp_enabled', 'user', user.id);
    });
    return { ok: true, recoveryCodes };
  });
  app.post('/account/totp/recovery-codes', async (request) => {
    const recoveryCodes = generateRecoveryCodes();
    await withAccountProof(request, proofSchema.parse(request.body), async (tx, user) => {
      if (!user.totpEnabledAt) throw badRequest('Enable two-factor authentication first.');
      await tx.user.update({ where: { id: user.id }, data: { recoveryCodeHashes: recoveryCodes.map((code) => sha256(normaliseRecoveryCode(code))) } });
      await audit(tx, request, 'account.recovery_codes_regenerated', 'user', user.id);
    });
    return { recoveryCodes };
  });
  app.delete('/account/totp', async (request) => {
    await withAccountProof(request, proofSchema.parse(request.body), async (tx, user) => {
      await tx.user.update({ where: { id: user.id }, data: { totpSecret: null, totpEnabledAt: null, totpLastCounter: null, recoveryCodeHashes: [] } });
      await tx.session.deleteMany({ where: { userId: user.id } });
      await audit(tx, request, 'account.totp_removed', 'user', user.id);
    });
    closeConsoleStreams(); return { ok: true, signInRequired: true };
  });
  app.get('/account/api-keys', async (request) => {
    const user = sessionUser(request);
    const keys = await prisma.apiKey.findMany({ where: { userId: user.id }, select: { uid: true, name: true, prefix: true, scopes: true, expiresAt: true, lastUsedAt: true, revokedAt: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 100 });
    return { keys, availableScopes: API_KEY_SCOPES.filter((scope) => user.role !== 'user' || !['*', 'admin'].includes(scope)) };
  });
  app.post('/account/api-keys', async (request) => {
    const body = proofSchema.extend({ name: z.string().trim().min(1).max(100), scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length), expiresInDays: z.number().int().min(1).max(365).default(90) }).parse(request.body);
    const secret = `sf_${randomToken()}`;
    const key = await withAccountProof(request, body, async (tx, user) => {
      if (user.role === 'user' && body.scopes.some((scope) => ['*', 'admin'].includes(scope))) throw badRequest('Ordinary users can create server-scoped keys only.');
      if (await tx.apiKey.count({ where: { userId: user.id, revokedAt: null } }) >= 25) throw badRequest('Revoke an existing key before creating another.');
      const key = await tx.apiKey.create({ data: { uid: uid(), name: body.name, scopes: [...new Set(body.scopes)], tokenHash: sha256(secret), prefix: secret.slice(0, 11), userId: user.id, expiresAt: new Date(Date.now() + body.expiresInDays * 86400000) } });
      await audit(tx, request, 'account.api_key_created', 'apiKey', key.id, { scopes: key.scopes, expiresAt: key.expiresAt!.toISOString() });
      return key;
    });
    return { secret, uid: key.uid, expiresAt: key.expiresAt };
  });
  app.delete('/account/api-keys/:uid', async (request) => {
    const { uid } = z.object({ uid: z.string().max(64) }).parse(request.params);
    await withAccountProof(request, proofSchema.parse(request.body), async (tx, user) => {
      await tx.apiKey.updateMany({ where: { userId: user.id, uid }, data: { revokedAt: new Date() } });
      await audit(tx, request, 'account.api_key_revoked', 'apiKey', uid);
    });
    closeConsoleStreams(); return { ok: true };
  });
}
