import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { checkWebhookUrl, isBlockedAddress } from '../lib/ssrf.js';

export interface WebhookContext {
  serverName: string;
  serverUid: string;
  taskName: string;
  trigger: string | null;
  playerName: string | null;
}

const PLACEHOLDERS: Record<string, (ctx: WebhookContext) => string> = {
  server: (ctx) => ctx.serverName,
  player: (ctx) => ctx.playerName ?? '—',
  event: (ctx) => ctx.trigger ?? 'schedule',
  task: (ctx) => ctx.taskName,
};

export function renderTemplate(template: string, context: WebhookContext): string {
  return template.replace(/\{([a-z]+)\}/gi, (match, name: string) => {
    const render = PLACEHOLDERS[name.toLowerCase()];
    return render ? render(context) : match;
  });
}

export function webhookBody(
  format: 'discord' | 'json',
  message: string,
  context: WebhookContext,
): string {
  if (format === 'discord') return JSON.stringify({ content: message });
  return JSON.stringify({
    message,
    server: context.serverName,
    serverUid: context.serverUid,
    player: context.playerName,
    event: context.trigger,
    task: context.taskName,
  });
}

export async function deliverWebhook(
  url: string,
  format: 'discord' | 'json',
  template: string,
  context: WebhookContext,
): Promise<void> {
  const parsed = checkWebhookUrl(url);
  const body = webhookBody(format, renderTemplate(template, context), context);
  await new Promise<void>((resolve, reject) => {
    const request = (parsed.protocol === 'https:' ? https : http).request(
      parsed,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        lookup(hostname, options, callback) {
          lookup(hostname, { all: true }, (error, addresses) => {
            if (error) return callback(error, [], 0);
            if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address)))
              return callback(new Error('Webhook cannot access private addresses.'), [], 0);
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
          });
        },
      },
      (response) => {
        response.resume();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300)
          resolve();
        else
          reject(
            new Error(`Webhook delivery failed (${response.statusCode ?? 'unknown status'}).`),
          );
      },
    );
    request.setTimeout(10000, () => request.destroy(new Error('Webhook timed out.')));
    request.on('error', () =>
      reject(new Error('Webhook delivery failed. Check the URL and connection.')),
    );
    request.end(body);
  });
}
