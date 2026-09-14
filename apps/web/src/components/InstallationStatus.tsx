'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Server } from '@/lib/servers';

type Attempt = {
  uid: string;
  state: string;
  phase: string;
  progress: number;
  message: string | null;
  error: string | null;
  cancelRequestedAt: string | null;
  hasUploadedPack: boolean;
};
export function InstallationStatus({ server, onChange }: { server: Server; onChange: () => void }) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [canRemove, setCanRemove] = useState(false);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const data = await api<{ installation: Attempt | null; canManage: boolean; canRemove: boolean }>(
          `/api/servers/${server.uid}/installation`,
        );
        if (!disposed) { setAttempt(data.installation); setCanEdit(data.canManage); setCanRemove(data.canRemove); }
      } catch (err) {
        if (!disposed)
          setError(err instanceof Error ? err.message : 'Installation status unavailable.');
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [server.uid]);
  const running = attempt && ['queued', 'running', 'finalizing'].includes(attempt.state);
  async function action(kind: 'retry' | 'cancel' | 'remove') {
    setPending(true);
    setError('');
    try {
      await api(`/api/servers/${server.uid}/installation${kind === 'remove' ? '' : `/${kind}`}`, { method: kind === 'remove' ? 'DELETE' : 'POST' });
      if (kind === 'remove') setAttempt(null);
      if (kind === 'retry') setAttempt((current) => current ? { ...current, state: 'queued', progress: 0, error: null, message: 'Preparing a fresh installation…', cancelRequestedAt: null } : current);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the installation.');
    } finally {
      setPending(false);
    }
  }
  return (
    <section
      className="card"
      aria-label="Installation progress"
      style={{ padding: '14px 18px', marginBottom: 12 }}
    >
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div role="status" style={{ flex: '1 1 240px' }}>
          <strong>
            {running
              ? attempt.cancelRequestedAt
                ? 'Cancelling installation…'
                : 'Installing server'
              : 'Installation needs attention'}
          </strong>
          <p className="muted" style={{ margin: '4px 0', fontSize: 13 }}>
            {attempt?.error ||
              attempt?.message ||
              'Review the console transcript, then retry the installation.'}
          </p>
          {attempt?.hasUploadedPack && !running && (
            <small className="muted">Your uploaded server pack is kept for retry.</small>
          )}
          {running && (
            <progress
              aria-label="Installation progress"
              max={100}
              value={attempt.progress || undefined}
              style={{ width: '100%', height: 5 }}
            />
          )}
        </div>
        {canEdit && (
          <div className="row">
            {running ? (
              <button
                className="btn secondary"
                disabled={pending || !!attempt.cancelRequestedAt || attempt.state === 'finalizing'}
                onClick={() => void action('cancel')}
              >
                {attempt.state === 'finalizing' ? 'Finishing safely…' : 'Cancel installation'}
              </button>
            ) : (
              <button
                className="btn"
                disabled={pending || server.busy}
                onClick={() => void action('retry')}
              >
                Retry installation
              </button>
            )}
            {!running && canRemove && attempt?.hasUploadedPack && (
              <button className="btn secondary" disabled={pending || server.busy} onClick={() => void action('remove')}>Remove uploaded pack</button>
            )}
          </div>
        )}
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
