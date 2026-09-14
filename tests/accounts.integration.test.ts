import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@serverforge/db';
import { sha256 } from '../apps/api/src/lib/crypto.js';
import { totp } from '../apps/api/src/lib/totp.js';

if (!process.env.SF_TEST_PROJECT?.startsWith('serverforge-test-') || new URL(process.env.SF_TEST_DATABASE_URL!).pathname !== '/serverforge_test') throw new Error('Account integration tests require the isolated Compose runner.');
let app: FastifyInstance;
let cookie: string;
let ownerUid: string;
const password = 'integration-only password 123';
const proof = { password };
const request = (url: string, payload: object = {}, method: 'POST' | 'PATCH' | 'DELETE' = 'POST', auth = cookie) => app.inject({ method, url: `/api${url}`, payload, headers: auth ? { cookie: auth } : {} });
beforeAll(async () => { app = await (await import('../apps/api/src/app.js')).buildApp(); });
beforeEach(async () => {
  await prisma.server.deleteMany(); await prisma.node.deleteMany(); await prisma.invitation.deleteMany(); await prisma.user.deleteMany();
  const result = await request('/auth/register', { username: 'testowner', password, setupToken: process.env.SF_TEST_SETUP_TOKEN }, 'POST', '');
  expect(result.statusCode, result.body).toBe(200);
  cookie = result.cookies[0].name + '=' + result.cookies[0].value;
  ownerUid = result.json().user.uid;
});
afterAll(async () => { await app.close(); await prisma.$disconnect(); });
const invite = async (role = 'user', grants: object[] = []) => {
  const result = await request('/admin/invites', { role, grants });
  expect(result.statusCode, result.body).toBe(200);
  return { ...result.json(), token: result.json().path.split('#')[1] };
};

it('shows only the latest actionable installation failure in system status', async () => {
  const owner = await prisma.user.findUniqueOrThrow({ where: { uid: ownerUid } });
  const node = await prisma.node.create({ data: { uid: 'status-node', name: 'Status fixture' } });
  const server = await prisma.server.create({ data: { uid: 'status-server', ownerId: owner.id, nodeId: node.id, name: 'Status fixture', gameId: 'minecraft-java', variantId: 'vanilla', version: '1.20.1', memoryMib: 1024, cpuCores: 1, diskMib: 1024, dataPath: `${process.env.DATA_ROOT}/status-server`, state: 'install_failed' } });
  for (let index = 0; index < 2; index++) await prisma.installationAttempt.create({ data: { serverId: server.id, uid: `status-attempt-${index}`, state: 'failed', stagingPath: `${server.dataPath}/attempt-${index}`, createdAt: new Date(1000 + index), error: `Failure ${index}` } });
  const status = () => app.inject({ url: '/api/system/status', headers: { cookie } });
  expect((await status()).json().installations.map((row: { uid: string }) => row.uid)).toEqual(['status-attempt-1']);
  await prisma.server.update({ where: { id: server.id }, data: { state: 'offline', installedAt: new Date() } });
  expect((await status()).json().installations).toEqual([]);
  expect(await prisma.installationAttempt.count({ where: { serverId: server.id } })).toBe(2);
});

it('requires the owner setup token and makes invitation acceptance single-use even concurrently', async () => {
  const link = await invite();
  const row = await prisma.invitation.findUniqueOrThrow({ where: { uid: link.uid } });
  expect(row.tokenHash).toBe(sha256(link.token));
  expect(JSON.stringify(row)).not.toContain(link.token);
  expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(71 * 3600000);
  const results = await Promise.all(['friendone', 'friendtwo'].map((username) => request('/auth/invites/accept', { token: link.token, username, password }, 'POST', '')));
  expect(results.map((result) => result.statusCode).sort()).toEqual([200, 400]);
  expect(await prisma.user.count()).toBe(2);
  await prisma.user.deleteMany();
  expect((await request('/auth/register', { username: 'attack', password }, 'POST', '')).statusCode).toBe(403);
});
it('rejects expired, revoked, and unauthorized administrator invitations', async () => {
  const expired = await invite();
  await prisma.invitation.update({ where: { uid: expired.uid }, data: { expiresAt: new Date(0) } });
  expect((await request('/auth/invites/accept', { token: expired.token, username: 'expired', password }, 'POST', '')).statusCode).toBe(400);
  const revoked = await invite();
  expect((await request(`/admin/invites/${revoked.uid}`, {}, 'DELETE')).statusCode).toBe(200);
  expect((await request('/auth/invites/accept', { token: revoked.token, username: 'revoked', password }, 'POST', '')).statusCode).toBe(400);
  const administrator = await invite('admin');
  const accepted = await request('/auth/invites/accept', { token: administrator.token, username: 'administrator', password }, 'POST', '');
  const auth = accepted.cookies[0].name + '=' + accepted.cookies[0].value;
  expect((await request('/admin/invites', { role: 'admin' }, 'POST', auth)).statusCode).toBe(403);
  expect((await request(`/admin/users/${ownerUid}`, { ...proof, suspended: true }, 'PATCH', auth)).statusCode).toBe(403);
});
it('assigns invitation server permissions and enforces API-key scope ceilings', async () => {
  const owner = await prisma.user.findUniqueOrThrow({ where: { uid: ownerUid } });
  const node = await prisma.node.create({ data: { uid: 'local', name: 'Local' } });
  const server = await prisma.server.create({ data: { uid: 'access-test', ownerId: owner.id, nodeId: node.id, name: 'Access', gameId: 'minecraft-java', variantId: 'vanilla', version: '1.20.1', memoryMib: 1024, cpuCores: 1, diskMib: 1024, dataPath: `${process.env.DATA_ROOT}/access-test`, state: 'offline' } });
  const link = await invite('user', [{ serverUid: server.uid, permissions: ['server.view'] }]);
  const accepted = await request('/auth/invites/accept', { token: link.token, username: 'viewer', password }, 'POST', '');
  const viewer = await prisma.user.findUniqueOrThrow({ where: { username: 'viewer' } });
  expect((await prisma.serverUser.findUniqueOrThrow({ where: { serverId_userId: { serverId: server.id, userId: viewer.id } } })).permissions).toEqual(['server.view']);
  const viewerCookie = accepted.cookies[0].name + '=' + accepted.cookies[0].value;
  expect((await request('/account/api-keys', { ...proof, name: 'Escalation', scopes: ['admin'] }, 'POST', viewerCookie)).statusCode).toBe(400);
  const created = await request('/account/api-keys', { ...proof, name: 'Read only', scopes: ['server.view'] });
  const key = created.json().secret;
  expect(key).toMatch(/^sf_/);
  const headers = { authorization: `Bearer ${key}` };
  const detail = await app.inject({ url: '/api/servers/access-test', headers });
  expect(detail.statusCode).toBe(200);
  expect(detail.json().server.console).toMatchObject({ canRead: false, commands: [] });
  const ownerDetail = await app.inject({ url: '/api/servers/access-test', headers: { cookie } });
  expect(ownerDetail.json().server.console.commands).toContainEqual({ command: 'list', summary: 'Show who is online right now.', category: 'Server' });
  for (const gameId of ['palworld', 'valheim']) {
    await prisma.server.update({ where: { id: server.id }, data: { gameId, variantId: 'vanilla' } });
    const gameDetail = await app.inject({ url: '/api/servers/access-test', headers: { cookie } });
    expect(gameDetail.json().server.console.acceptsCommands).toBe(false);
    expect(gameDetail.json().server.console.commands.length).toBeGreaterThan(0);
  }
  expect((await app.inject({ url: '/api/nodes', headers })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/api/servers', headers, payload: {} })).statusCode).toBe(403);
  expect((await app.inject({ method: 'PATCH', url: '/api/servers/access-test/settings', headers, payload: { values: { motd: 'unauthorized change' } } })).statusCode).toBe(404);
  expect((await app.inject({ url: '/api/account/api-keys', headers })).statusCode).toBe(403);
  expect((await prisma.apiKey.findFirstOrThrow()).expiresAt!.getTime() - Date.now()).toBeGreaterThan(89 * 86400000);
});
it('protects the last owner and revokes access immediately on suspension', async () => {
  expect((await request(`/admin/users/${ownerUid}`, { ...proof, suspended: true }, 'PATCH')).statusCode).toBe(400);
  const link = await invite();
  const joined = await request('/auth/invites/accept', { token: link.token, username: 'suspendedfriend', password }, 'POST', '');
  const auth = joined.cookies[0].name + '=' + joined.cookies[0].value;
  expect((await request(`/admin/users/${joined.json().user.uid}`, { ...proof, suspended: true }, 'PATCH')).statusCode).toBe(200);
  expect((await app.inject({ url: '/api/me', headers: { cookie: auth } })).json().user).toBeNull();
});
it('enrolls TOTP, rejects replay, replaces recovery codes, and revokes sessions after password changes', async () => {
  expect((await request('/account/totp/enroll', { password: 'wrong' })).statusCode).toBe(401);
  const enrolled = await request('/account/totp/enroll', proof);
  const code = totp(enrolled.json().secret);
  const confirmed = await request('/account/totp/confirm', { ...proof, code });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  const codes = confirmed.json().recoveryCodes as string[];
  expect(codes).toHaveLength(10);
  expect((await request('/account/totp/recovery-codes', { ...proof, code })).statusCode).toBe(401);
  const regenerated = await request('/account/totp/recovery-codes', { ...proof, code: codes[0] });
  expect(regenerated.statusCode, regenerated.body).toBe(200);
  expect((await request('/account/totp/recovery-codes', { ...proof, code: codes[0] })).statusCode).toBe(401);
  const newCodes = regenerated.json().recoveryCodes;
  const passwordChange = await request('/account/password', { ...proof, code: newCodes[0], newPassword: 'a newly changed password 123' });
  expect(passwordChange.statusCode, passwordChange.body).toBe(200);
  expect(await prisma.session.count()).toBe(0);
  const audit = JSON.stringify(await prisma.auditLog.findMany());
  expect(audit).not.toContain(enrolled.json().secret);
  expect(audit).not.toContain(newCodes[0]);
  expect(audit).not.toContain(password);
});
