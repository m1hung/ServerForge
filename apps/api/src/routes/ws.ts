import type { FastifyInstance } from 'fastify';
import { channels, subscriber } from '../lib/redis.js';
import { readConsoleBuffer } from '../lib/events.js';
import { requireServerAccess } from '../lib/auth.js';
import { logger } from '../lib/logger.js';

/**
 * The live channel.
 *
 * One WebSocket per open server page, carrying console lines, state changes,
 * resource samples and install progress. Multiplexing them means a page that
 * is watching an install does not need a second socket when it finishes and
 * the console starts.
 *
 * Subscriptions are reference-counted: ten people watching one server share a
 * single Redis subscription.
 */

type Handler = (channel: string, payload: string) => void;

const handlers = new Map<string, Set<Handler>>();
let listening = false;

function ensureListener(): void {
  if (listening) return;
  listening = true;
  subscriber.on('message', (channel, payload) => {
    for (const handler of handlers.get(channel) ?? []) {
      try {
        handler(channel, payload);
      } catch (error) {
        logger.warn({ error, channel }, 'websocket handler threw');
      }
    }
  });
}

async function subscribe(channelNames: string[], handler: Handler): Promise<() => void> {
  ensureListener();

  for (const channel of channelNames) {
    let set = handlers.get(channel);
    if (!set) {
      set = new Set();
      handlers.set(channel, set);
      await subscriber.subscribe(channel);
    }
    set.add(handler);
  }

  return () => {
    for (const channel of channelNames) {
      const set = handlers.get(channel);
      if (!set) continue;
      set.delete(handler);
      if (set.size === 0) {
        handlers.delete(channel);
        void subscriber.unsubscribe(channel);
      }
    }
  };
}

export async function websocketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:uid/stream', { websocket: true }, async (socket, request) => {
    const { uid } = request.params as { uid: string };

    // Authorisation happens before the first byte is sent. A rejected socket
    // closes with 4401 so the client can tell "signed out" from "network".
    let server;
    try {
      const access = await requireServerAccess(request, uid, 'server.view');
      server = access.server;
    } catch {
      socket.close(4401, 'not authorised');
      return;
    }

    const send = (type: string, data: unknown) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type, data, at: Date.now() }));
      }
    };

    send('hello', { serverUid: uid, state: server.state });

    // Replay recent console history so the panel is never blank on open.
    const history = await readConsoleBuffer(uid, 200);
    if (history.length > 0) send('console.history', history);

    const unsubscribe = await subscribe(
      [channels.console(uid), channels.state(uid), channels.stats(uid), channels.install(uid)],
      (channel, payload) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          return;
        }

        if (channel === channels.console(uid)) send('console', parsed);
        else if (channel === channels.state(uid)) send('state', parsed);
        else if (channel === channels.stats(uid)) send('stats', parsed);
        else if (channel === channels.install(uid)) send('install', parsed);
      },
    );

    // Heartbeat: proxies happily drop an idle WebSocket after 60s, and a
    // silently dead socket looks exactly like a frozen server to the user.
    const heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, 25_000);

    socket.on('message', (raw: Buffer) => {
      // The client may send `{"type":"ping"}` to measure latency. Console
      // commands deliberately go over HTTP so they are audited and rate
      // limited on the same path as everything else.
      try {
        const message = JSON.parse(raw.toString()) as { type?: string };
        if (message.type === 'ping') send('pong', {});
      } catch {
        /* ignore malformed frames */
      }
    });

    socket.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  /** Fleet-wide state feed for the dashboard list. */
  app.get('/api/stream', { websocket: true }, async (socket, request) => {
    try {
      const { requireAuth } = await import('../lib/auth.js');
      await requireAuth(request);
    } catch {
      socket.close(4401, 'not authorised');
      return;
    }

    const unsubscribe = await subscribe([channels.fleet()], (_channel, payload) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'state', data: JSON.parse(payload) }));
      }
    });

    const heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, 25_000);

    socket.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
