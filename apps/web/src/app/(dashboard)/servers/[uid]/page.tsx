'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ServerConsole } from '@/components/ServerConsole';
import { ServerResources } from '@/components/ServerResources';
import { ServerTools, serverTools, type ServerTool } from '@/components/ServerTools';
import { ServerConfiguration } from '@/components/ServerConfiguration';
import { ModsPanel } from '@/components/ModsPanel';
import { Icon } from '@/components/Icon';
import { PageTitle } from '@/components/PageTitle';
import { api } from '@/lib/api';
import { ServerShare } from '@/components/ServerShare';
import { InstallationStatus } from '@/components/InstallationStatus';
import { copyText } from '@/lib/clipboard';
import { displayName, joinAddress, memoryLabel, statusTone, type Server } from '@/lib/servers';

export default function ServerPage() {
  const { uid } = useParams<{ uid: string }>();
  const [server, setServer] = useState<Server | null>(null);
  const [command, setCommand] = useState('');
  const commandInput = useRef<HTMLInputElement>(null);
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [pending, setPending] = useState('');
  const [copied, setCopied] = useState(false);
  type View = 'overview' | 'mods' | 'configuration' | ServerTool;
  const [view, setView] = useState<View>('overview');
  useEffect(() => {
    const readView = () => {
      const selected = window.location.hash.slice(1);
      setView(
        ['overview', 'mods', 'configuration', ...serverTools.map((tool) => tool.id)].includes(
          selected,
        )
          ? (selected as View)
          : 'overview',
      );
    };
    readView();
    window.addEventListener('hashchange', readView);
    return () => window.removeEventListener('hashchange', readView);
  }, [uid]);
  function selectView(next: View) {
    setView(next);
    window.location.hash = next;
  }
  const canPower = server?.permissions?.includes('server.power') ?? true;
  const selectedTool = serverTools.find((tool) => tool.id === view);
  const viewAllowed =
    view === 'configuration'
      ? server?.canConfigure !== false
      : !selectedTool ||
        !server?.permissions ||
        server.permissions.includes(selectedTool.permission);

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

  function insertCommand(template: string) {
    setCommand(template);
    requestAnimationFrame(() => {
      commandInput.current?.focus();
      const placeholder = /<[^>]+>/.exec(template);
      const start = placeholder?.index ?? template.length;
      commandInput.current?.setSelectionRange(start, start + (placeholder?.[0].length ?? 0));
    });
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
    <>
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
                    <PageTitle>{server.name}</PageTitle>
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
                    !canPower ||
                    !!pending ||
                    server.busy ||
                    !['offline', 'crashed'].includes(server.state)
                  }
                  onClick={() => void power('start')}
                >
                  <Icon name="play" size={15} />
                  {pending === 'start' ? 'Starting…' : 'Start server'}
                </button>
                <button
                  className="btn secondary"
                  disabled={!canPower || !!pending || server.busy || server.state !== 'running'}
                  onClick={() => void power('restart')}
                >
                  <Icon name="refresh" size={16} />
                  {pending === 'restart' ? 'Restarting…' : 'Restart'}
                </button>
                <button
                  className="btn secondary danger"
                  disabled={
                    !canPower ||
                    !!pending ||
                    server.busy ||
                    !['running', 'starting'].includes(server.state)
                  }
                  onClick={() => void power('stop')}
                >
                  <Icon name="stop" size={14} />
                  {pending === 'stop' ? 'Stopping…' : 'Stop'}
                </button>
              </div>
            </div>
            <div className="server-view-bar">
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
            {!canPower && (
              <p className="field-hint server-permission-note">
                You can use the sections shared with you below. Ask the server owner for access to
                power controls or additional tools.
              </p>
            )}
            <div
              className="management-tabs server-sections"
              role="group"
              aria-label="Server sections"
            >
              <button aria-pressed={view === 'overview'} onClick={() => selectView('overview')}>
                Overview
              </button>
              <button aria-pressed={view === 'mods'} onClick={() => selectView('mods')}>
                Mods & plugins
              </button>
              {server.canConfigure !== false && (
                <button
                  aria-pressed={view === 'configuration'}
                  onClick={() => selectView('configuration')}
                >
                  Configuration
                </button>
              )}
              {serverTools
                .filter(
                  (tool) => !server.permissions || server.permissions.includes(tool.permission),
                )
                .map((tool) => (
                  <button
                    key={tool.id}
                    aria-pressed={view === tool.id}
                    onClick={() => selectView(tool.id)}
                  >
                    {tool.label}
                  </button>
                ))}
            </div>
            {server.canConfigure !== false && (
              <div
                className="server-view server-configuration-view"
                hidden={view !== 'configuration'}
              >
                <ServerConfiguration key={server.uid} server={server} onSaved={refresh} />
              </div>
            )}
            {(!server.permissions || server.permissions.includes('server.files')) && (
              <div className="server-view server-tools-view" hidden={view !== 'files'}>
                <ServerTools server={server} tool="files" />
              </div>
            )}
            {!viewAllowed ? (
              <section className="card tool-panel">
                <h2>Access to this tool is required</h2>
                <p className="muted">
                  Ask a workspace administrator for access, or choose one of the available server
                  sections above.
                </p>
                <button className="btn secondary" onClick={() => selectView('overview')}>
                  Back to server overview
                </button>
              </section>
            ) : view === 'configuration' || view === 'files' ? null : serverTools.some(
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
                    <ServerConsole
                      server={server}
                      canInsert={server.state === 'running' && !pending}
                      onInsert={insertCommand}
                    />
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
                        ref={commandInput}
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
    </>
  );
}
