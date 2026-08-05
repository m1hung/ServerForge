#!/usr/bin/env node
/**
 * Repoints stored absolute paths after the panel's data directory moves.
 *
 * Servers record their data directory as an absolute *host* path, because that
 * is what the Docker daemon needs when it bind-mounts a game container. The
 * cost of that is a database that contains machine-specific paths: move the
 * project, restore onto a different box, or change DATA_ROOT, and those rows
 * still point at the old location.
 *
 * The failure is quiet and confusing when it happens. Docker creates a missing
 * bind source as an empty directory rather than erroring, so the game
 * container starts against an empty folder and the player sees
 * "Unable to access jarfile server.jar" — an error about Java that has nothing
 * to do with Java.
 *
 * Dry run by default. Nothing is written without --apply.
 *
 *   node scripts/repath.mjs --from /old/data/servers --to /new/data/servers
 *   node scripts/repath.mjs --from /old/... --to /new/... --apply
 *   node scripts/repath.mjs --public-host play.example.com --apply
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // Already exported in the environment, or no .env — Prisma will complain
  // clearly enough if DATABASE_URL really is missing.
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const from = arg('from');
const to = arg('to');
const publicHost = arg('public-host');
const apply = process.argv.includes('--apply');

if (!from && !to && !publicHost) {
  console.error(
    [
      '',
      'Repoints stored host paths and the address players connect to.',
      '',
      '  --from <path>         current stored prefix (with --to)',
      '  --to <path>           replacement prefix; must exist on disk',
      '  --public-host <host>  address the panel hands to players',
      '  --apply               actually write; omit for a dry run',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

if ((from && !to) || (to && !from)) {
  console.error('--from and --to must be given together.');
  process.exit(1);
}

const { prisma } = await import('@serverforge/db');

const label = apply ? 'APPLYING' : 'DRY RUN — nothing will be written';
console.log(`\n${label}\n`);

let repathed = 0;
let skipped = 0;

if (from && to) {
  const fromRoot = path.resolve(from);
  const toRoot = path.resolve(to);

  if (!existsSync(toRoot)) {
    console.error(`--to does not exist: ${toRoot}`);
    console.error('Refusing to point the database at a directory that is not there.');
    process.exit(1);
  }

  for (const server of await prisma.server.findMany({
    select: { uid: true, name: true, dataPath: true },
  })) {
    const resolved = path.resolve(server.dataPath);
    if (resolved !== fromRoot && !resolved.startsWith(fromRoot + path.sep)) continue;

    const next = path.join(toRoot, path.relative(fromRoot, resolved));

    // The whole point of this tool is to stop pointing at directories that are
    // not there, so verify before writing rather than trading one bad path for
    // another.
    if (!existsSync(next)) {
      console.log(`  skip  ${server.uid} (${server.name})\n        ${next}\n        ^ not on disk`);
      skipped++;
      continue;
    }

    console.log(`  move  ${server.uid} (${server.name})\n        ${resolved}\n     -> ${next}`);
    if (apply) await prisma.server.update({ where: { uid: server.uid }, data: { dataPath: next } });
    repathed++;
  }
}

let rehosted = 0;

if (publicHost) {
  for (const node of await prisma.node.findMany({ select: { uid: true, name: true, publicHost: true } })) {
    if (node.publicHost === publicHost) continue;
    console.log(`  host  ${node.name}: ${node.publicHost} -> ${publicHost}`);
    if (apply) await prisma.node.update({ where: { uid: node.uid }, data: { publicHost } });
    rehosted++;
  }
}

console.log(
  `\n${apply ? 'updated' : 'would update'}: ${repathed} server path(s), ${rehosted} node host(s)` +
    (skipped ? `, skipped ${skipped} with no directory on disk` : ''),
);

if (!apply && (repathed || rehosted)) console.log('\nRe-run with --apply to write.\n');
else console.log('');

await prisma.$disconnect();
