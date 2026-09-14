import type { FastifyReply } from 'fastify';
import { stripAnsi, truncateLine } from '@serverforge/core';
import { prisma } from '@serverforge/db';
import type { LogHandle, RuntimeDriver } from '../runtime/types.js';

/** Called only after the route has checked server.console permission. */
export function streamConsole(
  reply: FastifyReply,
  server: { id: string; containerId: string | null; state: string },
  runtime: RuntimeDriver,
) {
  reply.hijack();
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(name, value);
  }
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  reply.raw.flushHeaders();
  let closed = false;
  let handle: LogHandle | undefined;
  let installTimer: ReturnType<typeof setTimeout> | undefined;
  let queue: { line: string; stream: string }[] = [];
  const send = (event: string, data: unknown) => {
    if (closed) return;
    if (reply.raw.writableLength > 1024 * 1024) return reply.raw.end();
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const flush = () => {
    if (!queue.length) return;
    send('lines', queue);
    queue = [];
  };
  const onLine = (line: string, stream: string) => {
    if (closed) return;
    queue.push({ line: truncateLine(stripAnsi(line)), stream });
    if (queue.length >= 100) flush();
  };
  const batch = setInterval(flush, 100);
  const heartbeat = setInterval(() => send('heartbeat', {}), 15_000);
  // Native EventSource reconnects and rechecks the session and permissions.
  const expiry = setTimeout(() => {
    flush();
    reply.raw.end();
  }, 60_000);
  reply.raw.on('close', () => {
    closed = true;
    clearInterval(batch);
    clearInterval(heartbeat);
    clearTimeout(expiry);
    clearTimeout(installTimer);
    handle?.close();
    queue = [];
  });
  send('reset', {});

  const fail = () => {
    flush();
    send('notice', 'Console unavailable. Reconnecting…');
    reply.raw.end();
  };
  if (server.containerId && server.state !== 'installing') {
    void runtime
      .streamLogs(server.containerId, {
        tail: 500,
        onLine,
        onEnd(error) {
          if (error) return fail();
          flush();
          send('status', 'ended');
        },
      })
      .then((attached) => {
        if (closed) attached.close();
        else handle = attached;
      })
      .catch(fail);
    return;
  }

  // Before the first game launch, the install transcript is the useful console.
  let cursor: bigint | undefined;
  const readInstall = async () => {
    const rows = await prisma.installLog.findMany({
      where: { serverId: server.id, ...(cursor !== undefined ? { id: { gt: cursor } } : {}) },
      orderBy: { id: cursor === undefined ? 'desc' : 'asc' },
      take: 500,
    });
    if (closed) return;
    if (cursor === undefined) rows.reverse();
    for (const row of rows) {
      onLine(`[${row.phase}] ${row.message}`, 'install');
      cursor = row.id;
    }
    flush();
    send('status', server.state === 'installing' ? 'installing' : 'ended');
    if (server.state === 'installing') {
      installTimer = setTimeout(() => void readInstall().catch(fail), 2000);
    }
  };
  void readInstall().catch(fail);
}
