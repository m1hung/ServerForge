'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { NetworkConfiguration, NetworkReport } from '@serverforge/core/connectivity';
import { api } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { PageTitle } from '@/components/PageTitle';
import { CopyButton } from '@/components/CopyButton';

export default function NetworkPage() {
  const [report, setReport] = useState<NetworkReport | null>(null);
  const [draft, setDraft] = useState<NetworkConfiguration | null>(null);
  const [pending, setPending] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const refresh = useCallback(async (force = false) => {
    const data = await api<NetworkReport>(
      force ? '/api/network/refresh' : '/api/network',
      force ? { method: 'POST' } : {},
    );
    setReport(data);
    setDraft((previous) => previous ?? data.configuration);
  }, []);
  useEffect(() => {
    void refresh().catch((error) => setError(error.message));
    const timer = setInterval(() => {
      if (!document.hidden) void refresh().catch(() => undefined);
    }, 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function action(name: string, work: () => Promise<unknown>, success = '') {
    setPending(name);
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(success);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not complete this action.');
    } finally {
      setPending('');
    }
  }
  function update<K extends keyof NetworkConfiguration>(key: K, value: NetworkConfiguration[K]) {
    setDraft((previous) => previous && { ...previous, [key]: value });
  }
  const dirty =
    !!draft && !!report && JSON.stringify(draft) !== JSON.stringify(report.configuration);
  const tail = report?.tailscale;
  const dashboardLink = tail?.serving ? tail.dashboardUrl : tail?.directUrl;
  const activeRules = report?.forwards.filter((row) => row.state === 'active').length ?? 0;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">NETWORK & ACCESS</div>
          <PageTitle>Your servers, within reach</PageTitle>
          <p className="muted">Bring friends into your games. Take your dashboard with you.</p>
        </div>
        <button
          className="btn secondary"
          disabled={!!pending}
          onClick={() =>
            void action('refresh', () => refresh(true), 'Connection status refreshed.')
          }
        >
          <Icon name="refresh" size={16} />
          {pending === 'refresh' ? 'Checking…' : 'Check connections'}
        </button>
      </div>
      <div className="network-page">
        {error && (
          <div className="error-banner" role="alert">
            <Icon name="alert" size={18} />
            {error}
          </div>
        )}
        {notice && (
          <div className="network-notice" role="status">
            <Icon name="check" size={17} />
            {notice}
          </div>
        )}
        {!report || !draft ? (
          <div className="card network-loading" role="status">
            {error
              ? 'Network settings are available to workspace administrators.'
              : 'Checking host addresses and private access…'}
          </div>
        ) : (
          <>
            <div className="network-summary">
              <section className="network-status-card">
                <div className="network-card-top">
                  <span className="network-symbol">
                    <Icon name="network" size={21} />
                  </span>
                  <span className={`network-badge ${report.lanHost ? 'good' : ''}`}>
                    {report.lanHost ? 'Address available' : 'Setup needed'}
                  </span>
                </div>
                <h2>Local network</h2>
                <div className="network-address">{report.lanHost || 'Find your host'}</div>
                <p>Connect from the same Wi-Fi or wired network.</p>
                {report.lanHost && <CopyButton value={report.lanHost} label="Copy local IP" />}
              </section>
              <section className="network-status-card">
                <div className="network-card-top">
                  <span className="network-symbol orange">
                    <Icon name="globe" size={21} />
                  </span>
                  <span className={`network-badge ${report.router.behindNat ? 'warn' : ''}`}>
                    {report.router.behindNat
                      ? 'Double NAT detected'
                      : report.publicHost
                        ? 'Address available'
                        : 'Setup needed'}
                  </span>
                </div>
                <h2>Public internet</h2>
                <div className="network-address">{report.publicHost || 'No public address'}</div>
                <p>Game access through your router and host firewall.</p>
                {report.publicHost && (
                  <CopyButton value={report.publicHost} label="Copy public host" />
                )}
              </section>
              <section className="network-status-card">
                <div className="network-card-top">
                  <span className="network-symbol purple">
                    <Icon name="shield" size={21} />
                  </span>
                  <span className={`network-badge ${dashboardLink ? 'good' : ''}`}>
                    {dashboardLink ? (tail?.serving ? 'HTTPS ready' : 'Connected') : 'Setup needed'}
                  </span>
                </div>
                <h2>Tailscale</h2>
                <div className="network-address tailnet-name">
                  {dashboardLink || tail?.machineName || 'Your private connection'}
                </div>
                <p>
                  {dashboardLink && !tail?.serving
                    ? 'Use this full address, including http:// and the port. HTTPS is not enabled yet.'
                    : 'Encrypted dashboard access wherever you are.'}
                </p>
                {dashboardLink ? (
                  <a
                    className="btn secondary small"
                    href={dashboardLink}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open dashboard
                    <Icon name="arrow" size={15} />
                  </a>
                ) : (
                  <a className="network-text-link" href="#private-dashboard">
                    Set up private access
                    <Icon name="arrow" size={15} />
                  </a>
                )}
              </section>
            </div>
            <div className="network-workspace">
              <form
                className="card network-settings"
                onSubmit={(event) => {
                  event.preventDefault();
                  void action(
                    'save',
                    async () => {
                      const data = await api<NetworkReport>('/api/network', {
                        method: 'PUT',
                        body: JSON.stringify(draft),
                      });
                      setReport(data);
                      setDraft(data.configuration);
                    },
                    'Network settings saved. Router rules are being reconciled.',
                  );
                }}
              >
                <div className="network-section-title">
                  <span className="network-symbol orange">
                    <Icon name="globe" />
                  </span>
                  <div>
                    <h2>Public game access</h2>
                    <p>Let your router handle the port forwarding.</p>
                  </div>
                </div>
                <label className="network-switch-row">
                  <div>
                    <strong>Automatic port forwarding</strong>
                    <span>Allow UPnP for servers you choose to share publicly.</span>
                  </div>
                  <input
                    className="network-switch"
                    type="checkbox"
                    role="switch"
                    checked={draft.upnpEnabled}
                    onChange={(e) => update('upnpEnabled', e.target.checked)}
                  />
                </label>
                <div className={`network-router-note ${report.router.behindNat ? 'warn' : ''}`}>
                  <Icon name={report.router.available ? 'check' : 'alert'} size={18} />
                  <div>
                    <strong>
                      {report.router.available ? 'UPnP router detected' : 'Router setup needed'}
                    </strong>
                    <p>
                      {report.router.behindNat
                        ? 'Your router has a private or shared WAN address. UPnP cannot open the upstream NAT. Use Tailscale for private game access or ask your ISP for a public IPv4 address.'
                        : report.router.issue ||
                          'Rules are created when an opted-in server starts, renewed while it runs, and removed when it stops.'}
                    </p>
                  </div>
                </div>
                <div className="network-fields">
                  <label>
                    Local host IP
                    <input
                      value={draft.lanHost}
                      placeholder={report.lanHost || '192.168.1.20'}
                      onChange={(e) => update('lanHost', e.target.value)}
                    />
                    <span>The game machine’s LAN address. Leave blank to use host discovery.</span>
                  </label>
                  <label>
                    Public IP or hostname
                    <input
                      value={draft.publicHost}
                      placeholder={report.publicIp || 'play.example.com'}
                      onChange={(e) => update('publicHost', e.target.value)}
                    />
                    <span>
                      Optional custom domain or fixed IP. Otherwise the public IP is detected.
                    </span>
                  </label>
                </div>
                <details className="network-advanced">
                  <summary>Advanced connection settings</summary>
                  <div className="network-fields">
                    <label>
                      Router UPnP URL
                      <input
                        value={draft.routerUrl}
                        placeholder={
                          report.router.controlUrl || 'http://192.168.1.1:49152/rootDesc.xml'
                        }
                        onChange={(e) => update('routerUrl', e.target.value)}
                      />
                      <span>
                        Device description or WAN control URL. Router addresses are restricted to
                        your LAN.
                      </span>
                    </label>
                    <label>
                      Router lease duration
                      <select
                        value={draft.leaseSeconds}
                        onChange={(e) => update('leaseSeconds', Number(e.target.value))}
                      >
                        {![0, 3600, 86400].includes(draft.leaseSeconds) && (
                          <option value={draft.leaseSeconds}>{draft.leaseSeconds} seconds</option>
                        )}
                        <option value={3600}>1 hour · renewed automatically</option>
                        <option value={86400}>24 hours · renewed automatically</option>
                        <option value={0}>Permanent · removed when stopped</option>
                      </select>
                    </label>
                    <label>
                      Tailscale connection
                      <select
                        value={draft.tailscaleMode}
                        onChange={(e) =>
                          update(
                            'tailscaleMode',
                            e.target.value as NetworkConfiguration['tailscaleMode'],
                          )
                        }
                      >
                        <option value="auto">Automatic · prefer the host</option>
                        <option value="host">Existing host connection</option>
                        <option value="sidecar">Dedicated dashboard device</option>
                      </select>
                    </label>
                    <label>
                      Existing Tailscale dashboard URL
                      <input
                        value={draft.tailscaleUrl}
                        placeholder="https://machine.tailnet.ts.net"
                        onChange={(e) => update('tailscaleUrl', e.target.value)}
                      />
                    </label>
                    <label>
                      Host Tailscale game IP or hostname
                      <input
                        value={draft.tailscaleGameHost}
                        placeholder="100.64.0.10"
                        onChange={(e) => update('tailscaleGameHost', e.target.value)}
                      />
                      <span>
                        Use the game host’s Tailscale address, not the dedicated dashboard device.
                      </span>
                    </label>
                  </div>
                </details>
                <div className="network-form-footer">
                  <span>{dirty ? 'Unsaved changes' : 'Settings up to date'}</span>
                  <button className="btn" disabled={!!pending || !dirty}>
                    {pending === 'save' ? 'Saving…' : 'Save settings'}
                    <Icon name="check" size={16} />
                  </button>
                </div>
              </form>
              <section id="private-dashboard" className="card network-private">
                <div className="network-section-title">
                  <span className="network-symbol purple">
                    <Icon name="shield" />
                  </span>
                  <div>
                    <h2>Your dashboard, anywhere</h2>
                    <p>Encrypted access on your private tailnet.</p>
                  </div>
                </div>
                <div
                  className="tailnet-path"
                  role="img"
                  aria-label="Your device connects through Tailscale to ServerForge"
                >
                  <span>
                    <Icon name="globe" size={24} />
                    Your device
                  </span>
                  <i />
                  <span className="tailnet-path-center">
                    <Icon name="shield" size={26} />
                    Tailscale
                  </span>
                  <i />
                  <span>
                    <Icon name="server" size={24} />
                    ServerForge
                  </span>
                </div>
                {dashboardLink ? (
                  <div className="tailnet-connected">
                    <span className="network-badge good">
                      {tail?.serving ? 'Private HTTPS ready' : 'Connected over Tailscale'}
                    </span>
                    <h3>Your dashboard travels with you.</h3>
                    <p>
                      Sign in to Tailscale on your other device, then open this address. Your
                      ServerForge account is still required.
                      {!tail?.serving && ' Keep http:// and the port when entering the address.'}
                    </p>
                    <code>{dashboardLink}</code>
                    <div className="row">
                      <CopyButton value={dashboardLink} label="Copy dashboard link" />
                      <a
                        className="btn secondary small"
                        href={dashboardLink}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open
                        <Icon name="arrow" size={14} />
                      </a>
                    </div>
                    {!tail?.serving && (
                      <details className="network-advanced">
                        <summary>Add an HTTPS hostname</summary>
                        <p>
                          Your dashboard is available through the encrypted tailnet. For an HTTPS
                          browser address, run this from the ServerForge folder:
                        </p>
                        <div className="network-command">
                          <code>npm run network:setup -- --tailscale</code>
                          <CopyButton
                            value="npm run network:setup -- --tailscale"
                            label="Copy command"
                          />
                        </div>
                        <p>
                          Use the sudo command printed by Tailscale if host permissions require it,
                          then check connections here.
                        </p>
                      </details>
                    )}
                  </div>
                ) : (
                  <div className="tailnet-setup">
                    {tail?.mode === 'host' ? (
                      <>
                        <h3>Use your existing host connection</h3>
                        <p>
                          Your host’s Tailscale connection can carry dashboard and game traffic.
                          Enable its private HTTPS dashboard from the ServerForge folder:
                        </p>
                        <div className="network-command">
                          <code>npm run network:setup -- --tailscale</code>
                          <CopyButton
                            value="npm run network:setup -- --tailscale"
                            label="Copy command"
                          />
                        </div>
                        <p className="network-muted">
                          If Tailscale requests authorization, follow its link, then check
                          connections here.
                        </p>
                      </>
                    ) : (
                      <>
                        <ol className="tailnet-steps">
                          <li className={tail?.state === 'Running' ? 'done' : ''}>
                            <strong>Connect your dashboard device</strong>
                            <p>
                              Sign in with your Tailscale account. Existing tailnet access rules
                              apply.
                            </p>
                            {tail?.state !== 'Running' && (
                              <button
                                className="btn secondary small"
                                disabled={!!pending || !tail?.available}
                                onClick={() =>
                                  void action('connect', async () => {
                                    const data = await api<{ tailscale: NonNullable<typeof tail> }>(
                                      '/api/network/tailscale/connect',
                                      { method: 'POST' },
                                    );
                                    setReport(
                                      (previous) =>
                                        previous && { ...previous, tailscale: data.tailscale },
                                    );
                                  })
                                }
                              >
                                {pending === 'connect' ? 'Connecting…' : 'Connect Tailscale'}
                                <Icon name="arrow" size={15} />
                              </button>
                            )}
                            {tail?.loginUrl && (
                              <a
                                className="btn small"
                                href={tail.loginUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Authorize device
                                <Icon name="arrow" size={15} />
                              </a>
                            )}
                          </li>
                          <li className={tail?.httpsReady ? 'done' : ''}>
                            <strong>Enable private HTTPS</strong>
                            <p>
                              {tail?.httpsReady ? (
                                'HTTPS certificates are enabled for your tailnet.'
                              ) : (
                                <>
                                  Turn on MagicDNS and HTTPS certificates in{' '}
                                  <a
                                    className="network-text-link"
                                    href="https://login.tailscale.com/admin/dns"
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Tailscale DNS settings
                                  </a>
                                  , then check connections.
                                </>
                              )}
                            </p>
                          </li>
                          <li>
                            <strong>Open your dashboard from anywhere</strong>
                            <p>The dashboard stays private to your tailnet.</p>
                            <button
                              className="btn small"
                              disabled={!!pending || tail?.state !== 'Running' || !tail?.httpsReady}
                              onClick={() =>
                                void action(
                                  'serve',
                                  async () => {
                                    await api('/api/network/tailscale/serve', {
                                      method: 'POST',
                                      body: JSON.stringify({ enabled: true }),
                                    });
                                    await refresh(true);
                                  },
                                  'Private dashboard access enabled.',
                                )
                              }
                            >
                              {pending === 'serve' ? 'Enabling…' : 'Enable dashboard access'}
                              <Icon name="shield" size={15} />
                            </button>
                          </li>
                        </ol>
                      </>
                    )}
                    {tail?.error && <p className="network-muted">{tail.error}</p>}
                  </div>
                )}
                <div className="network-private-foot">
                  <Icon name="shield" size={16} />
                  <span>Private to your tailnet. Dashboard ports are never forwarded by UPnP.</span>
                </div>
                {tail?.serving && tail.mode === 'sidecar' && (
                  <button
                    className="network-text-link"
                    disabled={!!pending}
                    onClick={() =>
                      void action(
                        'disable',
                        async () => {
                          await api('/api/network/tailscale/serve', {
                            method: 'POST',
                            body: JSON.stringify({ enabled: false }),
                          });
                          await refresh(true);
                        },
                        'Private dashboard access disabled.',
                      )
                    }
                  >
                    Disable remote dashboard
                  </button>
                )}
              </section>
            </div>
            <section className="card network-rules">
              <div className="section-heading">
                <div>
                  <h2>Server sharing</h2>
                  <p>Choose public access from a server’s Share panel.</p>
                </div>
                <span className="network-badge">
                  {activeRules} active router {activeRules === 1 ? 'rule' : 'rules'}
                </span>
              </div>
              {report.servers.length ? (
                <div className="network-server-list">
                  {report.servers.map((server) => {
                    const rules = report.forwards.filter((row) => row.serverUid === server.uid);
                    return (
                      <div className="network-server-row" key={server.uid}>
                        <span className="network-symbol">
                          <Icon name="server" size={18} />
                        </span>
                        <div className="network-server-name">
                          <Link href={`/servers/${server.uid}`}>{server.name}</Link>
                          <span>
                            {server.state}
                            {server.publicAccess
                              ? ' · Automatic public access enabled'
                              : ' · Automatic public access off'}
                          </span>
                        </div>
                        <div className="network-rule-status">
                          {rules.length ? (
                            rules.map((rule) => (
                              <span
                                className={`network-badge ${rule.state === 'active' ? 'good' : ['error', 'conflict'].includes(rule.state) ? 'warn' : ''}`}
                                key={`${rule.port}-${rule.protocol}`}
                                title={
                                  rule.error || `Last confirmed ${rule.verifiedAt || 'not yet'}`
                                }
                              >
                                {rule.port}/{rule.protocol} · {rule.state}
                              </span>
                            ))
                          ) : (
                            <span className="network-muted">
                              {server.publicAccess && report.configuration.upnpEnabled
                                ? ['running', 'starting'].includes(server.state)
                                  ? 'Awaiting router connection'
                                  : 'Rules open when started'
                                : 'No automatic rules'}
                            </span>
                          )}
                        </div>
                        <Link
                          className="icon-button"
                          href={`/servers/${server.uid}`}
                          aria-label={`Open ${server.name}`}
                        >
                          <Icon name="arrow" size={18} />
                        </Link>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="network-empty">
                  <Icon name="server" size={28} />
                  <p>Your next game night starts with a server.</p>
                  <Link className="btn secondary small" href="/deploy">
                    Deploy a server
                    <Icon name="plus" size={15} />
                  </Link>
                </div>
              )}
              <p className="network-fine-print">
                Router rules confirm forwarding configuration, not internet reachability. Only game
                traffic and explicitly declared discovery ports are forwarded. Console and
                administration ports stay private.
              </p>
            </section>
            <div className="network-checked">
              <Icon name="activity" size={14} />
              Checked{' '}
              {new Date(report.checkedAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
              {report.hostDetectedAt && (
                <span>Host discovery: {new Date(report.hostDetectedAt).toLocaleString()}</span>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
