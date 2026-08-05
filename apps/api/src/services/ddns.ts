import { config } from '../config.js';
import {
  describeGateway,
  discoverGateway,
  gatewayFromControlUrl,
  getExternalIp,
} from '../lib/igd.js';
import { logger } from '../lib/logger.js';
import {
  DDNS_CONFIG,
  DDNS_STATUS,
  getSecretSetting,
  getSetting,
  setSecretSetting,
  setSetting,
} from '../lib/settings.js';
import {
  buildUpdateRequest,
  fullHostname,
  interpretResponse,
  normaliseHostname,
  type DdnsCredentials,
  type DdnsProviderId,
} from './ddns-providers.js';

/**
 * Keeps a dynamic DNS hostname pointing at this connection.
 *
 * The panel is unusually well placed to do this: it already asks the router
 * for the external address in order to forward ports, so it knows the right
 * IPv4 without calling any third-party "what is my IP" service. That matters
 * for privacy — nothing about this deployment is disclosed to anyone except
 * the DNS provider the user chose — and for correctness, because inferring the
 * address from the connection is what breaks on dual-stack hosts.
 */

/** Same cadence as the port-forward re-assertion; both track the same address. */
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

interface StoredConfig {
  provider: DdnsProviderId;
  hostname: string;
  token: string;
}

export interface DdnsStatus {
  configured: boolean;
  provider: DdnsProviderId | null;
  /** The full name players use. Never includes the token. */
  hostname: string | null;
  lastResult: { ok: boolean; message: string; at: string; ip?: string } | null;
}

let timer: NodeJS.Timeout | null = null;

async function readConfig(): Promise<StoredConfig | null> {
  return getSecretSetting<StoredConfig | null>(DDNS_CONFIG, null);
}

export async function saveDdnsConfig(input: StoredConfig): Promise<void> {
  await setSecretSetting(DDNS_CONFIG, input);
}

/**
 * Fills a blank token from the stored one.
 *
 * The token is never sent to the browser, so re-running setup arrives with an
 * empty field. Treating that as "clear it" would make revisiting the wizard to
 * change something unrelated silently break DNS updates; treating it as "keep
 * what I had" is what the user means. Only ever reuses the token for the same
 * provider *and* the same hostname, so it cannot be aimed at a different name.
 */
export async function withExistingToken(input: {
  provider: DdnsProviderId;
  hostname: string;
  token: string;
}): Promise<StoredConfig | null> {
  if (input.token) return { ...input };

  const stored = await readConfig();
  if (!stored || stored.provider !== input.provider) return null;

  const same =
    normaliseHostname(stored.provider, stored.hostname) ===
    normaliseHostname(input.provider, input.hostname);

  return same ? { ...input, token: stored.token } : null;
}

export async function clearDdnsConfig(): Promise<void> {
  await setSecretSetting(DDNS_CONFIG, null);
  await setSetting(DDNS_STATUS, null);
}

export async function getDdnsStatus(): Promise<DdnsStatus> {
  const stored = await readConfig();
  const lastResult = await getSetting<DdnsStatus['lastResult']>(DDNS_STATUS, null);

  return {
    configured: Boolean(stored),
    provider: stored?.provider ?? null,
    hostname: stored ? fullHostname(stored.provider, stored.hostname) : null,
    lastResult,
  };
}

/**
 * This connection's IPv4 address, from the router.
 *
 * Deliberately not from an external echo service: the router already knows,
 * asking it stays on the LAN, and it cannot be confused by the request going
 * out over IPv6.
 */
async function currentIpv4(): Promise<string | null> {
  const gateway = config.UPNP_CONTROL_URL
    ? config.UPNP_CONTROL_URL.endsWith('.xml')
      ? await describeGateway(config.UPNP_CONTROL_URL).catch(() => null)
      : gatewayFromControlUrl(config.UPNP_CONTROL_URL)
    : await discoverGateway().catch(() => null);

  if (!gateway) return null;
  return getExternalIp(gateway).catch(() => null);
}

/**
 * Publishes the current address.
 *
 * Returns the outcome so the setup wizard can show it immediately rather than
 * saying "saved" and leaving the user to discover later that the token was
 * wrong. Credentials are passed to the provider and never logged: only
 * `redactedUrl` reaches the log.
 */
export async function runDdnsUpdate(
  override?: StoredConfig,
): Promise<{ ok: boolean; message: string; ip?: string }> {
  const stored = override ?? (await readConfig());
  if (!stored) return { ok: false, message: 'No dynamic DNS provider is configured.' };

  const ip = await currentIpv4();
  if (!ip) {
    const message =
      'Could not read this connection\'s address from the router, so nothing was published.';
    await setSetting(DDNS_STATUS, { ok: false, message, at: new Date().toISOString() });
    return { ok: false, message };
  }

  const credentials: DdnsCredentials = { hostname: stored.hostname, token: stored.token };
  const request = buildUpdateRequest(stored.provider, credentials, ip);

  try {
    const response = await fetch(request.url, {
      method: 'GET',
      headers: request.headers ?? {},
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    const outcome = interpretResponse(stored.provider, response.status, body);

    await setSetting(DDNS_STATUS, { ...outcome, ip, at: new Date().toISOString() });

    if (outcome.ok) {
      logger.info({ provider: stored.provider, ip }, 'dynamic DNS updated');
    } else {
      logger.warn({ provider: stored.provider, url: request.redactedUrl }, outcome.message);
    }

    return { ...outcome, ip };
  } catch (error) {
    const message = 'Could not reach the dynamic DNS provider.';
    logger.warn({ error, url: request.redactedUrl }, message);
    await setSetting(DDNS_STATUS, { ok: false, message, ip, at: new Date().toISOString() });
    return { ok: false, message, ip };
  }
}

export async function startDdns(): Promise<void> {
  if (!(await readConfig())) return;

  await runDdnsUpdate().catch((error) => logger.warn({ error }, 'initial DNS update failed'));

  timer = setInterval(() => {
    void runDdnsUpdate().catch((error) => logger.warn({ error }, 'scheduled DNS update failed'));
  }, REFRESH_INTERVAL_MS);
  // A DNS refresh is never a reason to keep the process alive.
  timer.unref();
}

export function stopDdns(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Starts the timer after the wizard configures a provider mid-run. */
export async function restartDdns(): Promise<void> {
  stopDdns();
  await startDdns();
}
