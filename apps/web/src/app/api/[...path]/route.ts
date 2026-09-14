import type { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const hopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

async function proxy(request: NextRequest) {
  const url = new URL(request.url);
  const upstream = new URL(process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:8080');
  upstream.pathname = url.pathname;
  upstream.search = url.search;
  const headers = new Headers(request.headers);
  for (const name of hopHeaders) headers.delete(name);
  headers.delete('host');
  for (const key of [...headers.keys()]) if (key.startsWith('x-forwarded-') || ['forwarded', 'x-real-ip', 'x-serverforge-proxy-token'].includes(key)) headers.delete(key);
  headers.set('x-forwarded-host', request.headers.get('host') ?? url.host);
  headers.set(
    'x-forwarded-proto',
    process.env.DASHBOARD_SCHEME === 'https' ? 'https' : 'http',
  );
  if (process.env.SESSION_SECRET) headers.set('x-serverforge-proxy-token', createHmac('sha256', process.env.SESSION_SECRET).update('serverforge-web-proxy-v1').digest('hex'));
  try {
    const response = await fetch(upstream, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      // Stream ZIP uploads and console responses instead of buffering them in the dashboard.
      duplex: 'half',
      redirect: 'manual',
      cache: 'no-store',
      signal: request.signal,
    } as RequestInit & { duplex: 'half' });
    const outgoing = new Headers(response.headers);
    for (const name of hopHeaders) outgoing.delete(name);
    // fetch transparently decompresses upstream bodies.
    outgoing.delete('content-encoding');
    outgoing.delete('content-length');
    outgoing.set('cache-control', 'no-store');
    outgoing.set('x-accel-buffering', 'no');
    return new Response(response.body, { status: response.status, headers: outgoing });
  } catch {
    return Response.json(
      {
        error: {
          code: 'api_unavailable',
          message: 'The server manager is reconnecting. Try again in a moment.',
        },
      },
      { status: 502 },
    );
  }
}

export {
  proxy as GET,
  proxy as HEAD,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
  proxy as OPTIONS,
};
