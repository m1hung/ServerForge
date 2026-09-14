import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '/app/packages/db/dist/index.js';
import { migrateDatabase } from '/app/packages/maintenance/src/migrate.mjs';
import { createBundle, verifyBundle } from '/app/packages/maintenance/src/recovery.mjs';
import { restoreBundle } from '/app/packages/maintenance/src/restore.mjs';

const prefix = `sf_recovery_${randomBytes(6).toString('hex')}`;
const adminUrl = new URL(process.env.DATABASE_URL);
assert.equal(adminUrl.username, 'serverforge_test');
assert.equal(adminUrl.pathname, '/serverforge_test');
const admin = new PrismaClient();
const clients = [];
const databases = [];
async function database(suffix) {
  const name = `${prefix}_${suffix}`;
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  databases.push(name);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = new PrismaClient({ datasources: { db: { url: url.href } } });
  clients.push(db);
  return { db, url: url.href };
}
const root = `/test/${prefix}`;
await fs.mkdir(root, { mode: 0o700 });
try {
  const source = await database('source');
  await migrateDatabase(source.url);
  const config = path.join(root, 'source-config');
  await fs.mkdir(config);
  await fs.writeFile(path.join(config, '.env'), `ENCRYPTION_KEY=${'ab'.repeat(32)}\nSESSION_SECRET=${'cd'.repeat(32)}\nTS_AUTHKEY=must-not-restore\n`);
  const sourcePaths = Object.fromEntries(['servers', 'game-backups', 'themes', 'games'].map((name) => [name, path.join(root, 'source', name)]));
  for (const directory of Object.values(sourcePaths)) await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(path.join(sourcePaths.servers, 'world-fixture/world'), { recursive: true });
  await fs.writeFile(path.join(sourcePaths.servers, 'world-fixture/world/level.dat'), 'WORLD-CONTENT-FIXTURE');
  await fs.mkdir(path.join(sourcePaths.servers, 'world-fixture/.local/share/Steam'), { recursive: true });
  await fs.mkdir(path.join(sourcePaths.servers, 'world-fixture/.steam'));
  await fs.writeFile(path.join(sourcePaths.servers, 'world-fixture/.local/share/Steam/proof'), 'STEAM-LINK-FIXTURE');
  await fs.symlink('/home/container/.local/share/Steam', path.join(sourcePaths.servers, 'world-fixture/.steam/root'));
  await fs.writeFile(path.join(sourcePaths.games, 'custom.json'), '{"name":"Custom manifest"}');
  const owner = await source.db.user.create({ data: { id: 'preserved-owner', uid: 'owner-uid', username: 'owner', displayName: 'Owner', passwordHash: 'preserved-argon2-hash', role: 'owner', totpSecret: 'preserved-encrypted-secret', totpEnabledAt: new Date() } });
  const node = await source.db.node.create({ data: { uid: 'local', name: 'Local', dataRoot: sourcePaths.servers } });
  await source.db.server.create({ data: { uid: 'world-fixture', name: 'World fixture', ownerId: owner.id, nodeId: node.id, gameId: 'minecraft-java', variantId: 'vanilla', version: '1.20.1', memoryMib: 1024, cpuCores: 1, diskMib: 2048, dataPath: path.join(sourcePaths.servers, 'world-fixture'), state: 'running', containerId: 'stale-container', publicAccess: true } });
  await source.db.session.create({ data: { tokenHash: 'old-session', userId: owner.id, expiresAt: new Date(Date.now() + 86400000) } });
  await source.db.apiKey.create({ data: { uid: 'old-key', name: 'Old key', tokenHash: 'old-key-hash', prefix: 'sf_old', userId: owner.id } });
  await source.db.invitation.create({ data: { uid: 'old-invite', tokenHash: 'old-invitation-hash', inviterId: owner.id, expiresAt: new Date(Date.now() + 86400000) } });
  await source.db.setting.create({ data: { key: 'network.configuration', value: { upnpEnabled: true, verifiedDashboardUrl: 'https://old.ts.net' } } });
  const bundle = await createBundle({ kind: 'full', recoveryRoot: path.join(root, 'bundles'), configRoot: config, databaseUrl: source.url, paths: sourcePaths });
  assert.equal((await verifyBundle(bundle.directory)).kind, 'full');
  assert.equal((await fs.stat(bundle.directory)).mode & 0o777, 0o700);
  const target = await database('target');
  const targetPaths = Object.fromEntries(Object.keys(sourcePaths).map((name) => [name, path.join(root, 'target', name)]));
  const targetConfig = path.join(root, 'target-config');
  process.env.SF_OFFLINE_MAINTENANCE = '1';
  const restored = await restoreBundle(bundle.directory, { databaseUrl: target.url, configRoot: targetConfig, paths: targetPaths, hostDataRoot: targetPaths.servers, hostBackupRoot: targetPaths['game-backups'] });
  assert.equal(restored.gamesOffline, true);
  assert.equal(await fs.readFile(path.join(targetPaths.servers, 'world-fixture/world/level.dat'), 'utf8'), 'WORLD-CONTENT-FIXTURE');
  assert.equal(await fs.readlink(path.join(targetPaths.servers, 'world-fixture/.steam/root')), '../.local/share/Steam');
  assert.equal(await fs.readFile(path.join(targetPaths.servers, 'world-fixture/.steam/root/proof'), 'utf8'), 'STEAM-LINK-FIXTURE');
  assert.equal(await target.db.session.count(), 0);
  assert.ok((await target.db.apiKey.findFirst()).revokedAt);
  assert.ok((await target.db.invitation.findUnique({ where: { uid: 'old-invite' } })).revokedAt);
  const recoveredOwner = await target.db.user.findUnique({ where: { id: owner.id } });
  assert.equal(recoveredOwner.passwordHash, 'preserved-argon2-hash');
  assert.equal(recoveredOwner.totpSecret, 'preserved-encrypted-secret');
  const game = await target.db.server.findUnique({ where: { uid: 'world-fixture' } });
  assert.equal(game.state, 'offline');
  assert.equal(game.containerId, null);
  assert.equal(game.publicAccess, false);
  assert.equal(game.dataPath, path.join(targetPaths.servers, 'world-fixture'));
  const environment = await fs.readFile(path.join(targetConfig, '.env'), 'utf8');
  assert.ok(environment.includes('BIND_HOST="127.0.0.1"'));
  assert.ok(!environment.includes('must-not-restore'));
  assert.ok(!await target.db.setting.findUnique({ where: { key: 'network.configuration' } }));
  await assert.rejects(restoreBundle(bundle.directory, { databaseUrl: target.url, configRoot: targetConfig, paths: targetPaths, hostDataRoot: targetPaths.servers }), /empty destination database/);
  // Explicit rollback restores the complete old panel snapshot. Newer tables
  // and foreign keys must not survive or prevent restoration of old tables.
  const panel = await createBundle({ kind: 'panel', recoveryRoot: path.join(root, 'bundles'), configRoot: config, databaseUrl: source.url, paths: sourcePaths });
  await target.db.$executeRawUnsafe('CREATE TABLE "NewReleaseOnly" (id text PRIMARY KEY, "userId" text REFERENCES "User"(id))');
  await target.db.$executeRawUnsafe('INSERT INTO "NewReleaseOnly" VALUES (\'temporary\',\'preserved-owner\')');
  await restoreBundle(panel.directory, { databaseUrl: target.url, configRoot: targetConfig, paths: targetPaths, hostDataRoot: targetPaths.servers, replacePanel: true });
  assert.equal((await target.db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='NewReleaseOnly'`).length, 0);
  assert.equal((await target.db.user.findUnique({ where: { id: owner.id } })).passwordHash, 'preserved-argon2-hash');
  assert.equal(await fs.readFile(path.join(targetPaths.servers, 'world-fixture/world/level.dat'), 'utf8'), 'WORLD-CONTENT-FIXTURE');
  // A corrupt bundle must fail before touching a fresh destination.
  await fs.appendFile(path.join(bundle.directory, 'database.dump'), 'CORRUPTION');
  const untouched = await database('untouched');
  await assert.rejects(restoreBundle(bundle.directory, { databaseUrl: untouched.url, configRoot: path.join(root, 'untouched-config'), paths: targetPaths, hostDataRoot: targetPaths.servers }), /checksum failed/);
  assert.equal((await untouched.db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public'`).length, 0);
  console.log(JSON.stringify({ ok: true, checks: ['full-bundle-verification', 'fresh-database-restore', 'world-fixture-content', 'account-and-TOTP-preservation', 'session-and-key-revocation', 'invitation-revocation', 'path-remapping', 'games-offline', 'external-exposure-disabled', 'existing-target-refusal', 'corruption-refusal', 'transactional-panel-rollback-removes-newer-schema-objects'], gameQualification: 'Fixture files only; real-game startup qualification is separate.' }));
} finally {
  for (const db of clients) await db.$disconnect();
  for (const name of databases) await admin.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.$disconnect();
}
