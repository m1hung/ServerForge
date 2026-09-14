#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@serverforge/db';
import { migrateDatabase } from './migrate.mjs';
import { createBundle, verifyBundle, withMaintenance, maintenanceRequest } from './recovery.mjs';
import { restoreBundle } from './restore.mjs';

const [action, ...args] = process.argv.slice(2);
const paths = {
  servers: process.env.DATA_ROOT,
  'game-backups': process.env.BACKUP_ROOT,
  themes: process.env.THEMES_ROOT,
  games: process.env.GAMES_ROOT,
};
export async function backup(kind, hold = false) {
  return withMaintenance(kind, (session) => createBundle({ kind, paths, session }), { hold });
}
async function schedule() {
  const db = new PrismaClient();
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      stopping = true;
    });
  try {
    while (!stopping) {
      try {
        const row = await db.setting.findUnique({ where: { key: 'recovery.schedule' } });
        const settings = row?.value || {};
        const now = Date.now();
        const due = Number(settings.nextPanelAt || 0) <= now;
        if (due) {
          await backup('panel');
          const value = JSON.stringify({ nextPanelAt: now + 86400000 });
          await db.$executeRaw`INSERT INTO "Setting" (key,value,"updatedAt") VALUES ('recovery.schedule',${value}::jsonb,NOW()) ON CONFLICT (key) DO UPDATE SET value="Setting".value || EXCLUDED.value,"updatedAt"=NOW()`;
        }
        // Full backup runs only in an explicit owner-configured UTC window.
        const hour = new Date().getUTCHours();
        if (
          settings.fullEnabled === true &&
          Number.isInteger(settings.fullHourUtc) &&
          hour === settings.fullHourUtc &&
          Number(settings.nextFullAt || 0) <= now
        ) {
          await backup('full');
          const value = JSON.stringify({ nextFullAt: now + 23 * 3600000 });
          await db.$executeRaw`UPDATE "Setting" SET value=value || ${value}::jsonb,"updatedAt"=NOW() WHERE key='recovery.schedule'`;
        }
      } catch (error) {
        await db.setting.upsert({ where: { key: 'recovery.lastFailure' }, create: { key: 'recovery.lastFailure', value: { at: new Date().toISOString(), message: error.message } }, update: { value: { at: new Date().toISOString(), message: error.message } } }).catch(() => {});
        console.error(`Scheduled recovery: ${error.message}`);
      }
      for (let second = 0; second < 60 && !stopping; second++)
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    await db.$disconnect();
  }
}
try {
  let result;
  if (action === 'migrate') result = await migrateDatabase();
  else if (action === 'backup') {
    if (args.includes('--offline')) {
      if (process.env.SF_OFFLINE_MAINTENANCE !== '1' || args.includes('--full'))
        throw new Error(
          'Offline backup is restricted to panel state after the launcher stops the API.',
        );
      result = await createBundle({ kind: 'panel', paths });
    } else
      result = await backup(args.includes('--full') ? 'full' : 'panel', args.includes('--hold'));
  } else if (action === 'verify')
    result = { ok: true, manifest: await verifyBundle(path.resolve(args[0])) };
  else if (action === 'restore')
    result = await restoreBundle(path.resolve(args[0]), {
      paths,
      replacePanel: args.includes('--replace-panel'),
    });
  else if (action === 'resume') result = await maintenanceRequest('finish', { id: args[0] });
  else if (action === 'schedule') await schedule();
  else if (action === 'qualify') {
    const { qualify } = await import('./qualification.mjs');
    result = await qualify((args[0] || '').split(',').filter(Boolean), Number(args[1] || 180));
    if (!result.ok) process.exitCode = 1;
  }
  else if (action === 'soak') {
    const { soak } = await import('./soak.mjs');
    result = await soak(args[0], Number(args[1] || 240));
    if (!result.ok) process.exitCode = 1;
  }
  else if (action === 'seed') await import('../../db/dist/seed.js');
  else if (action === 'setup-state') {
    const db = new PrismaClient();
    try { result = { ownerSetupAvailable: await db.user.count() === 0 }; }
    finally { await db.$disconnect(); }
  }
  else if (action === 'reset-password') {
    process.argv = [process.argv[0], '../db/dist/reset-password.js', ...args];
    await import('../../db/dist/reset-password.js');
  } else if (action === 'release-info')
    result = JSON.parse(
      await fs.readFile(new URL('../../../release.json', import.meta.url), 'utf8'),
    );
  else
    throw new Error(
      'Commands: migrate, backup [--full] [--hold], verify BUNDLE, restore BUNDLE, resume ID, schedule, reset-password.',
    );
  if (result) console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
