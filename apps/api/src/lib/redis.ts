import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Redis connections.
 *
 * Three separate clients on purpose: a connection in subscribe mode cannot
 * issue normal commands, and BullMQ requires `maxRetriesPerRequest: null` on
 * its own connection while the app client should fail fast instead.
 */

function create(name: string, options: Record<string, unknown> = {}): Redis {
  const client = new Redis(config.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    // Back off rather than hammering a socket that is not there. Capped so a
    // Redis that comes back up is picked up within a few seconds.
    retryStrategy: (attempt: number) => Math.min(attempt * 500, 5_000),
    ...options,
  });

  // Redis down means one error per reconnect attempt, forever. Logging each
  // one buries everything else in the log, so only the first is reported and
  // the rest are counted until the connection recovers.
  let suppressed = 0;
  let reported = false;

  client.on('error', (error) => {
    if (reported) {
      suppressed += 1;
      return;
    }
    reported = true;
    logger.error(
      { client: name, reason: (error as Error).message },
      'cannot reach Redis — retrying in the background',
    );
  });

  client.on('ready', () => {
    if (reported) {
      logger.info({ client: name, suppressed }, 'Redis connection restored');
      reported = false;
      suppressed = 0;
    }
  });

  return client;
}

/** General purpose: rate limits, console ring buffer, caches. */
export const redis = create('app');

/** Publisher for server state and console fan-out. */
export const publisher = create('publisher');

/** Dedicated subscriber — never issue commands on this one. */
export const subscriber = create('subscriber');

/**
 * A second subscriber, for the schedule trigger listener.
 *
 * Separate from `subscriber` so the worker's subscription cannot be affected by
 * the WebSocket layer's reference-counted subscribe/unsubscribe, and so a
 * flood of console traffic on one connection cannot delay trigger dispatch on
 * the other.
 */
export const eventSubscriber = create('event-subscriber');

/** BullMQ needs blocking commands, which forbid a per-request retry cap. */
export const queueConnection = { url: config.REDIS_URL, maxRetriesPerRequest: null } as const;

export const channels = {
  console: (serverUid: string) => `sf:console:${serverUid}`,
  state: (serverUid: string) => `sf:state:${serverUid}`,
  stats: (serverUid: string) => `sf:stats:${serverUid}`,
  install: (serverUid: string) => `sf:install:${serverUid}`,
  /** Panel-wide feed used by the dashboard's server list. */
  fleet: () => 'sf:fleet',
  /**
   * Panel-wide feed of things servers did — what event-triggered schedules
   * listen on. One channel rather than one per server so the listener does not
   * have to resubscribe every time a server is created or deleted.
   */
  events: () => 'sf:events',
} as const;

export const keys = {
  /** Capped list of recent console lines, so a fresh page load has scrollback. */
  consoleBuffer: (serverUid: string) => `sf:buffer:${serverUid}`,
  loginAttempts: (identifier: string) => `sf:login:${identifier}`,
  diskUsage: (serverUid: string) => `sf:disk:${serverUid}`,
  /**
   * Set of player names currently connected. A set rather than a count so the
   * panel can show who is on; the count is its cardinality, which means the
   * two can never disagree.
   */
  players: (serverUid: string) => `sf:players:${serverUid}`,
  /** Set while a triggered schedule is inside its cooldown window. */
  scheduleCooldown: (scheduleId: string) => `sf:cooldown:${scheduleId}`,
  /** Password accepted, second factor still owed. Holds the user id. */
  twoFactorTicket: (ticketHash: string) => `sf:2fa:ticket:${ticketHash}`,
  /** Wrong guesses against one ticket, so six digits cannot be brute-forced. */
  twoFactorAttempts: (ticketHash: string) => `sf:2fa:tries:${ticketHash}`,
  /** Marks a TOTP code as spent, so it cannot be replayed inside its window. */
  totpUsed: (userId: string, code: string) => `sf:2fa:used:${userId}:${code}`,
} as const;

export const CONSOLE_BUFFER_LINES = 500;

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([
    redis.quit(),
    publisher.quit(),
    subscriber.quit(),
    eventSubscriber.quit(),
  ]);
}
