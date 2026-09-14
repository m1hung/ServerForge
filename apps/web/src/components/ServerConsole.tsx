'use client';

import { useEffect, useRef, useState } from 'react';
import { apiBase } from '@/lib/api';
import type { Server } from '@/lib/servers';
import { Icon } from './Icon';

type Line = { line: string; stream: string };

export function ServerConsole({ server }: { server: Server }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState('Connecting…');
  const [following, setFollowing] = useState(true);
  const output = useRef<HTMLPreElement>(null);
  const allowed = server.console?.canRead !== false;

  useEffect(() => {
    setLines([]);
    if (!allowed) {
      setStatus('Console access required');
      return;
    }
    setStatus('Connecting…');
    const events = new EventSource(`${apiBase()}/api/servers/${server.uid}/console/stream`, {
      withCredentials: true,
    });
    events.addEventListener('reset', () => {
      setLines([]);
      setStatus('Live');
    });
    events.addEventListener('lines', (event) => {
      const batch = JSON.parse(event.data) as Line[];
      setLines((previous) => [...previous, ...batch].slice(-500));
    });
    events.addEventListener('status', (event) => {
      setStatus(JSON.parse(event.data) === 'installing' ? 'Installing' : 'Log history');
    });
    events.addEventListener('notice', (event) => setStatus(JSON.parse(event.data) as string));
    events.onerror = () =>
      setStatus(
        events.readyState === EventSource.CLOSED
          ? 'Console unavailable. Check your session and permissions, then reload.'
          : 'Reconnecting…',
      );
    return () => events.close();
  }, [server.uid, server.containerId, server.state, allowed]);

  useEffect(() => {
    if (following && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [lines, following]);

  return (
    <>
      <div className="console-toolbar console-heading">
        <h2
          id="console-title"
          title="Latest 500 lines · stdout & stderr · reconnects automatically"
        >
          <Icon name="terminal" size={17} />
          Server console
        </h2>
        <div className="row">
          <span
            className={`console-stream-status ${status === 'Live' || status === 'Installing' ? 'is-live' : ''}`}
            role="status"
          >
            <span className="status-dot" />
            {status}
          </span>
          <button
            className="text-button"
            onClick={() => setFollowing(!following)}
            aria-pressed={following}
          >
            {following ? 'Pause scrolling' : 'Follow latest'}
          </button>
        </div>
      </div>
      <pre
        ref={output}
        className="console-output live-console-output"
        role="log"
        aria-label="Server console logs"
        aria-describedby="console-description"
        aria-live="off"
        tabIndex={0}
        onScroll={() => {
          const el = output.current;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 40) setFollowing(false);
        }}
      >
        {lines.length ? (
          lines.map((entry, index) => (
            <span key={index} className={entry.stream === 'stderr' ? 'console-stderr' : undefined}>
              {entry.line}
              {'\n'}
            </span>
          ))
        ) : (
          <span className="console-placeholder">
            {!allowed
              ? 'You need console permission to read this server’s logs.'
              : ['running', 'starting', 'installing'].includes(server.state)
                ? 'Waiting for server output… Logs will appear here as the server writes them.'
                : 'No recent logs. Start the server to see its console output.'}
          </span>
        )}
      </pre>
      <div id="console-description" className="sr-only">
        Latest 500 lines · stdout & stderr · reconnects automatically
      </div>
    </>
  );
}
