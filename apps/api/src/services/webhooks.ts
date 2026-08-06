import type { ScheduleTrigger } from '@serverforge/core';
import { brand } from '@serverforge/core';
import { logger } from '../lib/logger.js';
import { resolvePublicHost } from '../lib/ssrf.js';

/**
 * Outbound webhooks.
 *
 * The one thing a schedule can do that reaches outside the panel, which is why
 * every URL goes through the SSRF guard on the way out and why redirects are
 * never followed. See `lib/ssrf.ts` for what that protects against.
 */

const TIMEOUT_MS = 10_000;

export interface WebhookContext {
  serverName: string;
  serverUid: string;
  taskName: string;
  trigger?: ScheduleTrigger | null;
  playerName?: string | null;
}

/**
 * Fills `{placeholders}` in a message.
 *
 * An unknown placeholder is left exactly as typed rather than blanked: someone
 * who writes `{playr}` should see their typo in Discord, not a sentence with a
 * hole in it. A known-but-absent one becomes a dash, so "{player} joined" still
 * reads as a sentence when a state event fires it.
 */
export function renderTemplate(template: string, context: WebhookContext): string {
  const values: Record<string, string> = {
    server: context.serverName,
    player: context.playerName ?? '—',
    event: context.trigger ?? 'schedule',
    task: context.taskName,
  };

  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? (values[key] as string) : whole,
  );
}

/** The JSON a receiver gets. Discord wants `content`; everything else gets the fields. */
export function webhookBody(
  format: 'discord' | 'json',
  message: string,
  context: WebhookContext,
): string {
  if (format === 'discord') {
    return JSON.stringify({ content: message });
  }
  return JSON.stringify({
    message,
    server: context.serverName,
    serverUid: context.serverUid,
    task: context.taskName,
    event: context.trigger ?? null,
    player: context.playerName ?? null,
    at: new Date().toISOString(),
  });
}

export async function sendWebhook(input: {
  url: string;
  format: 'discord' | 'json';
  template: string;
  context: WebhookContext;
}): Promise<void> {
  const url = new URL(input.url);

  // Re-checked here rather than trusted from save time: DNS can be repointed
  // at a private address after a schedule has been sitting on disk for weeks.
  await resolvePublicHost(url.hostname);

  const message = renderTemplate(input.template, input.context);
  const body = webhookBody(input.format, message, input.context);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': `${brand.name} webhook`,
      },
      body,
      // Following a redirect would hand a public host the ability to aim the
      // request at a private one after the check has already passed.
      redirect: 'manual',
      signal: controller.signal,
    });

    // The body is never read. Nothing needs it, and not reading it means a
    // receiver cannot use a huge response to tie up the worker.
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`${url.host} replied with a redirect (${response.status}), which is not followed`);
    }
    if (!response.ok) {
      throw new Error(`${url.host} replied ${response.status}`);
    }

    logger.debug({ host: url.host, status: response.status }, 'webhook delivered');
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${url.host} did not respond within ${TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
