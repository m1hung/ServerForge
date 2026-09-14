import { conflict } from '@serverforge/core';

// ponytail: one API worker owns game operations; use distributed leases before adding workers.
const busy = new Set<string>();
export const isServerBusy = (uid: string) => busy.has(uid);
export function beginServerOperation<T>(uid: string, action: () => Promise<T>): Promise<T> {
  if (busy.has(uid))
    throw conflict('Another operation is in progress for this server. Try again shortly.');
  busy.add(uid);
  return Promise.resolve()
    .then(action)
    .finally(() => busy.delete(uid));
}
export async function withServerLock<T>(uid: string, action: () => Promise<T>): Promise<T> {
  return beginServerOperation(uid, action);
}
