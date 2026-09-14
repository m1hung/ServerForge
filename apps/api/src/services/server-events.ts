import { EventEmitter } from 'node:events';
import { prisma } from '@serverforge/db';
import type { ServerEvent } from '@serverforge/core';

export const serverEvents = new EventEmitter();
export function emitServerEvent(event: ServerEvent) {
  serverEvents.emit('server', event);
}
export async function activity(
  serverId: string,
  action: string,
  message: string,
  actorId?: string,
) {
  await prisma.activity.create({ data: { serverId, action, message, actorId } });
}
