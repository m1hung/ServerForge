'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ServerConsole } from '@/components/ServerConsole';
import { ServerResources } from '@/components/ServerResources';
import { ServerTools, serverTools, type ServerTool } from '@/components/ServerTools';
import { ServerConfiguration } from '@/components/ServerConfiguration';
import { ModsPanel } from '@/components/ModsPanel';
import { Shell } from '@/components/Shell';
import { Icon } from '@/components/Icon';
import { api } from '@/lib/api';
import { ServerShare } from '@/components/ServerShare';
import { InstallationStatus } from '@/components/InstallationStatus';
import { copyText } from '@/lib/clipboard';
import { displayName, joinAddress, memoryLabel, statusTone, type Server } from '@/lib/servers';

export default function ServerPage() {
  const { uid } = useParams<{ uid: string }>();
  const [server, setServer] = useState<Server | null>(null);
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [pending, setPending] = useState('');
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<'overview' | 'mods' | 'configuration' | ServerTool>('overview');

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ server: Server }>(`/api/servers/${uid}`);
      setServer(data.server);
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not refresh server.');
    }
  }, [uid]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function power(action: 'start' | 'stop' | 'restart') {
    if (pending) return;
    setError('');
    setPending(action);
    try {
      await api(`/api/servers/${uid}/power`, { method: 'POST', body: JSON.stringify({ action }) });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the server power state.');
    } finally {
      setPending('');
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!command.trim() || pending) return;
    setError('');
    setPending('command');
    try {
      const result = await api<{ output: string }>(`/api/servers/${uid}/console`, {
        method: 'POST',
        body: JSON.stringify({ command }),
      });
      setOutput(`> ${command}\n${result.output || 'Command sent.'}`);
      setCommand('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send command.');
    } finally {
      setPending('');
    }
  }

  const join = server ? joinAddress(server) : null;
  async function copyAddress() {
    if (!join) return;
    try {
      await copyText(join);
      setCopied(true);
    } catch {
      setError('Could not copy the address. Select it to copy manually.');
    }
  }

  return (
    <Shell>
      <div className="server-page">
        <div className="server-breadcrumb">
          <Link className="back-link" href="/#servers">
            <Icon name="arrow" size={15} />
            Back to servers
          </Link>
          {server && (
            <span>
              {server.node?.name || 'Local machine'} · {memoryLabel(server.diskMib)} disk budget
            </span>
          )}
        </div>
        {(error || loadError) && (
          <div className="error-banner" role="alert">
            <Icon name="alert" size={18} />
            <div>{error || loadError}</div>
            {loadError && (
              <button className="text-button" onClick={() => void refresh()}>
                Retry
              </button>
            )}
          </div>
        )}
        {!server ? (
          <div className="card empty-state" role="status">
            <Icon name="server" size={30} />
            <p className="muted">
              {loadError ? 'Server details are unavailable.' : 'Loading your server…'}
            </p>
          </div>
        ) : (
          <>
            {['creating', 'installing', 'install_failed'].includes(server.state) && (
              <InstallationStatus server={server} onChange={() => void refresh()} />
            )}
            <div className="page-heading server-detail-heading">
              <div className="server-identity">
                <span className={`game-icon game-${server.gameId}`}>
                  <Icon name="cube" size={28} />
                </span>
                <div>
                  <div className="server-title-row">
                    <h1 className="h1">{server.name}</h1>
                    <span className={`status-pill ${statusTone(server.state)}`}>
                      <span className="status-dot" />
                      {displayName(server.state)}
                    </span>
                  </div>
                  <p className="muted">
                    {displayName(server.gameId)} · {displayName(server.variantId)} ·{' '}
                    {server.version}
                  </p>
                </div>
              </div>
              <div className="row server-power">
                <button
                  className="btn"
                  disabled={
                    !!pending || server.busy || !['offline', 'crashed'].includes(server.state)
                  }
                  onClick={() => void power('start')}
                >
                  <Icon name="play" size={15} />
                  {pending === 'start' ? 'Starting…' : 'Start server'}
                </button>
                <button
                  className="btn secondary"
                  disabled={!!pending || server.busy || server.state !== 'running'}
                  onClick={() => void power('restart')}
                >
                  <Icon name="refresh" size={16} />
                  {pending === 'restart' ? 'Restarting…' : 'Restart'}
                </button>
                <button
                  className="btn secondary danger"
                  disabled={
                    !!pending || server.busy || !['running', 'starting'].includes(server.state)
                  }
                  onClick={() => void power('stop')}
                >
                  <Icon name="stop" size={14} />
                  {pending === 'stop' ? 'Stopping…' : 'Stop'}
                </button>
              </div>
            </div>
            <div className="server-view-bar">
              <div className="management-tabs" role="group" aria-label="Server management view">
                <button aria-pressed={view === 'overview'} onClick={() => setView('overview')}>
                  <Icon name="terminal" size={16} />
                  Overview
                </button>
                <button aria-pressed={view === 'mods'} onClick={() => setView('mods')}>
                  <Icon name="cube" size={16} />
                  Mods & plugins
                </button>
                <button
                  aria-pressed={view === 'configuration'}
                  onClick={() => setView('configuration')}
                >
                  <Icon name="settings" size={16} />
                  Configuration
                </button>
                <select
                  className="server-tools-select"
                  aria-label="More server tools"
                  value={serverTools.some((t) => t.id === view) ? view : ''}
                  onChange={(e) => setView(e.target.value as ServerTool)}
                >
                  <option value="" disabled>
                    More tools
                  </option>
                  {serverTools
                    .filter((t) => !server.permissions || server.permissions.includes(t.permission))
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                </select>
              </div>
              <div className="server-connect-actions">
                <div className="server-join join-address">
                  <span>Join</span>
                  <code>{join ?? 'No address assigned'}</code>
                  <button
                    className="icon-button"
                    disabled={!join}
                    title={copied ? 'Copied' : 'Copy join address'}
                    aria-label={copied ? 'Address copied' : 'Copy join address'}
                    onClick={() => void copyAddress()}
                  >
                    <Icon name={copied ? 'check' : 'copy'} size={15} />
                  </button>
                  <span className="sr-only" role="status">
                    {copied ? 'Address copied to clipboard.' : ''}
                  </span>
                </div>
                <ServerShare server={server} onSaved={() => void refresh()} />
              </div>
            </div>
            <div
              className="server-view server-configuration-view"
              hidden={view !== 'configuration'}
            >
              <ServerConfiguration key={server.uid} server={server} onSaved={refresh} />
            </div>
            {(!server.permissions || server.permissions.includes('server.files')) && (
              <div className="server-view server-tools-view" hidden={view !== 'files'}>
                <ServerTools server={server} tool="files" />
              </div>
            )}
            {view === 'configuration' || view === 'files' ? null : serverTools.some(
                (t) => t.id === view,
              ) ? (
              <div className="server-view server-tools-view">
                <ServerTools server={server} tool={view as ServerTool} />
              </div>
            ) : view === 'mods' ? (
              <div className="server-view server-mods-view">
                <ModsPanel key={server.uid} server={server} />
              </div>
            ) : (
              <div className="server-view server-overview-view">
                <ServerResources server={server} />
                <div className="server-management">
                  <section className="console-card" aria-labelledby="console-title">
                    <ServerConsole server={server} />
                    {output && (
                      <details className="command-response">
                        <summary>Last command response</summary>
                        <pre>{output}</pre>
                      </details>
                    )}
                    {server.console?.acceptsCommands === false && (
                      <p className="console-readonly">
                        {server.console.note || 'This game provides a read-only console.'}
                      </p>
                    )}
                    <form className="console-prompt" onSubmit={(event) => void send(event)}>
                      <span aria-hidden="true">❯</span>
                      <input
                        aria-label="Console command"
                        value={command}
                        onChange={(event) => setCommand(event.target.value)}
                        placeholder="Enter a command…"
                        disabled={
                          server.state !== 'running' ||
                          !!pending ||
                          server.console?.canRead === false ||
                          server.console?.acceptsCommands === false
                        }
                        autoComplete="off"
                      />
                      <button
                        className="btn secondary"
                        disabled={
                          !command.trim() ||
                          !!pending ||
                          server.state !== 'running' ||
                          server.console?.canRead === false ||
                          server.console?.acceptsCommands === false
                        }
                        type="submit"
                      >
                        {pending === 'command' ? 'Sending…' : 'Send'}
                        <Icon name="arrow" size={14} />
                      </button>
                    </form>
                  </section>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Shell>
  );
}
