'use client';

import { useEffect, useRef, useState } from 'react';
import { streamUrl } from '@/lib/api';
import type { ServerState } from '@/components/server-status';

/**
 * The live server channel.
 *
 * Reconnects with backoff, keeps a bounded console buffer, and exposes the
 * three things the server page needs: state, console lines, and the latest
 * resource sample.
 */

export interface ConsoleLine {
  seq: number;
  at: number;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export interface Stats {
  timestamp: number;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  diskBytes: number;
  uptimeSeconds: number;
  players?: { online: number; max: number };
}

export interface InstallProgress {
  phase: string;
  percent: number;
  message: string;
  error?: string;
}

/** Console lines kept in memory. Beyond this the DOM starts to hurt. */
const MAX_LINES = 2000;

export function useServerStream(serverUid: string | null) {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<ServerState | null>(null);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsHistory, setStatsHistory] = useState<Stats[]>([]);
  const [install, setInstall] = useState<InstallProgress | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);

  useEffect(() => {
    if (!serverUid) return;

    /**
     * Scoped to this effect run rather than a ref.
     *
     * A ref shared across runs is reset by the next run, so a socket closing
     * *after* cleanup — which is normal under React's double-invoked effects
     * in development, and on any fast remount — would see the flag already
     * cleared and reconnect. That left two live sockets appending to the same
     * state, and every console line appeared twice.
     */
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;

      const socket = new WebSocket(streamUrl(`/api/servers/${serverUid}/stream`));
      socketRef.current = socket;

      socket.onopen = () => {
        setConnected(true);
        attemptRef.current = 0;
      };

      socket.onmessage = (event) => {
        let message: { type: string; data: unknown };
        try {
          message = JSON.parse(event.data as string);
        } catch {
          return;
        }

        switch (message.type) {
          case 'hello':
            setState((message.data as { state: ServerState }).state);
            break;

          case 'console.history':
            setLines(message.data as ConsoleLine[]);
            break;

          case 'console':
            setLines((current) => {
              const next = [...current, message.data as ConsoleLine];
              return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
            });
            break;

          case 'state': {
            const payload = message.data as { state: ServerState };
            setState(payload.state);
            // A finished install should clear the progress panel rather than
            // leave it stuck at 100%.
            if (!['installing', 'updating', 'creating'].includes(payload.state)) {
              setInstall(null);
            }
            break;
          }

          case 'stats': {
            const sample = message.data as Stats;
            setStats(sample);
            setStatsHistory((current) => [...current, sample].slice(-120));
            break;
          }

          case 'install':
            setInstall(message.data as InstallProgress);
            break;
        }
      };

      socket.onclose = (event) => {
        // Ignore a close from a socket we have already replaced; only the
        // current one is allowed to drive reconnection or the UI state.
        if (socketRef.current !== socket) return;

        setConnected(false);
        // 4401 means the session is gone — reconnecting would just loop.
        if (cancelled || event.code === 4401) return;

        const delay = Math.min(1000 * 2 ** attemptRef.current, 15_000);
        attemptRef.current += 1;
        setTimeout(() => {
          if (!cancelled) connect();
        }, delay);
      };

      socket.onerror = () => socket.close();
    };

    connect();

    return () => {
      cancelled = true;
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [serverUid]);

  return { connected, state, lines, stats, statsHistory, install, setState };
}
