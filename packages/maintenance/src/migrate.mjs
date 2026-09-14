import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@serverforge/db';
import { schemaState, schemaDifference } from './schema-state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const prismaRoot = path.resolve(here, '../../db/prisma');
const require = createRequire(import.meta.url);
const prismaCli = require.resolve('prisma');
export async function migrationFiles(root = prismaRoot) {
  const names = (await fs.readdir(path.join(root, 'migrations'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await fs.readFile(path.join(root, 'migrations', name, 'migration.sql'), 'utf8');
      const expected = JSON.parse(
        await fs.readFile(path.join(root, 'states', `${name}.json`), 'utf8'),
      );
      return { name, sql, expected, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}
async function prismaCommand(args, databaseUrl, schema) {
  // The CLI runs from a private scratch package, preventing .env discovery in
  // a source checkout from overriding an explicitly selected database.
  const scratch = await fs.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'serverforge-migrate-'));
  try {
    await fs.writeFile(path.join(scratch, 'package.json'), '{"private":true}');
    const target = path.join(scratch, 'schema.prisma');
    await fs.copyFile(schema, target);
    await fs.symlink(
      path.join(path.dirname(schema), 'migrations'),
      path.join(scratch, 'migrations'),
    );
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [prismaCli, 'migrate', ...args, '--schema', target], {
        cwd: scratch,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (data) => {
          output = (output + data).slice(-16000);
        });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                `Migration command failed (${code}). ${output.replaceAll(databaseUrl, '[database URL]').replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[database URL]')}`,
              ),
            ),
      );
    });
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

export async function migrateDatabase(databaseUrl = process.env.DATABASE_URL, root = prismaRoot) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  const url = new URL(databaseUrl);
  if ((url.searchParams.get('schema') || 'public') !== 'public')
    throw new Error(
      'Only the public ServerForge schema is supported. No database changes were made.',
    );
  const migrations = await migrationFiles(root);
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    return await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(193609, 7721)`;
        const tables =
          await tx.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
        const hasHistory = tables.some((row) => row.tablename === '_prisma_migrations');
        const history = hasHistory
          ? await tx.$queryRawUnsafe(
              'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at',
            )
          : [];
        const unfinished = history.find((row) => !row.finished_at && !row.rolled_back_at);
        if (unfinished)
          throw new Error(
            `Migration ${unfinished.migration_name} was interrupted or failed. Restore its pre-upgrade backup or review the failure before explicitly resolving it. Automatic retries and destructive downgrades are disabled.`,
          );
        const applied = history.filter((row) => row.finished_at && !row.rolled_back_at);
        for (let index = 0; index < applied.length; index++) {
          const expected = migrations[index];
          if (
            !expected ||
            expected.name !== applied[index].migration_name ||
            expected.checksum !== applied[index].checksum
          )
            throw new Error(
              'Migration history differs from this release. Use the matching image and migration files; no changes were made.',
            );
        }
        const actual = await schemaState(tx);
        let adopted = null;
        if (!applied.length && actual.length) {
          // Only the two documented legacy states may acquire history automatically.
          const known = migrations
            .slice(0, 2)
            .find((migration) => !schemaDifference(migration.expected, actual).length);
          if (!known) {
            const nearest = migrations
              .slice(0, 2)
              .map((m) => schemaDifference(m.expected, actual))
              .sort((a, b) => a.length - b.length)[0];
            throw new Error(
              `Unknown legacy schema. Nothing was reset or adopted. Drift:\n${nearest.join('\n')}`,
            );
          }
          for (const migration of migrations.slice(0, migrations.indexOf(known) + 1))
            await prismaCommand(
              ['resolve', '--applied', migration.name],
              databaseUrl,
              path.join(root, 'schema.prisma'),
            );
          adopted = known.name;
        } else if (applied.length) {
          const drift = schemaDifference(migrations[applied.length - 1].expected, actual);
          if (drift.length)
            throw new Error(
              `Schema drift after ${applied.at(-1).migration_name}. No migrations applied:\n${drift.join('\n')}`,
            );
        }
        await prismaCommand(['deploy'], databaseUrl, path.join(root, 'schema.prisma'));
        const drift = schemaDifference(migrations.at(-1).expected, await schemaState(tx));
        if (drift.length) throw new Error(`Post-migration validation failed:\n${drift.join('\n')}`);
        return { ok: true, adopted, migration: migrations.at(-1).name };
      },
      { timeout: 600000, maxWait: 10000 },
    );
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await migrateDatabase(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
