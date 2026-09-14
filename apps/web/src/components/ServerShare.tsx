'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { ServerConnections } from '@serverforge/core/connectivity';
import { api, apiBase } from '@/lib/api';
import { displayName, type Server } from '@/lib/servers';
import { Icon } from './Icon';
import { CopyButton } from './CopyButton';

export function ServerShare({ server, onSaved }: { server: Server; onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn secondary small server-share-button" onClick={() => setOpen(true)}>
        <Icon name="share" size={15} />
        Share
      </button>
      {open && <ShareDialog server={server} onSaved={onSaved} onClose={() => setOpen(false)} />}
    </>
  );
}
function ShareDialog({
  server,
  onClose,
  onSaved,
}: {
  server: Server;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<ServerConnections | null>(null);
  const [kind, setKind] = useState<'local' | 'public' | 'tailscale'>('local');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [qr, setQr] = useState(false);
  const [port, setPort] = useState(
    String(server.allocations?.find((row) => row.primary)?.port ?? ''),
  );
  const [portNotice, setPortNotice] = useState('');
  const refresh = useCallback(
    async () => setData(await api<ServerConnections>(`/api/servers/${server.uid}/connections`)),
    [server.uid],
  );
  useEffect(() => {
    dialog.current?.showModal();
    void refresh().catch((error) => setError(error.message));
    const timer = setInterval(() => void refresh().catch(() => undefined), 10000);
    return () => clearInterval(timer);
  }, [refresh]);
  const selected = data?.addresses.find((row) => row.kind === kind);
  const invite = selected?.address
    ? `${server.name}\n${displayName(server.gameId)} · ${displayName(server.variantId)} · ${server.version}\nJoin: ${selected.address}\n${kind === 'local' ? 'Connect to the same local network.' : kind === 'tailscale' ? 'Connect to Tailscale with access to this host before joining.' : 'Connect using the public server address.'}`
    : '';
  async function togglePublic(enabled: boolean) {
    setBusy(true);
    setError('');
    try {
      setData(
        await api<ServerConnections>(`/api/servers/${server.uid}/connections`, {
          method: 'PATCH',
          body: JSON.stringify({ publicAccess: enabled }),
        }),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not update public access.');
    } finally {
      setBusy(false);
    }
  }
  async function savePort(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setPortNotice('');
    try {
      setData(
        await api<ServerConnections>(`/api/servers/${server.uid}/connections/port`, {
          method: 'PUT',
          body: JSON.stringify({ port: Number(port) }),
        }),
      );
      onSaved?.();
      setPortNotice('Game port saved. Share the updated address with your players.');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not change the game port.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="guide-dialog share-dialog"
      aria-labelledby="share-title"
      onClose={onClose}
    >
      <div className="section-heading">
        <span className="eyebrow">BRING YOUR FRIENDS</span>
        <button
          className="icon-button"
          aria-label="Close sharing"
          onClick={() => dialog.current?.close()}
        >
          <Icon name="close" />
        </button>
      </div>
      <h2 id="share-title">Share {server.name}</h2>
      <p className="share-subtitle">Choose how your players will connect.</p>
      <div className="share-tabs" aria-label="Connection type">
        {(['local', 'public', 'tailscale'] as const).map((value) => (
          <button
            key={value}
            aria-pressed={kind === value}
            onClick={() => {
              setKind(value);
              setQr(false);
            }}
          >
            <Icon
              name={value === 'local' ? 'network' : value === 'public' ? 'globe' : 'shield'}
              size={16}
            />
            {value === 'local'
              ? 'Local network'
              : value === 'public'
                ? 'Public internet'
                : 'Tailscale'}
          </button>
        ))}
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {!data ? (
        <p className="network-muted" role="status">
          Finding connection addresses…
        </p>
      ) : (
        <>
          <div className="share-address-block">
            <span className="eyebrow">{selected?.label.toUpperCase()} ADDRESS</span>
            {selected?.address ? (
              <>
                <div className="share-address">
                  <code>{selected.address}</code>
                  <CopyButton value={selected.address} label="Copy address" />
                </div>
                <div className="share-actions">
                  <CopyButton value={invite} label="Copy invite" className="network-text-link" />
                  <button
                    className="network-text-link"
                    aria-expanded={qr}
                    onClick={() => setQr(!qr)}
                  >
                    <Icon name="qr" size={16} />
                    {qr ? 'Hide QR code' : 'Show QR code'}
                  </button>
                </div>
                {qr && (
                  <div className="share-qr">
                    {/* QR responses require the user’s session cookie and are already SVG. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`${apiBase()}/api/servers/${server.uid}/connections/qr?kind=${kind}`}
                      width={176}
                      height={176}
                      alt={`QR code for ${selected.address}`}
                    />
                    <span>Scan to copy the join address.</span>
                  </div>
                )}
              </>
            ) : (
              <div className="share-unavailable">
                <Icon name={kind === 'tailscale' ? 'shield' : 'network'} size={25} />
                <strong>Set up this connection first</strong>
                <span>
                  {kind === 'tailscale'
                    ? 'Connect the game host to Tailscale to share a private game address.'
                    : 'A connection address is not available yet.'}
                </span>
              </div>
            )}
          </div>
          <p className="share-connection-note">
            <Icon name="book" size={16} />
            <span>{selected?.note}</span>
          </p>
          {kind === 'public' && (
            <div className="share-public">
              <label className="network-switch-row">
                <div>
                  <strong>Automatic public access</strong>
                  <span>
                    {data.upnpEnabled
                      ? 'Open this game’s router ports while the server runs.'
                      : 'A workspace administrator must enable UPnP first.'}
                  </span>
                </div>
                <input
                  className="network-switch"
                  type="checkbox"
                  role="switch"
                  checked={data.publicAccess}
                  disabled={busy || !data.canManage || (!data.upnpEnabled && !data.publicAccess)}
                  onChange={(event) => void togglePublic(event.target.checked)}
                />
              </label>
              {data.forwards.length ? (
                <div className="share-forward-list">
                  {data.forwards.map((row) => (
                    <div key={`${row.port}-${row.protocol}`}>
                      <span
                        className={`network-badge ${row.state === 'active' ? 'good' : ['error', 'conflict'].includes(row.state) ? 'warn' : ''}`}
                      >
                        {row.port}/{row.protocol} · {row.state}
                      </span>
                      {row.error && <p>{row.error}</p>}
                    </div>
                  ))}
                </div>
              ) : (
                data.publicAccess && (
                  <p className="network-muted">
                    {['running', 'starting'].includes(server.state)
                      ? 'Waiting for the router. Check Network & access if no rules appear.'
                      : 'Your router rules will open when this server starts.'}
                  </p>
                )
              )}
              <p className="network-fine-print">
                Turning this off removes rules created by ServerForge. Manually configured router
                rules are managed in your router.
              </p>
            </div>
          )}
          <div className="share-ports">
            <span>Required game ports</span>
            <div>
              {data.ports.map((port) => (
                <code key={`${port.port}-${port.protocol}`}>
                  {port.port}/{port.protocol}
                  <small>{port.purpose === 'query' ? 'discovery' : port.purpose}</small>
                </code>
              ))}
            </div>
          </div>
          {data.canManage && (
            <details className="network-advanced">
              <summary>Change game port</summary>
              <form onSubmit={(event) => void savePort(event)}>
                <p className="network-muted">
                  Stop the server first. Choose a port from this machine’s allocation pool; adjacent
                  ports for discovery and administration are reserved together.
                </p>
                <div className="row">
                  <label className="sr-only" htmlFor="share-game-port">
                    Game port
                  </label>
                  <input
                    id="share-game-port"
                    type="number"
                    min="1024"
                    max="65535"
                    required
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                    style={{ width: 130 }}
                  />
                  <button
                    className="btn secondary small"
                    disabled={busy || !['offline', 'crashed'].includes(server.state)}
                  >
                    Save game port
                  </button>
                </div>
                {portNotice && (
                  <p className="network-muted" role="status">
                    {portNotice}
                  </p>
                )}
              </form>
            </details>
          )}
          <div className="share-footer">
            <span>
              <i className={`state-dot ${server.state === 'running' ? 'online' : ''}`} />
              {server.state === 'running' ? 'Server is running' : 'Start the server before joining'}
            </span>
            {data.canConfigureNetwork && (
              <Link href="/network" onClick={() => dialog.current?.close()}>
                Network settings
                <Icon name="arrow" size={14} />
              </Link>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
