import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as tar from 'tar';
import { PrismaClient } from '@serverforge/db';
import { verifyBundle, freeSpace, command, databaseEnvironment } from './recovery.mjs';
import { migrateDatabase } from './migrate.mjs';
import { parseEnv } from './environment.mjs';

// Fresh destinations make full recovery reviewable: the old host and worlds
// remain intact until the operator chooses to switch to the recovered install.
export async function restoreBundle(
  directory,
  {
    databaseUrl = process.env.DATABASE_URL,
    configRoot = process.env.INSTALLATION_ROOT,
    paths = {},
    hostDataRoot = process.env.HOST_DATA_ROOT,
    hostBackupRoot = process.env.HOST_BACKUP_ROOT,
    replacePanel = false,
  } = {},
) {
  if (process.env.SF_OFFLINE_MAINTENANCE !== '1')
    throw new Error('Stop the panel through the host launcher before restoring.');
  const manifest = await verifyBundle(directory);
  if (!databaseUrl || !configRoot || !hostDataRoot)
    throw new Error(
      'Choose the destination database, configuration, and host data directory explicitly.',
    );
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const job = randomBytes(8).toString('hex');
  const stages = [];
  const moved = [];
  let databaseRestored = false;
  try {
    const existing = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
    if (existing.length && !(replacePanel && manifest.kind === 'panel'))
      throw new Error(
        'Fresh-host restore requires an empty destination database. Existing installations stay intact; choose a fresh Compose project.',
      );
    const total = manifest.files.reduce((bytes, file) => bytes + file.expandedBytes, 0);
    await freeSpace(configRoot, total);
    for (const file of manifest.files.filter((file) => file.name.endsWith('.tar.gz'))) {
      const name = file.name.slice(0, -7);
      const destination = name === 'configuration' ? configRoot : paths[name];
      if (!destination) throw new Error(`Select a destination for ${name}.`);
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      const entries = await fs.readdir(destination);
      if (name !== 'configuration' && entries.length)
        throw new Error(`Recovery destination must be empty: ${destination}.`);
      if (
        name === 'configuration' &&
        !replacePanel &&
        entries.some(
          (entry) =>
            ![
              '.env',
              'compose.yml',
              'images.env',
              'serverforge',
              'release.json',
              'tailscale-entrypoint.sh',
            ].includes(entry),
        )
      )
        throw new Error(
          'Configuration destination contains unrelated files. Choose a fresh installation directory.',
        );
      await freeSpace(destination, file.expandedBytes);
      const staged = path.join(destination, `.restore-${job}`);
      await fs.mkdir(staged, { mode: 0o700 });
      stages.push({ name, destination, staged });
      await tar.x({
        file: path.join(directory, file.name),
        cwd: staged,
        strict: true,
        noChmod: true,
        noMtime: true,
      });
    }
    const configuration = stages.find((stage) => stage.name === 'configuration');
    const envPath = path.join(configuration.staged, '.env');
    let environment = await fs.readFile(envPath, 'utf8');
    if (!/^ENCRYPTION_KEY\s*=\s*.+$/m.test(environment))
      throw new Error('Recovery configuration is missing the encryption key.');
    const targetUrl = new URL(databaseUrl);
    const targetConfig = parseEnv(
      await fs.readFile(path.join(configRoot, '.env'), 'utf8').catch(() => ''),
    );
    const overrides = replacePanel
      ? {}
      : {
          DATABASE_URL: databaseUrl,
          POSTGRES_USER: decodeURIComponent(targetUrl.username),
          POSTGRES_PASSWORD: decodeURIComponent(targetUrl.password),
          POSTGRES_DB: decodeURIComponent(targetUrl.pathname.slice(1)),
          HOST_DATA_ROOT: hostDataRoot,
          HOST_BACKUP_ROOT: hostBackupRoot || '',
          BIND_HOST: '127.0.0.1',
          UPNP_ENABLED: 'false',
          TS_AUTHKEY: '',
          HOST_THEMES_ROOT: targetConfig.HOST_THEMES_ROOT || paths.themes || '',
          HOST_GAMES_ROOT: targetConfig.HOST_GAMES_ROOT || paths.games || '',
          HOST_CONFIG_ROOT: targetConfig.HOST_CONFIG_ROOT || configRoot,
          ...Object.fromEntries(
            [
              'COMPOSE_PROJECT_NAME',
              'HOST_CACHE_ROOT',
              'HOST_RECOVERY_ROOT',
              'DOCKER_SOCKET_FILE',
              'WEB_PORT',
              'API_IMAGE',
              'WEB_IMAGE',
              'MAINTENANCE_IMAGE',
              'APP_VERSION',
              'BRAND_RESOURCE_PREFIX',
              'POSTGRES_IMAGE',
              'POSTGRES_VOLUME',
            ]
              .filter((key) => targetConfig[key])
              .map((key) => [key, targetConfig[key]]),
          ),
          SESSION_SECRET: randomBytes(32).toString('hex'),
          COOKIE_SECURE: 'false',
          DASHBOARD_SCHEME: 'http',
          CORS_ORIGINS: `http://localhost:${targetConfig.WEB_PORT || '3000'},http://127.0.0.1:${targetConfig.WEB_PORT || '3000'}`,
        };
    for (const [key, value] of Object.entries(overrides)) {
      environment = environment.replace(new RegExp(`^${key}=.*(?:\\r?\\n|$)`, 'gm'), '');
      environment += `${key}=${JSON.stringify(value).replaceAll('$', '$$')}\n`;
    }
    await fs.writeFile(envPath, environment, { mode: 0o600 });
    if (!replacePanel) {
      // The destination release owns its Compose layout and image inventory.
      // Only panel data and required secrets come from the recovered host.
      for (const name of ['release.json', 'compose.yml', 'tailscale-entrypoint.sh']) {
        const contents = await fs.readFile(path.join(configRoot, name)).catch(() => null);
        if (contents) await fs.writeFile(path.join(configuration.staged, name), contents, { mode: 0o600 });
      }
      for (const name of ['upgrade.json', 'source.env.before-adoption'])
        await fs.rm(path.join(configuration.staged, name), { force: true });
    }
    // Files are installed only into validated empty destinations. If the
    // transaction fails, remove exactly these new entries, never old worlds.
    for (const stage of stages.filter((stage) => stage.name !== 'configuration')) {
      for (const entry of await fs.readdir(stage.staged)) {
        const target = path.join(stage.destination, entry);
        await fs.rename(path.join(stage.staged, entry), target);
        moved.push(target);
      }
    }
    if (replacePanel) {
      // Restore the entire verified snapshot transactionally, including
      // removing tables introduced by the interrupted/newer release. A
      // pg_restore --clean alone leaves unknown newer objects behind.
      const sql = path.join(configuration.staged, '.database-restore.sql');
      try {
        await command('pg_restore', ['--no-owner', '--no-privileges', '--file', sql, path.join(directory, 'database.dump')]);
        await fs.chmod(sql, 0o600);
        await command('psql', ['--no-psqlrc', '--set=ON_ERROR_STOP=1', '--single-transaction', '--command=DROP SCHEMA public CASCADE; CREATE SCHEMA public;', '--file', sql], databaseEnvironment(databaseUrl));
      } finally { await fs.rm(sql, { force: true }); }
    } else await command(
      'pg_restore',
      [
        '--single-transaction',
        '--exit-on-error',
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-privileges',
        '--dbname',
        targetUrl.pathname.slice(1),
        path.join(directory, 'database.dump'),
      ],
      databaseEnvironment(databaseUrl),
    );
    databaseRestored = true;
    if (!replacePanel) await migrateDatabase(databaseUrl);
    await db.$transaction(async (tx) => {
      await tx.session.deleteMany();
      await tx.apiKey.updateMany({ data: { revokedAt: new Date() } });
      if (!replacePanel) {
        await tx.invitation.updateMany({
          where: { acceptedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.setting.deleteMany({
          where: {
            OR: [
              { key: { startsWith: 'maintenance.' } },
              { key: { startsWith: 'network.' } },
              { key: { startsWith: 'tailscale.' } },
              { key: { startsWith: 'upnp.' } },
            ],
          },
        });
        await tx.setting.upsert({
          where: { key: 'network.upnp' },
          create: { key: 'network.upnp', value: { enabled: false } },
          update: { value: { enabled: false } },
        });
        for (const server of manifest.servers)
          await tx.server.update({
            where: { id: server.id },
            data: {
              containerId: null,
              state: 'offline',
              publicAccess: false,
              dataPath: path.join(hostDataRoot, server.uid),
              crashCount: 0,
            },
          });
        for (const server of manifest.servers) {
          const attempts = await tx.installationAttempt.findMany({
            where: { serverId: server.id },
          });
          const operationRoot = path.join(paths.servers, '.operations', server.uid);
          const uploaded = path.join(operationRoot, 'uploaded-pack.zip');
          const retained = await fs.stat(uploaded).then(
            () => uploaded,
            () => null,
          );
          for (const attempt of attempts)
            await tx.installationAttempt.update({
              where: { id: attempt.id },
              data: {
                stagingPath: path.join(operationRoot, `install-${attempt.uid}`),
                sourcePackPath: attempt.sourcePackPath ? retained : null,
              },
            });
        }
        await tx.installationAttempt.updateMany({
          where: { state: { in: ['queued', 'running', 'finalizing'] } },
          data: {
            state: 'failed',
            error: 'Recovered to another host. Review configuration and retry installation.',
            finishedAt: new Date(),
          },
        });
        await tx.node.updateMany({
          data: {
            dataRoot: hostDataRoot,
            backupRoot: hostBackupRoot || '',
            online: false,
            lastSeenAt: null,
            publicHost: 'localhost',
          },
        });
      }
      await tx.auditLog.create({
        data: {
          action: 'recovery.restored',
          targetType: 'system',
          targetId: manifest.id,
          metadata: {
            kind: manifest.kind,
            sessionsRevoked: true,
            networkVerificationRequired: true,
          },
        },
      });
    });
    for (const entry of await fs.readdir(configuration.staged)) {
      const target = path.join(configRoot, entry);
      const old = await fs.lstat(target).catch(() => null);
      if (old) await fs.rename(target, `${target}.before-restore-${job}`);
      await fs.rename(path.join(configuration.staged, entry), target);
      await fs.chmod(target, (await fs.stat(target)).isDirectory() ? 0o700 : 0o600);
    }
    await fs.writeFile(
      path.join(configRoot, 'recovery-report.json'),
      `${JSON.stringify({ ok: true, bundle: manifest.id, at: new Date().toISOString(), gamesOffline: true, tailscaleReauthenticationRequired: true, networkVerificationRequired: true }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return {
      ok: true,
      bundle: manifest.id,
      gamesOffline: true,
      message:
        'Start the dashboard, inspect game files, then start each game. Tailscale reauthentication and network verification are required.',
    };
  } catch (error) {
    if (!databaseRestored)
      for (const file of moved) await fs.rm(file, { recursive: true, force: true });
    else {
      await fs.writeFile(path.join(configRoot, 'recovery-report.json'), JSON.stringify({ ok: false, bundle: manifest.id, job, databaseRestored, at: new Date().toISOString(), stagedDirectories: stages.map((stage) => stage.staged), error: error.message, requiresAttention: true }), { mode: 0o600 });
      error.message +=
        ' Database restored but finalization is incomplete. Keep this installation offline and inspect it; the source bundle and original host were not changed.';
    }
    throw error;
  } finally {
    // Keep staged configuration for recovery if the database was restored but
    // finalization failed. A successful move leaves these directories empty.
    for (const stage of stages) {
      const remaining = await fs.readdir(stage.staged).catch(() => []);
      if (!databaseRestored || !remaining.length) await fs.rm(stage.staged, { recursive: true, force: true });
    }
    await db.$disconnect();
  }
}
