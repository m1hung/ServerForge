import { PrismaClient, type Prisma } from '../generated/client/index.js';

export * from '../generated/client/index.js';

/**
 * Named payload types for the shapes the API loads repeatedly.
 *
 * Without these, every service function that returns an `include`d query has
 * an inferred type that TypeScript cannot name across package boundaries.
 */
export type ServerWithRelations = Prisma.ServerGetPayload<{
  include: { allocations: true; node: true; owner: true };
}>;

export type ServerWithAccess = Prisma.ServerGetPayload<{
  include: {
    allocations: true;
    node: true;
    // Roles come along with the membership because the access check needs
    // them on every request — fetching them separately would mean a second
    // round trip on the hottest path in the API.
    subusers: { include: { roles: true } };
  };
}>;

export { uid, UID_ALPHABET } from './uid.js';

/**
 * Single Prisma instance per process. Next.js dev-mode hot reload would
 * otherwise open a new pool on every edit and exhaust Postgres connections.
 */
const globalForPrisma = globalThis as unknown as { __serverforgePrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__serverforgePrisma ??
  new PrismaClient({
    // Errors are emitted as events, not printed. The API already turns query
    // failures into structured log lines with request context; Prisma also
    // printing its own multi-line block just buries the message that matters.
    // Set PRISMA_DEBUG=1 when you need the raw output.
    log:
      process.env.PRISMA_DEBUG === '1'
        ? [{ level: 'query', emit: 'stdout' }, { level: 'error', emit: 'stdout' }]
        : [{ level: 'error', emit: 'event' }],
  });

if (process.env.PRISMA_DEBUG !== '1') {
  // An 'event' log level with no listener still buffers; subscribing with a
  // no-op is what actually makes it quiet.
  prisma.$on('error' as never, () => undefined);
}

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__serverforgePrisma = prisma;
}

/** BigInt columns (sizes, byte counters) must survive JSON.stringify. */
export function serializeBigInts<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? Number(v) : v)),
  ) as T;
}
