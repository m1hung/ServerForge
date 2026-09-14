/**
 * Idempotent first-run seed.
 *
 * Registers the local Docker node and pre-materialises its port allocations.
 * Does **not** create an owner account by default — the dashboard's first-run
 * setup form does that. Set `SEED_ADMIN_USERNAME` (and optionally password)
 * only when you want a pre-created owner for automation.
 *
 *   npm run db:seed
 */
import { hash } from '@node-rs/argon2';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '../generated/client/index.js';
import { uid } from './uid.js';

/**
 * The address players actually type into their game.
 *
 * Defaulting to "localhost" produces a panel that confidently shows a join
 * address which only works on the server itself — everyone else gets
 * "connection refused" and no explanation. Detecting the LAN address is right
 * far more often, and `PUBLIC_HOST` overrides it for anyone with a domain.
 */
function detectPublicHost(): string {
  if (process.env.PUBLIC_HOST) return process.env.PUBLIC_HOST;

  const candidates: { name: string; address: string }[] = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    // Docker bridges and virtual interfaces are never how a player reaches you.
    if (/^(docker|br-|veth|virbr|lo)/.test(name)) continue;
    for (const entry of addresses ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      candidates.push({ name, address: entry.address });
    }
  }

  // Prefer a real private LAN address over VPN/overlay ranges.
  const lan = candidates.find((c) =>
    /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(c.address),
  );
  return lan?.address ?? candidates[0]?.address ?? 'localhost';
}

const prisma = new PrismaClient();

const ARGON2_OPTIONS = {
  // OWASP 2024 baseline for interactive logins: 19 MiB, t=2, p=1.
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

async function main() {
  const seedUsername = process.env.SEED_ADMIN_USERNAME?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || '';
  if (seedUsername && (password.length < 10 || password === 'ChangeMe123!')) throw new Error('Set a unique SEED_ADMIN_PASSWORD of at least 10 characters, or use protected browser setup.');

  if (seedUsername) {
    const existing = await prisma.user.findUnique({ where: { username: seedUsername } });
    if (existing) {
      console.log(`✓ owner account already exists (${seedUsername})`);
    } else {
      const user = await prisma.user.create({
        data: {
          uid: uid(),
          username: seedUsername,
          passwordHash: await hash(password, ARGON2_OPTIONS),
          displayName: process.env.SEED_ADMIN_DISPLAY_NAME?.trim() || seedUsername,
          role: 'owner',
        },
      });
      console.log(`✓ created owner ${user.username}`);
      if (password === 'ChangeMe123!') {
        console.log('  ⚠ using the default password — change it after first login.');
      }
    }
  } else {
    console.log('Owner accounts are managed through protected setup and workspace accounts. Existing accounts are preserved.');
  }

  const dataRoot = path.resolve(process.env.HOST_DATA_ROOT || process.env.DATA_ROOT || './data/servers');
  const backupRoot = path.resolve(process.env.HOST_BACKUP_ROOT || process.env.BACKUP_ROOT || './data/backups');
  const portStart = Number(process.env.PORT_RANGE_START ?? 25500);
  const portEnd = Number(process.env.PORT_RANGE_END ?? 25999);

  const publicHost = detectPublicHost();

  let node = await prisma.node.findFirst({ where: { transport: 'docker' } });
  if (!node) {
    node = await prisma.node.create({
      data: {
        uid: uid(),
        name: 'local',
        transport: 'docker',
        publicHost,
        dataRoot,
        backupRoot,
        portRangeStart: portStart,
        portRangeEnd: portEnd,
        online: true,
        lastSeenAt: new Date(),
      },
    });
    console.log(`✓ registered local node — players join at ${publicHost}`);
  } else {
    console.log(`✓ keeping local node settings — players join at ${node.publicHost}`);
  }

  // Materialise the port range so allocation is a cheap indexed update.
  const existingPorts = await prisma.allocation.findMany({
    where: { nodeId: node.id },
    select: { port: true },
  });
  const have = new Set(existingPorts.map((a) => a.port));
  const missing: { nodeId: string; ip: string; port: number }[] = [];
  for (let port = node.portRangeStart; port <= node.portRangeEnd; port++) {
    if (!have.has(port)) missing.push({ nodeId: node.id, ip: '0.0.0.0', port });
  }
  if (missing.length > 0) {
    await prisma.allocation.createMany({ data: missing, skipDuplicates: true });
    console.log(`✓ created ${missing.length} port allocations (${portStart}–${portEnd})`);
  } else {
    console.log('✓ port allocations already present');
  }

  await prisma.setting.upsert({
    where: { key: 'registration.mode' },
    create: { key: 'registration.mode', value: 'invite_only' },
    update: {},
  });
  await prisma.setting.upsert({
    where: { key: 'defaults.limits' },
    create: { key: 'defaults.limits', value: { memoryMib: 4096, cpuCores: 2, diskMib: 20480 } },
    update: {},
  });

  const userCount = await prisma.user.count();
  if (seedUsername) {
    console.log('\nSeed complete. Sign in at http://localhost:3000 with', seedUsername);
  } else if (userCount === 0) {
    console.log('\nSeed complete. Open http://localhost:3000 and create your account.');
  } else {
    console.log('\nSeed complete. Sign in at http://localhost:3000 with your username.');
  }
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
