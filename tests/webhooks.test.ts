import { beforeAll, describe, expect, it } from 'vitest';
import { checkWebhookUrl, isBlockedAddress } from '../apps/api/src/lib/ssrf.js';
import { scheduleSchema } from '../packages/core/src/index.js';

/**
 * A webhook URL is the only place a user gets to say "make the server request
 * this". Everything here is about that request never reaching somewhere it
 * should not — the panel's own Docker socket, a router on the LAN, or the
 * cloud metadata endpoint that hands out instance credentials.
 */

/**
 * `services/webhooks.ts` reaches the logger, which reads config at import
 * time, so the env has to exist before it is pulled in. Same pattern as
 * `storage-paths.test.ts`.
 */
type WebhookModule = typeof import('../apps/api/src/services/webhooks.js');
let webhooks: WebhookModule;

beforeAll(async () => {
  process.env.SESSION_SECRET ??= 'a'.repeat(64);
  process.env.ENCRYPTION_KEY ??= 'b'.repeat(64);
  process.env.DATABASE_URL ??= 'postgresql://serverforge:x@localhost:5432/serverforge';
  webhooks = await import('../apps/api/src/services/webhooks.js');
});

describe('isBlockedAddress', () => {
  it('blocks loopback', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('127.255.255.254')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
  });

  it('blocks the RFC 1918 ranges', () => {
    expect(isBlockedAddress('10.0.0.1')).toBe(true);
    expect(isBlockedAddress('172.16.0.1')).toBe(true);
    expect(isBlockedAddress('172.31.255.255')).toBe(true);
    expect(isBlockedAddress('192.168.1.1')).toBe(true);
  });

  it('allows the public addresses either side of 172.16/12', () => {
    // The classic off-by-one: 172.15 and 172.32 are ordinary internet hosts.
    expect(isBlockedAddress('172.15.255.255')).toBe(false);
    expect(isBlockedAddress('172.32.0.1')).toBe(false);
  });

  it('blocks the cloud metadata endpoint', () => {
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
  });

  it('blocks CGNAT, reserved and multicast space', () => {
    expect(isBlockedAddress('100.64.0.1')).toBe(true);
    expect(isBlockedAddress('0.0.0.0')).toBe(true);
    expect(isBlockedAddress('224.0.0.1')).toBe(true);
    expect(isBlockedAddress('255.255.255.255')).toBe(true);
  });

  it('allows normal public addresses', () => {
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
    expect(isBlockedAddress('93.184.216.34')).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('blocks IPv6 private and link-local space', () => {
    expect(isBlockedAddress('fc00::1')).toBe(true);
    expect(isBlockedAddress('fd12:3456::1')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('ff02::1')).toBe(true);
    expect(isBlockedAddress('::')).toBe(true);
  });

  it('sees through IPv4-mapped IPv6, which is the usual bypass', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:192.168.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:1.1.1.1')).toBe(false);
  });

  it('sees through NAT64 translation prefixes too', () => {
    expect(isBlockedAddress('64:ff9b::127.0.0.1')).toBe(true);
    expect(isBlockedAddress('64:ff9b::1.1.1.1')).toBe(false);
  });

  it('treats anything unparseable as blocked', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
    expect(isBlockedAddress('999.999.999.999')).toBe(true);
  });
});

describe('checkWebhookUrl', () => {
  it('accepts a Discord webhook', () => {
    const url = checkWebhookUrl('https://discord.com/api/webhooks/123/abc');
    expect(url.host).toBe('discord.com');
  });

  it('rejects a scheme that is not http(s)', () => {
    expect(() => checkWebhookUrl('file:///etc/passwd')).toThrow();
    expect(() => checkWebhookUrl('gopher://example.com')).toThrow();
  });

  it('rejects a literal private address', () => {
    expect(() => checkWebhookUrl('http://127.0.0.1:9000/hook')).toThrow();
    expect(() => checkWebhookUrl('http://169.254.169.254/latest/meta-data/')).toThrow();
    expect(() => checkWebhookUrl('http://[::1]:8080/hook')).toThrow();
  });

  it('rejects credentials embedded in the URL', () => {
    expect(() => checkWebhookUrl('https://user:pass@example.com/hook')).toThrow();
  });

  it('rejects nonsense', () => {
    expect(() => checkWebhookUrl('not a url')).toThrow();
  });

  it('allows a public host, since DNS is checked at send time', () => {
    expect(() => checkWebhookUrl('https://example.com/hook')).not.toThrow();
  });
});

describe('renderTemplate', () => {
  const context = {
    serverName: 'Survey Fleet',
    serverUid: 'abc123',
    taskName: 'Join alert',
    trigger: 'player.join' as const,
    playerName: 'Belle',
  };

  it('fills every known placeholder', () => {
    expect(webhooks.renderTemplate('{player} joined {server} ({event}) via {task}', context)).toBe(
      'Belle joined Survey Fleet (player.join) via Join alert',
    );
  });

  it('leaves an unknown placeholder as typed, so a typo is visible', () => {
    expect(webhooks.renderTemplate('{playr} joined', context)).toBe('{playr} joined');
  });

  it('uses a dash for a known placeholder with no value', () => {
    const stateEvent = { ...context, playerName: null, trigger: 'server.crashed' as const };
    expect(webhooks.renderTemplate('{player} — {event}', stateEvent)).toBe('— — server.crashed');
  });

  it('falls back to "schedule" when a cron task has no trigger', () => {
    const cronRun = { ...context, trigger: null, playerName: null };
    expect(webhooks.renderTemplate('{event}', cronRun)).toBe('schedule');
  });
});

describe('webhookBody', () => {
  const context = {
    serverName: 'Survey Fleet',
    serverUid: 'abc123',
    taskName: 'Join alert',
    trigger: 'player.join' as const,
    playerName: 'Belle',
  };

  it('sends Discord exactly the field it expects and nothing else', () => {
    // Extra top-level fields are what Discord rejects, so this stays minimal.
    expect(JSON.parse(webhooks.webhookBody('discord', 'hello', context))).toEqual({ content: 'hello' });
  });

  it('sends the structured fields in json mode', () => {
    const body = JSON.parse(webhooks.webhookBody('json', 'hello', context));
    expect(body.message).toBe('hello');
    expect(body.server).toBe('Survey Fleet');
    expect(body.player).toBe('Belle');
    expect(body.event).toBe('player.join');
  });
});

describe('the webhook action contract', () => {
  const base = { name: 'Alert', cron: '0 4 * * *' };

  it('accepts a webhook step and applies its defaults', () => {
    const parsed = scheduleSchema.parse({
      ...base,
      actions: [{ type: 'webhook', url: 'https://example.com/hook' }],
    });
    const action = parsed.actions[0] as { template: string; format: string };
    expect(action.template).toBe('{server}: {event}');
    expect(action.format).toBe('discord');
  });

  it('rejects a webhook step with no address', () => {
    expect(
      scheduleSchema.safeParse({ ...base, actions: [{ type: 'webhook', url: 'nope' }] }).success,
    ).toBe(false);
  });

  it('rejects an unknown format', () => {
    expect(
      scheduleSchema.safeParse({
        ...base,
        actions: [{ type: 'webhook', url: 'https://example.com/h', format: 'sms' }],
      }).success,
    ).toBe(false);
  });
});
