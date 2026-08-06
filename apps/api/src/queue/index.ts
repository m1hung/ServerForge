import { Queue } from 'bullmq';
import { queueConnection } from '../lib/redis.js';

/**
 * Job queues.
 *
 * Installs, backups and scheduled actions all outlive an HTTP request, and
 * must survive a panel restart — a user who closes the tab during a 20-minute
 * Palworld download should come back to a finished server.
 */

export interface InstallJob {
  serverUid: string;
  /** Reinstall wipes and re-lays the server files; install is first-time. */
  mode: 'install' | 'reinstall' | 'update';
  startAfter: boolean;
  actorId?: string;
}

export interface BackupJob {
  serverUid: string;
  backupUid: string;
  ignore: string[];
  /** Set when a schedule requested it, enabling per-schedule retention. */
  scheduleId?: string;
  retain?: number;
}

export interface RestoreJob {
  serverUid: string;
  backupUid: string;
  actorId?: string;
}

export interface ScheduleJob {
  scheduleId: string;
  /**
   * The event that fired this, when one did. Carried through so a webhook can
   * say *which* player joined — the whole point of that message.
   */
  trigger?: { type: string; playerName?: string; at: number };
}

const defaultJobOptions = {
  removeOnComplete: { age: 3600, count: 200 },
  removeOnFail: { age: 86_400 * 7 },
} as const;

/**
 * Queues are created on first use, not on import.
 *
 * BullMQ opens a Redis connection the moment a Queue is constructed. At
 * module scope that happens before the startup checks run, so a missing Redis
 * produced a wall of connection stack traces that buried the one message
 * telling the operator what was actually wrong.
 */
const queues = new Map<string, Queue>();

function queue<T>(name: string, options: Record<string, unknown>): Queue<T> {
  let existing = queues.get(name);
  if (!existing) {
    existing = new Queue(name, {
      connection: queueConnection,
      defaultJobOptions: { ...defaultJobOptions, ...options },
    });
    queues.set(name, existing);
  }
  return existing as Queue<T>;
}

/**
 * Installs are not idempotent enough to retry blindly: a half-extracted
 * modpack must be reported, not silently re-run.
 */
export const installQueue = () => queue<InstallJob>('install', { attempts: 1 });

export const backupQueue = () =>
  queue<BackupJob>('backup', { attempts: 2, backoff: { type: 'exponential', delay: 30_000 } });

export const restoreQueue = () => queue<RestoreJob>('restore', { attempts: 1 });

export const scheduleQueue = () => queue<ScheduleJob>('schedule', { attempts: 1 });

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
}
