import { describe, expect, it } from 'vitest';
import {
  buildUpdateRequest,
  fullHostname,
  interpretResponse,
  isDdnsProvider,
  normaliseHostname,
} from '../apps/api/src/services/ddns-providers.js';

/**
 * Dynamic DNS protocol handling.
 *
 * Two failures motivated these, both observed for real on this deployment:
 *
 *   1. A hostname that existed in DNS but had no A record, because the update
 *      was inferred from a connection that happened to be IPv6 — so the IPv4
 *      address was replaced rather than set. Every request must therefore
 *      carry an explicit IPv4.
 *
 *   2. A provider that answers HTTP 200 with the body `KO` when the token is
 *      wrong. Trusting the status code reports a broken setup as a success.
 */
describe('normaliseHostname', () => {
  it('accepts the full name people copy off the site', () => {
    expect(normaliseHostname('duckdns', 'myserver.duckdns.org')).toBe('myserver');
    expect(normaliseHostname('duckdns', 'myserver')).toBe('myserver');
  });

  it('tolerates the shapes a hostname arrives in', () => {
    expect(normaliseHostname('duckdns', '  MyServer.DuckDNS.org  ')).toBe('myserver');
    // A trailing dot is a legitimate fully-qualified name and pasted often.
    expect(normaliseHostname('duckdns', 'myserver.duckdns.org.')).toBe('myserver');
  });

  it('round-trips back to the name players are given', () => {
    expect(fullHostname('duckdns', 'myserver')).toBe('myserver.duckdns.org');
    expect(fullHostname('duckdns', 'myserver.duckdns.org')).toBe('myserver.duckdns.org');
  });
});

describe('buildUpdateRequest', () => {
  it('always sends an explicit IPv4', () => {
    const request = buildUpdateRequest(
      'duckdns',
      { hostname: 'myserver.duckdns.org', token: 'secret-token' },
      '98.35.140.29',
    );

    const url = new URL(request.url);
    // The whole point: never let the provider infer the address, or a
    // dual-stack host silently loses its A record.
    expect(url.searchParams.get('ip')).toBe('98.35.140.29');
    expect(url.searchParams.get('domains')).toBe('myserver');
    expect(url.searchParams.get('token')).toBe('secret-token');
  });

  it('offers a redacted URL so the token never reaches a log', () => {
    const request = buildUpdateRequest(
      'duckdns',
      { hostname: 'myserver', token: 'secret-token' },
      '1.2.3.4',
    );

    expect(request.redactedUrl).not.toContain('secret-token');
    expect(request.url).toContain('secret-token');
    // Still recognisable enough to debug against.
    expect(request.redactedUrl).toContain('domains=myserver');
    expect(request.redactedUrl).toContain('ip=1.2.3.4');
  });

  it('escapes values rather than concatenating them into a URL', () => {
    const request = buildUpdateRequest(
      'duckdns',
      { hostname: 'my server', token: 'a&b=c' },
      '1.2.3.4',
    );

    expect(new URL(request.url).searchParams.get('token')).toBe('a&b=c');
  });
});

describe('interpretResponse', () => {
  it('does not treat HTTP 200 as success on its own', () => {
    // DuckDNS answers 200/KO for a bad token. This is the case that turns a
    // broken setup into a silent one.
    const outcome = interpretResponse('duckdns', 200, 'KO');
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/token/i);
  });

  it('accepts the success body', () => {
    expect(interpretResponse('duckdns', 200, 'OK').ok).toBe(true);
    expect(interpretResponse('duckdns', 200, 'OK\n').ok).toBe(true);
  });

  it('fails on a transport error', () => {
    expect(interpretResponse('duckdns', 502, '').ok).toBe(false);
  });

  it('does not claim success for an answer it does not recognise', () => {
    const outcome = interpretResponse('duckdns', 200, '<html>maintenance</html>');
    expect(outcome.ok).toBe(false);
  });
});

describe('isDdnsProvider', () => {
  it('rejects anything not in the registry', () => {
    expect(isDdnsProvider('duckdns')).toBe(true);
    expect(isDdnsProvider('desec')).toBe(false);
    expect(isDdnsProvider(undefined)).toBe(false);
    expect(isDdnsProvider(42)).toBe(false);
  });
});
