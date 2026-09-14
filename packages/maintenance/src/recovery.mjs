import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as tar from 'tar';
import { PrismaClient } from '@serverforge/db';
import { safeExtractTarget, portableGameLink, validateArchivePaths } from '@serverforge/core';
import { migrationFiles } from './migrate.mjs';
import { schemaState, schemaDifference } from './schema-state.mjs';

const GiB = 1024 ** 3;
export async function checksum(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
export async function freeSpace(directory, required = GiB) {
  let current = path.resolve(directory);
  while (!(await fs.stat(current).catch(() => null))) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('No writable parent directory.');
    current = parent;
  }
  const space = await fs.statfs(current);
  const available = Number(space.bavail) * Number(space.bsize);
  if (available < required + GiB)
    throw new Error(
      `Insufficient disk space: need ${Math.ceil((required + GiB) / GiB)} GiB including working space.`,
    );
  return available;
}
export function databaseEnvironment(databaseUrl) {
  const url = new URL(databaseUrl);
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGCONNECT_TIMEOUT: '10',
  };
}
export async function command(executable, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (data) => {
        output = (output + data).slice(-16000);
      });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              `${executable} failed (${code}): ${output.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[database URL]')}`,
            ),
          ),
    );
  });
}
export async function maintenanceRequest(action, body) {
  const base = process.env.API_INTERNAL_URL || 'http://api:8080';
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error('ENCRYPTION_KEY is required for host maintenance.');
  const token = createHmac('sha256', secret).update('serverforge-maintenance-v1').digest('hex');
  const response = await fetch(`${base}/api/internal/maintenance/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'Panel maintenance is unavailable.');
  return result;
}
export async function withMaintenance(kind, action, { hold = false } = {}) {
  let id;
  let held = false;
  let result;
  let failure;
  const timer = setInterval(
    () => void maintenanceRequest('heartbeat', { id }).catch(() => {}),
    10000,
  );
  try {
    const session = await maintenanceRequest('begin', { kind });
    id = session.id;
    const created = await action(session);
    held = hold;
    result = { ...created, ...(hold ? { maintenanceId: id } : {}) };
  } catch (error) {
    failure = error;
  }
  clearInterval(timer);
  if (id && !held) {
    try {
      const resumed = await maintenanceRequest('finish', { id });
      if (!resumed.ok)
        throw new Error(
          `Backup operation ended, but some games need manual restart: ${resumed.failedServerIds.join(', ')}`,
        );
    } catch (error) {
      if (failure) failure.message += ` Recovery also needs attention: ${error.message}`;
      else failure = error;
    }
  }
  if (failure) throw failure;
  return result;
}
async function inventory(directory) {
  let size = 0,
    count = 0;
  async function visit(file) {
    const stat = await fs.lstat(file);
    if (
      (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink())
    )
      throw new Error(
        `Recovery archives cannot contain links or special files: ${path.relative(directory, file)}`,
      );
    if (++count > 500000) throw new Error('Recovery source exceeds 500,000 files.');
    if (stat.isFile()) size += stat.size;
    else if (stat.isDirectory()) for (const child of await fs.readdir(file)) await visit(path.join(file, child));
  }
  await visit(directory);
  return { size, count };
}
async function archive(directory, file, serverUids = []) {
  const listed = await inventory(directory);
  await freeSpace(path.dirname(file), listed.size);
  let invalid;
  await tar.c(
    {
      cwd: directory,
      file,
      gzip: true,
      portable: true,
      strict: true,
      onWriteEntry(entry) {
        const prefix = path.posix.normalize(entry.path).split('/')[0];
        try {
          if (entry.type === 'SymbolicLink' && serverUids.includes(prefix))
            entry.linkpath = portableGameLink(entry.path, entry.linkpath || '', prefix);
        } catch (error) { invalid ||= error; }
      },
      filter(entry, stat) {
        if (invalid) return false;
        try {
          safeExtractTarget(directory, entry);
          if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink())
            throw new Error('Recovery source changed to a link or special file.');
          return true;
        } catch (error) {
          invalid = error;
          return false;
        }
      },
    },
    ['.'],
  );
  if (invalid) throw invalid;
  await fs.chmod(file, 0o600);
  return listed;
}
export async function validateArchive(file, target, expectedBytes = Infinity) {
  const entries = [];
  let bytes = 0,
    count = 0,
    invalid;
  await tar.t({
    file,
    strict: true,
    onReadEntry(entry) {
      try {
        safeExtractTarget(target, entry.path);
        entries.push({ path: entry.path, type: entry.type, linkpath: entry.linkpath });
        bytes += entry.size;
        if (++count > 500000 || bytes > expectedBytes)
          throw new Error('Recovery archive exceeds its declared size.');
      } catch (error) {
        invalid ||= error;
      }
    },
  });
  if (invalid) throw invalid;
  validateArchivePaths(entries);
  return bytes;
}

export async function verifyBundle(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Choose a recovery bundle directory.');
  const manifestFile = path.join(directory, 'manifest.json');
  if ((await fs.lstat(manifestFile)).isSymbolicLink())
    throw new Error('Recovery manifest cannot be a link.');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  if (
    manifest.format !== 'serverforge-recovery' ||
    manifest.version !== 1 ||
    manifest.complete !== true ||
    !['panel', 'full'].includes(manifest.kind)
  )
    throw new Error('Unknown or incomplete recovery bundle format.');
  const migrations = await migrationFiles();
  if (!migrations.some((migration) => migration.name === manifest.schemaVersion))
    throw new Error(
      'This release does not support the bundle’s database schema. Use the required application version.',
    );
  const allowed = new Set([
    'database.dump',
    'configuration.tar.gz',
    'servers.tar.gz',
    'game-backups.tar.gz',
    'themes.tar.gz',
    'games.tar.gz',
  ]);
  if (
    !Array.isArray(manifest.files) ||
    !manifest.files.some((file) => file.name === 'database.dump') ||
    !manifest.files.some((file) => file.name === 'configuration.tar.gz')
  )
    throw new Error('Recovery manifest is missing required files.');
  if (manifest.kind === 'full' && !manifest.files.some((file) => file.name === 'servers.tar.gz'))
    throw new Error('Full recovery bundle is missing game files.');
  if (
    !Array.isArray(manifest.servers) ||
    manifest.servers.some(
      (server) => !/^[a-zA-Z0-9_-]{1,64}$/.test(server.uid) || typeof server.id !== 'string',
    )
  )
    throw new Error('Invalid server identifiers in recovery manifest.');
  const seen = new Set();
  for (const file of manifest.files) {
    if (
      !allowed.has(file.name) ||
      seen.has(file.name) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !Number.isSafeInteger(file.expandedBytes) ||
      file.expandedBytes < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error('Invalid recovery file manifest.');
    seen.add(file.name);
    const filename = path.join(directory, file.name);
    const info = await fs.lstat(filename);
    if (
      !info.isFile() ||
      info.nlink > 1 ||
      info.size !== file.bytes ||
      (await checksum(filename)) !== file.sha256
    )
      throw new Error(`Recovery checksum failed: ${file.name}.`);
    if (file.name.endsWith('.tar.gz'))
      await validateArchive(filename, '/validated-recovery', file.expandedBytes);
  }
  await command('pg_restore', ['--list', path.join(directory, 'database.dump')]);
  return manifest;
}

export async function createBundle({
  kind = 'panel',
  recoveryRoot = process.env.RECOVERY_ROOT,
  configRoot = process.env.INSTALLATION_ROOT,
  databaseUrl = process.env.DATABASE_URL,
  paths = {},
  session = {},
} = {}) {
  if (!recoveryRoot || !configRoot || !databaseUrl)
    throw new Error('RECOVERY_ROOT, INSTALLATION_ROOT and DATABASE_URL are required.');
  if (
    path.resolve(configRoot) === path.resolve(recoveryRoot) ||
    path.resolve(recoveryRoot).startsWith(path.resolve(configRoot) + path.sep)
  )
    throw new Error('Keep recovery bundles outside the archived configuration directory.');
  await fs.mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(recoveryRoot, 0o700);
  await freeSpace(recoveryRoot);
  const id = `${kind}-${new Date().toISOString().replace(/[^0-9TZ]/g, '')}-${randomBytes(4).toString('hex')}`;
  const temporary = path.join(recoveryRoot, `.${id}.partial`);
  const complete = path.join(recoveryRoot, `${id}.sfr`);
  await fs.mkdir(temporary, { mode: 0o700 });
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const hasMigrations =
      await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='_prisma_migrations'`;
    let versions;
    if (hasMigrations.length)
      versions = await db.$queryRawUnsafe(
        'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY started_at',
      );
    else {
      const actual = await schemaState(db);
      const known = (await migrationFiles())
        .slice(0, 2)
        .find((migration) => !schemaDifference(migration.expected, actual).length);
      if (!known)
        throw new Error(
          'Cannot create an upgrade recovery bundle for an unknown legacy schema. Preserve a raw database dump and review schema drift first.',
        );
      versions = [{ migration_name: known.name }];
    }
    const servers = await db.server.findMany({
      select: {
        uid: true,
        id: true,
        gameId: true,
        variantId: true,
        version: true,
        build: true,
        javaMajor: true,
        dataPath: true,
      },
    });
    const manifest = {
      format: 'serverforge-recovery',
      version: 1,
      complete: true,
      id,
      kind,
      createdAt: new Date().toISOString(),
      applicationVersion: process.env.APP_VERSION || '0.1.0-rc.dev',
      schemaVersion: versions.at(-1)?.migration_name,
      images: {
        api: process.env.API_IMAGE || null,
        web: process.env.WEB_IMAGE || null,
        maintenance: process.env.MAINTENANCE_IMAGE || null,
      },
      paths,
      servers,
      previouslyRunning: session.runningIds || [],
      files: [],
    };
    const databaseSize =
      await db.$queryRaw`SELECT pg_database_size(current_database())::text AS bytes`;
    await freeSpace(recoveryRoot, Number(databaseSize[0].bytes));
    const dump = path.join(temporary, 'database.dump');
    await command(
      'pg_dump',
      ['--format=custom', '--no-owner', '--no-privileges', '--file', dump],
      databaseEnvironment(databaseUrl),
    );
    await fs.chmod(dump, 0o600);
    await command('pg_restore', ['--list', dump]);
    const add = async (name, expandedBytes) =>
      manifest.files.push({
        name,
        bytes: (await fs.stat(path.join(temporary, name))).size,
        expandedBytes,
        sha256: await checksum(path.join(temporary, name)),
      });
    await add('database.dump', Number(databaseSize[0].bytes));
    const configuration = await archive(configRoot, path.join(temporary, 'configuration.tar.gz'));
    await add('configuration.tar.gz', configuration.size);
    if (kind === 'full') {
      for (const [name, directory] of Object.entries(paths)) {
        if (!['servers', 'game-backups', 'themes', 'games'].includes(name))
          throw new Error('Unknown recovery source.');
        if (!directory) continue;
        const source = await archive(directory, path.join(temporary, `${name}.tar.gz`), name === 'servers' ? manifest.servers.map((server) => server.uid) : []);
        await add(`${name}.tar.gz`, source.size);
      }
    }
    await fs.writeFile(
      path.join(temporary, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    await verifyBundle(temporary);
    // If a panel restart expired this maintenance lease, games may have
    // resumed. Such a capture must never become a completed recovery bundle.
    if (session.id) await maintenanceRequest('heartbeat', { id: session.id });
    await fs.rename(temporary, complete);
    await db.setting.upsert({
      where: { key: 'recovery.lastSuccess' },
      create: { key: 'recovery.lastSuccess', value: { id, kind, at: manifest.createdAt } },
      update: { value: { id, kind, at: manifest.createdAt } },
    });
    await pruneBundles(recoveryRoot, kind, kind === 'full' ? 3 : 7);
    return { ok: true, id, directory: complete, kind, schemaVersion: manifest.schemaVersion };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    await db.setting
      .upsert({
        where: { key: 'recovery.lastFailure' },
        create: {
          key: 'recovery.lastFailure',
          value: { kind, at: new Date().toISOString(), message: error.message },
        },
        update: { value: { kind, at: new Date().toISOString(), message: error.message } },
      })
      .catch(() => {});
    throw error;
  } finally {
    await db.$disconnect();
  }
}
export async function pruneBundles(root, kind, keep) {
  const valid = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${kind}-`) || !entry.name.endsWith('.sfr'))
      continue;
    try {
      const manifest = await verifyBundle(path.join(root, entry.name));
      if (manifest.kind === kind) valid.push(entry.name);
    } catch {
      /* Invalid bundles cannot displace a good backup. */
    }
  }
  for (const name of valid.sort().reverse().slice(keep))
    await fs.rm(path.join(root, name), { recursive: true });
}
