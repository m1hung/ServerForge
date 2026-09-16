'use client';

import { useEffect, useRef, useState } from 'react';
import { apiBase } from '@/lib/api';
import type { Server } from '@/lib/servers';
import { Icon } from './Icon';
import { ConsoleCommands } from './ConsoleCommands';
import { usePreferences } from './Preferences';

type Line = { line: string; stream: string };

export function ServerConsole({
  server,
  canInsert,
  onInsert,
}: {
  server: Server;
  canInsert: boolean;
  onInsert: (command: string) => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState('Connecting…');
  const [following, setFollowing] = useState(true);
  const [query, setQuery] = useState('');
  const [stream, setStream] = useState('all');
  const { preferences, update } = usePreferences();
  const output = useRef<HTMLPreElement>(null);
  const allowed = server.console?.canRead !== false;
  const visibleLines = allowed
    ? lines.filter(
        (entry) =>
          (stream === 'all' || entry.stream === stream) &&
          entry.line.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : [];

  function download() {
    const blob = new Blob([visibleLines.map((entry) => entry.line).join('\n') + '\n'], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `serverforge-${server.uid}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  useEffect(() => {
    setQuery('');
    setStream('all');
    setFollowing(true);
  }, [server.uid]);

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
  }, [lines, following, query, stream, preferences.consoleWrap, preferences.consoleFontSize]);

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
          <ConsoleCommands server={server} canInsert={canInsert} onInsert={onInsert} />
        </div>
      </div>
      <div
        className="console-toolbar console-filter-toolbar"
        role="group"
        aria-label="Console display controls"
      >
        <label className="search-input">
          <Icon name="search" size={16} />
          <input
            type="search"
            aria-label="Filter console logs"
            placeholder="Find in recent logs…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              className="icon-button"
              aria-label="Clear log filter"
              onClick={() => setQuery('')}
            >
              <Icon name="close" size={15} />
            </button>
          )}
        </label>
        <select
          aria-label="Console output stream"
          value={stream}
          onChange={(event) => setStream(event.target.value)}
        >
          <option value="all">All output</option>
          <option value="stdout">Standard output</option>
          <option value="stderr">Standard error</option>
        </select>
        <select
          aria-label="Console text size"
          value={preferences.consoleFontSize}
          onChange={(event) => update({ consoleFontSize: Number(event.target.value) })}
        >
          {[12, 13, 15, 17].map((size) => (
            <option key={size} value={size}>
              {size} px
            </option>
          ))}
        </select>
        <label className="setting-checkbox">
          <input
            type="checkbox"
            checked={preferences.consoleWrap}
            onChange={(event) => update({ consoleWrap: event.target.checked })}
          />
          Wrap lines
        </label>
        <span className="muted console-line-count">
          {visibleLines.length} / {allowed ? lines.length : 0} lines
        </span>
        <button
          className="icon-button"
          title="Download visible logs (latest 500 lines only)"
          aria-label="Download visible logs"
          disabled={!visibleLines.length}
          onClick={download}
        >
          <Icon name="download" size={17} />
        </button>
      </div>
      <pre
        ref={output}
        className="console-output live-console-output"
        role="log"
        aria-label="Server console logs"
        aria-describedby="console-description"
        aria-live="off"
        tabIndex={0}
        style={{
          fontSize: preferences.consoleFontSize,
          whiteSpace: preferences.consoleWrap ? 'pre-wrap' : 'pre',
          overflowWrap: preferences.consoleWrap ? 'anywhere' : 'normal',
        }}
        onScroll={() => {
          const el = output.current;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 40) setFollowing(false);
        }}
      >
        {visibleLines.length ? (
          visibleLines.map((entry, index) => (
            <span key={index} className={entry.stream === 'stderr' ? 'console-stderr' : undefined}>
              {entry.line}
              {'\n'}
            </span>
          ))
        ) : (
          <span className="console-placeholder">
            {!allowed
              ? 'You need console permission to read this server’s logs.'
              : lines.length && (query || stream !== 'all')
                ? 'No matching lines in the latest 500. Clear the filter or choose All output.'
                : ['running', 'starting', 'installing'].includes(server.state)
                  ? 'Waiting for server output… Logs will appear here as the server writes them.'
                  : 'No recent logs. Start the server to see its console output.'}
          </span>
        )}
      </pre>
      <div id="console-description" className="sr-only">
        Latest 500 lines · stdout & stderr · reconnects automatically. Filters and downloads cover
        only these recent lines. Pause scrolling keeps collecting new output.
      </div>
    </>
  );
}
