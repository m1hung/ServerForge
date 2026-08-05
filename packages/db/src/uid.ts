import { randomInt } from 'node:crypto';

/**
 * Short, URL-safe public identifiers.
 *
 * Lowercase alphanumerics minus the characters people misread when copying a
 * server id out of a support chat (0/o, 1/l/i). 10 chars from a 30-symbol
 * alphabet is ~49 bits — collision-safe for any self-hosted deployment, and
 * still double-click-selectable.
 */
export const UID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export function uid(length = 10): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += UID_ALPHABET[randomInt(UID_ALPHABET.length)];
  }
  return out;
}
