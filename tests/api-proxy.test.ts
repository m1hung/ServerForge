import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { GET, POST } from '../apps/web/src/app/api/[...path]/route.js';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const request = (path: string, init?: RequestInit) =>
  new Request(`https://panel.example.ts.net${path}`, init) as NextRequest;
describe('same-origin dashboard proxy', () => {
  it('forwards authentication and the original HTTPS origin without leaking hop headers', async () => {
    vi.stubEnv('DASHBOARD_SCHEME', 'https');
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response('{"ok":true}', {
          headers: { 'set-cookie': 'sf_session=test; HttpOnly; Secure', connection: 'keep-alive' },
        }),
      );
    vi.stubGlobal('fetch', fetcher);
    const response = await POST(
      request('/api/auth/login?next=network', {
        method: 'POST',
        headers: {
          host: 'panel.example.ts.net',
          origin: 'https://panel.example.ts.net',
          cookie: 'sf_session=old',
          connection: 'keep-alive',
        },
        body: '{}',
      }),
    );
    const [upstream, options] = fetcher.mock.calls[0]!;
    expect(upstream.toString()).toBe('http://127.0.0.1:8080/api/auth/login?next=network');
    expect(options.headers.get('x-forwarded-host')).toBe('panel.example.ts.net');
    expect(options.headers.get('x-forwarded-proto')).toBe('https');
    expect(options.headers.get('cookie')).toBe('sf_session=old');
    expect(options.headers.get('connection')).toBeNull();
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('passes multipart upload streams through without reading them into memory', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    const input = request('/api/servers', { method: 'POST', body: 'zip-bytes' });
    await POST(input);
    expect(fetcher.mock.calls[0]![1].body).toBe(input.body);
    expect(fetcher.mock.calls[0]![1].duplex).toBe('half');
    expect(await new Response(fetcher.mock.calls[0]![1].body).text()).toBe('zip-bytes');
  });
  it('replaces browser-supplied forwarding and proxy authentication headers', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    await POST(new Request('http://localhost:3000/api/me', { method: 'POST', headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '1.2.3.4', 'x-serverforge-proxy-token': 'forged', forwarded: 'for=1.2.3.4' } }) as NextRequest);
    const headers = fetcher.mock.calls[0][1].headers as Headers;
    expect(headers.get('x-forwarded-proto')).toBe('http');
    expect(headers.get('x-forwarded-for')).toBeNull();
    expect(headers.get('forwarded')).toBeNull();
    expect(headers.get('x-serverforge-proxy-token')).not.toBe('forged');
  });
  it('streams console events before the upstream connection ends', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(stream, {
            headers: {
              'content-type': 'text/event-stream',
              'content-encoding': 'gzip',
              'content-length': '999',
            },
          }),
        ),
    );
    const response = await GET(request('/api/servers/test/console/stream'));
    const reader = response.body!.getReader();
    controller!.enqueue(new TextEncoder().encode('data: live\n\n'));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: live\n\n');
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    controller!.close();
    await reader.cancel();
  });
  it('preserves authorization failures and provides a useful API outage message', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { message: 'Sign in' } }, { status: 401 }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetcher);
    expect((await GET(request('/api/me'))).status).toBe(401);
    const response = await GET(request('/api/me'));
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe('api_unavailable');
  });
});
