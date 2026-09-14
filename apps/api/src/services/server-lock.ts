import { conflict } from '@serverforge/core';
import { lifecycle } from './lifecycle.js';

// ponytail: one API worker owns game operations; use distributed leases before adding workers.
const busy = new Map<string, Promise<unknown>>();
export const isServerBusy = (uid: string) => busy.has(uid);
export const activeServerOperations = () => [...busy.keys()];
export function beginServerOperation<T>(uid: string, action: () => Promise<T>): Promise<T> {
  if (lifecycle.mode !== 'ready')
    throw conflict(
      'The panel is preparing, in maintenance, or shutting down. Try again when it is ready.',
    );
  if (busy.has(uid))
    throw conflict('Another operation is in progress for this server. Try again shortly.');
  const pending = Promise.resolve()
    .then(action)
    .finally(() => busy.delete(uid));
  busy.set(uid, pending);
  return pending;
}
export async function withServerLock<T>(uid: string, action: () => Promise<T>): Promise<T> {
  return beginServerOperation(uid, action);
}

export async function drainServerOperations(timeoutMs = 30000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled([...busy.values()]).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
