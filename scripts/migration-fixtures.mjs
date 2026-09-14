import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@serverforge/db';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaState } from '../packages/maintenance/src/schema-state.mjs';

export async function fixtureDatabase(action) {
  const url = new URL(process.env.SF_TEST_DATABASE_URL || 'http://invalid');
  if (
    !process.env.SF_TEST_PROJECT?.startsWith('serverforge-test-') ||
    url.username !== 'serverforge_test' ||
    url.pathname !== '/serverforge_test'
  )
    throw new Error('Migration tests require an isolated test project.');
  const name = `serverforge_test_${randomBytes(6).toString('hex')}`;
  const admin = new PrismaClient({ datasources: { db: { url: url.href } } });
  let fixture;
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    url.pathname = `/${name}`;
    fixture = new PrismaClient({ datasources: { db: { url: url.href } } });
    return await action(fixture, url.href);
  } finally {
    await fixture?.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}
export const prismaRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../packages/db/prisma',
);
export async function applyFixture(db, count) {
  const names = (await fs.readdir(path.join(prismaRoot, 'migrations'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names.slice(0, count)) {
    const sql = (
      await fs.readFile(path.join(prismaRoot, 'migrations', name, 'migration.sql'), 'utf8')
    )
      .replace(/^BEGIN;\s*/, '')
      .replace(/COMMIT;\s*$/, '');
    await db.$executeRawUnsafe(
      `DO $serverforge_fixture$ BEGIN\n${sql}\nEND $serverforge_fixture$;`,
    );
  }
  return names;
}
if (process.argv.includes('--update-schema-states')) {
  const names = (await fs.readdir(path.join(prismaRoot, 'migrations'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  await fs.mkdir(path.join(prismaRoot, 'states'), { recursive: true });
  await fixtureDatabase(async (db) => {
    for (let index = 0; index < names.length; index++) {
      const sql = (
        await fs.readFile(
          path.join(prismaRoot, 'migrations', names[index], 'migration.sql'),
          'utf8',
        )
      )
        .replace(/^BEGIN;\s*/, '')
        .replace(/COMMIT;\s*$/, '');
      await db.$executeRawUnsafe(
        `DO $serverforge_fixture$ BEGIN\n${sql}\nEND $serverforge_fixture$;`,
      );
      await fs.writeFile(
        path.join(prismaRoot, 'states', `${names[index]}.json`),
        `${JSON.stringify(await schemaState(db), null, 2)}\n`,
      );
      console.log(`Recorded catalog for ${names[index]}`);
    }
  });
}
