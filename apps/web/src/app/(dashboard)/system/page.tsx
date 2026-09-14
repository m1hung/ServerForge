'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { PageTitle } from '@/components/PageTitle';
import { formatBytes } from '@serverforge/core/format';
type Status = {
  measuredAt: string;
  attention: { uid: string; name: string; reasons: string[] }[];
  ok: boolean;
  mode: string;
  checks: Record<string, boolean>;
  activeOperations: string[];
  capabilities: {
    architecture: string;
    dockerVersion: string;
    ioWeight: boolean;
    swapLimit: boolean;
  } | null;
  storage: { name: string; freeBytes: number | null; totalBytes: number | null }[];
  recovery: { key: string; value: Record<string, string | number | boolean> }[];
  installations: {
    uid: string;
    state: string;
    error: string;
    server: { uid: string; name: string };
  }[];
  interruptedSchedules: {
    uid: string;
    name: string;
    lastRunError: string;
    server: { uid: string; name: string };
  }[];
};
export default function SystemPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [owner, setOwner] = useState(false);
  const [pending, setPending] = useState(false);
  const refresh = useCallback(async () => {
    const [data, account] = await Promise.all([
      api<Status>('/api/system/status'),
      api<{ user: { role: string } }>('/api/me'),
    ]);
    setStatus(data);
    setOwner(account.user.role === 'owner');
    setError('');
  }, []);
  useEffect(() => {
    void refresh().catch((err) => setError(err.message));
    const timer = setInterval(() => void refresh().catch((err) => setError(err.message)), 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  const policy = status?.recovery.find((row) => row.key === 'recovery.schedule')?.value;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">HOST HEALTH & RECOVERY</div>
          <PageTitle>System status</PageTitle>
          <p className="muted">Host health, recovery, and operations that need attention.</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
        <a className="btn secondary" href="/api/system/status?download=1" download>Export diagnostics</a>
        <button
          className="btn secondary"
          onClick={() => void refresh().catch((err) => setError(err.message))}
        >
          Refresh
        </button>
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="stack" style={{ maxWidth: 1100 }}>
        <section className="card stack">
          <h2>{status ? (status.ok ? 'Panel ready' : 'Needs attention') : 'Checking system…'}</h2>
          <p className="muted">
            {status?.mode} · Docker {status?.capabilities?.dockerVersion || 'unavailable'} ·{' '}
            {status?.capabilities?.architecture}
          </p>
          <div className="row" style={{ flexWrap: 'wrap', gap: 16 }}>
            {Object.entries(status?.checks || {}).map(([check, ok]) => (
              <span key={check} className={`status-pill ${ok ? 'online' : 'offline'}`}>
                {check}: {ok ? 'OK' : 'Unavailable'}
              </span>
            ))}
          </div>
          {status?.capabilities &&
            (!status.capabilities.ioWeight || !status.capabilities.swapLimit) && (
              <p className="summary-notice">
                Some resource controls are unavailable on this host. The hardware editor shows which
                limits Docker can enforce.
              </p>
            )}
        </section>
        <section className="card stack">
          <h2>Storage</h2>
          {status?.storage.map((disk) => (
            <div className="row" key={disk.name} style={{ justifyContent: 'space-between' }}>
              <strong>{disk.name}</strong>
              <span>
                {disk.freeBytes === null
                  ? 'Measurement unavailable'
                  : `${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes || 0)}`}
              </span>
              {disk.freeBytes !== null && disk.freeBytes < 2 * 1024 ** 3 && (
                <span className="error">Low disk space</span>
              )}
            </div>
          ))}
        </section>
        <section className="card stack">
          <h2>Recovery</h2>
          <p className="muted">
            Daily panel backups retain seven successful copies. Full bundles retain three and pause
            games while their files are captured. Keep a copy on another host.
          </p>
          {status?.recovery
            .filter((row) => row.key !== 'recovery.schedule')
            .map((row) => (
              <div key={row.key}>
                <strong>
                  {row.key === 'recovery.lastSuccess'
                    ? 'Latest successful backup'
                    : 'Recovery attention'}
                </strong>
                <p className="muted">
                  {String(row.value.id || row.value.message || 'Review host diagnostics')}{' '}
                  {row.value.at && `· ${new Date(String(row.value.at)).toLocaleString()}`}
                </p>
              </div>
            ))}
          {owner && (
            <form
              className="stack"
              key={String(policy?.fullEnabled) + String(policy?.fullHourUtc)}
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                setPending(true);
                void api('/api/system/backup-policy', {
                  method: 'PUT',
                  body: JSON.stringify({
                    fullEnabled: form.get('enabled') === 'on',
                    fullHourUtc: Number(form.get('hour')),
                    password: form.get('password'),
                    code: form.get('code'),
                  }),
                })
                  .then(() => {
                    setNotice('Recovery policy saved.');
                    return refresh();
                  })
                  .catch((err) => setError(err.message))
                  .finally(() => setPending(false));
              }}
            >
              <label className="row">
                <input
                  name="enabled"
                  type="checkbox"
                  defaultChecked={policy?.fullEnabled === true}
                />
                Allow daily full backups in this maintenance window
              </label>
              <label>
                Start hour (UTC)
                <input
                  name="hour"
                  type="number"
                  min={0}
                  max={23}
                  defaultValue={Number(policy?.fullHourUtc ?? 3)}
                  required
                />
              </label>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <label style={{ flex: 1 }}>
                  Current password
                  <input name="password" type="password" autoComplete="current-password" required />
                </label>
                <label style={{ flex: 1 }}>
                  Authenticator or recovery code
                  <input name="code" autoComplete="one-time-code" />
                </label>
              </div>
              <button className="btn" disabled={pending}>
                Save maintenance window
              </button>
            </form>
          )}
        </section>
        <section className="card stack">
          <h2>Operations</h2>
          {status?.attention.map((server) => (
            <div key={server.uid}>
              <Link href={`/servers/${server.uid}`}>{server.name}</Link>
              {server.reasons.map((reason) => <p className="summary-notice" key={reason}>{reason}</p>)}
            </div>
          ))}
          {!status?.installations.length && !status?.interruptedSchedules.length && (
            <p className="muted">No failed installations or schedules need attention.</p>
          )}
          {status?.installations.map((attempt) => (
            <div key={attempt.uid}>
              <Link href={`/servers/${attempt.server.uid}`}>
                {attempt.server.name}: {attempt.state}
              </Link>
              <p className="muted">{attempt.error}</p>
            </div>
          ))}
          {status?.interruptedSchedules.map((schedule) => (
            <div key={schedule.uid}>
              <Link href={`/servers/${schedule.server.uid}`}>
                {schedule.server.name}: {schedule.name}
              </Link>
              <p className="muted">{schedule.lastRunError}</p>
            </div>
          ))}
          <p className="muted">{status?.activeOperations.length || 0} active server operations.</p>
          {status && <p className="muted">Last checked {new Date(status.measuredAt).toLocaleTimeString()}{error ? ' · Status is stale' : ''}</p>}
        </section>
        <p className="muted">
          Run <code>serverforge diagnostics</code> on the host to create a redacted report without
          configuration, credentials, or raw game logs.
        </p>
      </div>
    </>
  );
}
