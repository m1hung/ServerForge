'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { PageTitle } from '@/components/PageTitle';
import { api } from '@/lib/api';
import { useCurrentUser } from '@/components/Shell';
import {
  displayName,
  filterServers,
  joinAddress,
  memoryLabel,
  statusTone,
  type Server,
} from '@/lib/servers';

export default function HomePage() {
  const currentUser = useCurrentUser();
  const canCreate = !!currentUser && ['owner', 'admin'].includes(currentUser.role);
  const [servers, setServers] = useState<Server[] | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [game, setGame] = useState('all');
  const [view, setView] = useState<'list' | 'grid'>('list');

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      const data = await api<{ servers: Server[] }>('/api/servers', { signal });
      setServers(data.servers);
      setUpdated(new Date());
      setError('');
    } catch (err) {
      if (!signal?.aborted)
        setError(err instanceof Error ? err.message : 'Could not load servers.');
    } finally {
      if (!signal?.aborted) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (window.matchMedia('(max-width: 700px)').matches) setView('grid');
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => {
      if (!document.hidden) void refresh(controller.signal);
    }, 15000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);

  const items = servers ?? [];
  const running = items.filter((server) => server.state === 'running').length;
  const attention = items.filter((server) => statusTone(server.state) === 'danger').length;
  const memory = items.reduce((total, server) => total + server.memoryMib, 0);
  const cpu = items.reduce((total, server) => total + server.cpuCores, 0);
  const unlimitedMemory = items.some((server) => server.memoryMib === 0);
  const unlimitedCpu = items.some((server) => server.cpuCores === 0);
  const filtered = filterServers(items, query, status, game);
  const games = [...new Set(items.map((server) => server.gameId))].sort();
  const tabs = [
    { id: 'all', label: 'All servers', count: items.length },
    { id: 'running', label: 'Running', count: running },
    {
      id: 'offline',
      label: 'Offline',
      count: items.filter((server) => server.state === 'offline').length,
    },
    ...(attention ? [{ id: 'attention', label: 'Needs attention', count: attention }] : []),
  ];
  const stats = [
    {
      label: 'Total servers',
      value: items.length,
      icon: 'server' as const,
      detail: `${games.length} ${games.length === 1 ? 'game' : 'games'} in your workspace`,
      tone: 'orange',
    },
    {
      label: 'Running now',
      value: running,
      icon: 'activity' as const,
      detail: running ? 'Ready for your next session' : 'No servers running',
      tone: 'green',
    },
    {
      label: 'Memory allocated',
      value: `${Number((memory / 1024).toFixed(1))}${unlimitedMemory ? '+' : ''}`,
      unit: 'GiB',
      icon: 'memory' as const,
      detail: unlimitedMemory
        ? 'Plus servers with no memory limit'
        : 'Combined configured memory limits',
      tone: 'violet',
    },
    {
      label: 'CPU allocated',
      value: `${cpu}${unlimitedCpu ? '+' : ''}`,
      unit: 'cores',
      icon: 'cpu' as const,
      detail: unlimitedCpu ? 'Plus servers with no CPU limit' : 'Combined configured CPU limits',
      tone: 'blue',
    },
  ];

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR WORKSPACE, AT A GLANCE</div>
          <PageTitle>Overview</PageTitle>
          <p className="muted">Good games start with great servers. Let’s keep yours running.</p>
        </div>
        {canCreate && (
          <Link className="btn" href="/deploy">
            <Icon name="plus" size={18} />
            Deploy a server
          </Link>
        )}
      </div>
      <div className="stats-grid">
        {stats.map((stat) => (
          <div className="stat-card" key={stat.label}>
            <div className="stat-label">
              {stat.label}
              <span className={`stat-icon ${stat.tone}`}>
                <Icon name={stat.icon} size={18} />
              </span>
            </div>
            <div className="stat-value">
              {servers ? stat.value : '—'}
              {stat.unit && <span>{stat.unit}</span>}
            </div>
            <div className="stat-detail">
              {stat.label === 'Running now' && (
                <span className={`status-dot ${running ? 'success' : 'neutral'}`} />
              )}
              {servers ? stat.detail : 'Waiting for server data'}
            </div>
          </div>
        ))}
      </div>
      <section className="server-section" id="servers" aria-labelledby="servers-title">
        <div className="section-heading">
          <div className="row">
            <h2 id="servers-title">Your servers</h2>
            <span className="count-badge">{servers?.length ?? '—'}</span>
          </div>
          <div className="row refresh-control">
            <span className="updated-label">
              {error
                ? 'Update unavailable'
                : updated
                  ? `Updated ${updated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                  : 'Connecting…'}
            </span>
            <button
              className="icon-button"
              title="Refresh servers"
              aria-label="Refresh servers"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <Icon name="refresh" size={17} className={refreshing ? 'spin' : ''} />
            </button>
          </div>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            <Icon name="alert" size={18} />
            <div>
              <strong>Couldn’t update your servers.</strong>
              <span>
                {error}
                {servers ? ' Showing the last available data.' : ''}
              </span>
            </div>
            <button className="text-button" disabled={refreshing} onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        )}
        <div className="server-panel">
          <div className="server-tabs" role="group" aria-label="Filter by server status">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={status === tab.id ? 'selected' : ''}
                aria-pressed={status === tab.id}
                onClick={() => setStatus(tab.id)}
              >
                {tab.label}
                <span>{servers ? tab.count : '—'}</span>
              </button>
            ))}
          </div>
          <div className="table-toolbar">
            <label className="search-input">
              <Icon name="search" size={18} />
              <input
                aria-label="Search servers"
                placeholder="Search servers…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button
                  className="icon-button"
                  aria-label="Clear search"
                  onClick={() => setQuery('')}
                >
                  <Icon name="close" size={15} />
                </button>
              )}
            </label>
            <div className="row toolbar-actions">
              <select
                aria-label="Filter by game"
                value={game}
                onChange={(event) => setGame(event.target.value)}
              >
                <option value="all">All games</option>
                {games.map((id) => (
                  <option key={id} value={id}>
                    {displayName(id)}
                  </option>
                ))}
              </select>
              <div className="view-toggle" role="group" aria-label="Server view">
                <button
                  className={view === 'list' ? 'selected' : ''}
                  aria-label="List view"
                  aria-pressed={view === 'list'}
                  onClick={() => setView('list')}
                >
                  <Icon name="list" size={18} />
                </button>
                <button
                  className={view === 'grid' ? 'selected' : ''}
                  aria-label="Grid view"
                  aria-pressed={view === 'grid'}
                  onClick={() => setView('grid')}
                >
                  <Icon name="grid" size={16} />
                </button>
              </div>
            </div>
          </div>
          {!servers && !error ? (
            <div className="loading-state" role="status">
              <div className="skeleton" />
              <div className="skeleton" />
              <div className="skeleton" />
              <span className="sr-only">Loading servers</span>
            </div>
          ) : !servers ? (
            <div className="empty-state">
              <span className="empty-icon">
                <Icon name="server" size={28} />
              </span>
              <h3>Let’s get you connected.</h3>
              <p>Your servers will appear here when the connection is restored.</p>
            </div>
          ) : !filtered.length ? (
            <div className="empty-state">
              <span className="empty-icon">
                <Icon name={items.length ? 'search' : 'server'} size={28} />
              </span>
              <h3>
                {items.length
                  ? 'No matching servers'
                  : canCreate
                    ? 'Your next adventure starts here.'
                    : 'No servers shared yet'}
              </h3>
              <p>
                {items.length
                  ? 'Try another name, game, or server status.'
                  : canCreate
                    ? 'Deploy your first game server and bring your people together.'
                    : 'Ask your workspace owner to add shared server access to your account. You don’t need a dashboard account just to join a game.'}
              </p>
              {items.length ? (
                <button
                  className="btn secondary"
                  onClick={() => {
                    setQuery('');
                    setStatus('all');
                    setGame('all');
                  }}
                >
                  Clear filters
                </button>
              ) : canCreate ? (
                <Link className="btn" href="/deploy">
                  <Icon name="plus" size={17} />
                  Deploy your first server
                </Link>
              ) : null}
            </div>
          ) : view === 'list' ? (
            <div className="table-scroll">
              <table className="server-table">
                <thead>
                  <tr>
                    <th scope="col">Server name</th>
                    <th scope="col">Status</th>
                    <th scope="col">Resources</th>
                    <th scope="col">Connection</th>
                    <th scope="col">
                      <span className="sr-only">Manage server</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((server) => (
                    <tr key={server.uid}>
                      <td>
                        <Link className="server-name" href={`/servers/${server.uid}`}>
                          <span className={`game-icon game-${server.gameId}`}>
                            <Icon name="cube" size={23} />
                          </span>
                          <span>
                            <strong>{server.name}</strong>
                            <small>
                              {displayName(server.gameId)}
                              <span> · </span>
                              {displayName(server.variantId)}
                            </small>
                          </span>
                        </Link>
                      </td>
                      <td>
                        <span className={`status-pill ${statusTone(server.state)}`}>
                          <span className="status-dot" />
                          {displayName(server.state)}
                        </span>
                      </td>
                      <td>
                        <div className="resource-cell">
                          <span>
                            {memoryLabel(server.memoryMib)} <span className="muted">RAM</span>
                          </span>
                          <small>
                            {server.cpuCores || 'Unlimited'} CPU{' '}
                            {server.cpuCores === 1 ? 'core' : 'cores'}
                          </small>
                        </div>
                      </td>
                      <td>
                        <div className="connection-cell">
                          <code>{joinAddress(server) ?? 'Not assigned'}</code>
                          <small>{server.node?.name || 'Local machine'}</small>
                        </div>
                      </td>
                      <td>
                        <Link
                          className="icon-button manage-link"
                          href={`/servers/${server.uid}`}
                          aria-label={`Manage ${server.name}`}
                        >
                          <Icon name="arrow" size={18} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="server-card-grid">
              {filtered.map((server) => (
                <Link className="server-grid-card" key={server.uid} href={`/servers/${server.uid}`}>
                  <div className="section-heading">
                    <span className={`game-icon game-${server.gameId}`}>
                      <Icon name="cube" size={23} />
                    </span>
                    <span className={`status-pill ${statusTone(server.state)}`}>
                      <span className="status-dot" />
                      {displayName(server.state)}
                    </span>
                  </div>
                  <h3>{server.name}</h3>
                  <p className="muted">
                    {displayName(server.gameId)} · {displayName(server.variantId)}
                  </p>
                  <div className="grid-resources">
                    <span>
                      <Icon name="memory" size={15} />
                      {memoryLabel(server.memoryMib)}
                    </span>
                    <span>
                      <Icon name="cpu" size={15} />
                      {server.cpuCores || 'Unlimited'} {server.cpuCores === 1 ? 'core' : 'cores'}
                    </span>
                  </div>
                  <div className="grid-card-footer">
                    <code>{joinAddress(server) ?? 'Not assigned'}</code>
                    <Icon name="arrow" size={16} />
                  </div>
                </Link>
              ))}
            </div>
          )}
          {servers && (
            <div className="table-footer">
              <span aria-live="polite">
                Showing {filtered.length} of {items.length} servers
              </span>
              <span>
                <Icon name="refresh" size={13} />
                Refreshes every 15 seconds
              </span>
            </div>
          )}
        </div>
      </section>
      <div className="overview-bottom">
        <section className="resource-summary">
          <div className="section-heading">
            <h2>Workspace snapshot</h2>
            <Icon name="activity" size={18} />
          </div>
          <p className="muted">A little perspective on what you’re running.</p>
          <div className="snapshot-bar" aria-hidden="true">
            {items.length ? (
              items.map((server) => (
                <span
                  key={server.uid}
                  className={
                    server.state === 'running'
                      ? 'success'
                      : server.state === 'offline'
                        ? 'neutral'
                        : 'warning'
                  }
                  style={{ flex: 1 }}
                />
              ))
            ) : (
              <span className="segment-empty" />
            )}
          </div>
          <div className="snapshot-legend">
            <span>
              <i className="legend-dot success" />
              {servers ? running : '—'} running
            </span>
            <span>
              <i className="legend-dot neutral" />
              {servers ? items.filter((server) => server.state === 'offline').length : '—'} offline
            </span>
            <span>
              <i className="legend-dot warning" />
              {servers
                ? items.length -
                  running -
                  items.filter((server) => server.state === 'offline').length
                : '—'}{' '}
              other states
            </span>
          </div>
          <div className="snapshot-note">
            <Icon name="memory" size={15} />
            Resource totals reflect configured limits, not live usage.
          </div>
        </section>
        {canCreate && (
          <section className="deploy-promo">
            <div className="promo-copy">
              <span className="eyebrow">BUILD SOMETHING WORTH JOINING</span>
              <h2>
                New game. New world.
                <br />
                Same crew.
              </h2>
              <p>Your next server is a few clicks away.</p>
              <Link href="/deploy" className="promo-link">
                Deploy a server
                <Icon name="arrow" size={17} />
              </Link>
            </div>
            <div className="server-art" aria-hidden="true">
              <div className="art-orbit" />
              <div className="art-server">
                <span />
                <i />
                <i />
              </div>
              <div className="art-server">
                <span />
                <i />
                <i />
              </div>
              <div className="art-server">
                <span />
                <i />
                <i />
              </div>
              <span className="art-spark">+</span>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
