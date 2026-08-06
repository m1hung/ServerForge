import { prisma } from '@serverforge/db';

/**
 * Panel settings that outlive a restart and are editable without a terminal.
 *
 * The distinction from `.env` matters: environment variables are how an
 * operator configures a deployment, but a first-run wizard is used by someone
 * who has never opened a shell. Anything the wizard can change lives here, and
 * the environment provides the default it starts from.
 */

export const SETUP_COMPLETED = 'setup.completed';
export const NETWORK_FORWARDING = 'network.forwarding';
export const DDNS_CONFIG = 'ddns.config';
export const DDNS_STATUS = 'ddns.status';
export const CURSEFORGE_API_KEY = 'integrations.curseforge.apiKey';

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.setting.findUnique({ where: { key } }).catch(() => null);
  if (!row || row.encrypted) return fallback;
  return (row.value as T) ?? fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value: value as never, encrypted: false },
    create: { key, value: value as never },
  });
}

/**
 * A setting containing a credential.
 *
 * Stored encrypted with ENCRYPTION_KEY and flagged, so `getSetting` refuses to
 * hand it back as plaintext and the admin settings endpoint — which filters on
 * `encrypted: false` — never lists it. Only `getSecretSetting` can read it,
 * and nothing returns it to a browser.
 */
export async function setSecretSetting(key: string, value: unknown): Promise<void> {
  const { encryptSecret } = await import('./crypto.js');
  const sealed = encryptSecret(JSON.stringify(value));
  await prisma.setting.upsert({
    where: { key },
    update: { value: sealed as never, encrypted: true },
    create: { key, value: sealed as never, encrypted: true },
  });
}

export async function getSecretSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.setting.findUnique({ where: { key } }).catch(() => null);
  if (!row?.encrypted || typeof row.value !== 'string') return fallback;

  try {
    const { decryptSecret } = await import('./crypto.js');
    return JSON.parse(decryptSecret(row.value)) as T;
  } catch {
    // A rotated ENCRYPTION_KEY makes this unreadable rather than wrong. Treat
    // it as absent so the caller re-prompts instead of failing forever.
    return fallback;
  }
}

/** Removes a setting entirely, so the environment default applies again. */
export async function clearSetting(key: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key } });
}

/**
 * The CurseForge API key, from the panel first and the environment second.
 *
 * CurseForge requires every host to use their own key, so there is no shipped
 * default and the panel has to ask for one. It is read fresh on each call
 * rather than cached: someone who has just pasted a key into Settings expects
 * the next search to work, and the cost is one indexed lookup on a screen a
 * human drives by hand.
 */
export async function curseForgeApiKey(): Promise<string> {
  const stored = await getSecretSetting<string>(CURSEFORGE_API_KEY, '');
  if (stored) return stored;

  const { config } = await import('../config.js');
  return config.CURSEFORGE_API_KEY;
}
