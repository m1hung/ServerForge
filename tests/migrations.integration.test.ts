import { expect, it } from 'vitest';
import { fixtureDatabase, applyFixture } from '../scripts/migration-fixtures.mjs';
import { migrateDatabase } from '../packages/maintenance/src/migrate.mjs';
import { schemaState } from '../packages/maintenance/src/schema-state.mjs';

it.each([0, 1, 2])(
  'migrates supported schema state %i without losing accounts, identifiers or settings',
  async (count) => {
    await fixtureDatabase(async (db, url) => {
      const names = await applyFixture(db, count);
      if (count) {
        await db.$executeRaw`INSERT INTO "User" (id, uid, username, "displayName", "passwordHash", role, "updatedAt") VALUES ('legacy-id','legacy-uid','legacy','Legacy','preserved-hash','owner',NOW())`;
        await db.$executeRaw`INSERT INTO "Setting" (key, value, "updatedAt") VALUES ('network.preferences','{"upnp":false}'::jsonb,NOW())`;
      }
      const result = await migrateDatabase(url);
      expect(result).toMatchObject({
        ok: true,
        adopted: count ? names[count - 1] : null,
        migration: names.at(-1),
      });
      if (count) {
        const user = await db.user.findUnique({ where: { id: 'legacy-id' } });
        expect(user).toMatchObject({
          uid: 'legacy-uid',
          passwordHash: 'preserved-hash',
          role: 'owner',
        });
        expect(
          (await db.setting.findUnique({ where: { key: 'network.preferences' } })).value,
        ).toEqual({ upnp: false });
      }
      expect((await migrateDatabase(url)).adopted).toBeNull();
    });
  },
  60000,
);

it('refuses unknown legacy drift before writing migration history or changing data', async () => {
  await fixtureDatabase(async (db, url) => {
    await applyFixture(db, 1);
    await db.$executeRaw`ALTER TABLE "Server" ADD COLUMN "customLegacySetting" text`;
    const before = await schemaState(db);
    await expect(migrateDatabase(url)).rejects.toThrow(/Unknown legacy schema.*Nothing was reset/s);
    expect(await schemaState(db)).toEqual(before);
    expect(
      await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='_prisma_migrations'`,
    ).toEqual([]);
  });
}, 60000);

it('refuses custom objects that Prisma introspection would otherwise ignore', async () => {
  await fixtureDatabase(async (db, url) => {
    await applyFixture(db, 2);
    await db.$executeRaw`CREATE VIEW custom_view AS SELECT 1 AS value`;
    await expect(migrateDatabase(url)).rejects.toThrow(/custom_view/);
  });
}, 60000);

it('refuses an interrupted migration and preserves the pre-failure schema for explicit recovery', async () => {
  await fixtureDatabase(async (db, url) => {
    await migrateDatabase(url);
    await db.$executeRaw`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, applied_steps_count) VALUES ('interrupted','invalid','future_interrupted',NOW(),0)`;
    const before = await schemaState(db);
    await expect(migrateDatabase(url)).rejects.toThrow(/interrupted or failed/);
    expect(await schemaState(db)).toEqual(before);
  });
}, 60000);
