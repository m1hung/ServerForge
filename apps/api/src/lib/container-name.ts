import { slugify } from '@serverforge/core';

/**
 * Docker names must match [a-zA-Z0-9][a-zA-Z0-9_.-]* and be unique, so the
 * panel name is slugified and suffixed with the uid: two "Survival" servers
 * (or a renamed one) never collide. Also used as the DNS name on the game network.
 */
export function containerName(server: { name: string; uid: string }) {
  return `${slugify(server.name).slice(0, 40).replace(/-+$/, '')}-${server.uid}`;
}
