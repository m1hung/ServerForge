'use client';
import { useCallback, useEffect, useState } from 'react';
import { ProtectedLink as Link } from '@/components/UnsavedChanges';
import { api } from '@/lib/api';
import { PageTitle } from '@/components/PageTitle';
import { CopyButton } from '@/components/CopyButton';
import { SecurityDialog } from '@/components/SecurityDialog';
import { useCurrentUser } from '@/components/Shell';
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
const checkNames: Record<string, string> = {
  database: 'Database',
  schema: 'Database version',
  collation: 'Database sorting',
  docker: 'Docker access',
  storage: 'Storage access',
  supervisor: 'Background operations',
  acceptingMutations: 'Accepting changes',
};
export default function SystemPage() {
  const currentUser = useCurrentUser();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [account, setAccount] = useState<{ totpEnabledAt: string | null } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [change, setChange] = useState<{ fullEnabled: boolean; fullHourUtc: number } | null>(null);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setStatus(await api<Status>('/api/system/status'));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'System status is unavailable.');
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    void api<{ user: { totpEnabledAt: string | null } }>('/api/account')
      .then((data) => setAccount(data.user))
      .catch((err) => setError(err.message));
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  const policy = status?.recovery.find((row) => row.key === 'recovery.schedule')?.value;
  const hasOperations =
    !!status &&
    (status.attention.length || status.installations.length || status.interruptedSchedules.length);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">HOST HEALTH & RECOVERY</div>
          <PageTitle>System status</PageTitle>
          <p className="muted">Check this host, protect your data, and resolve issues.</p>
        </div>
        <div className="form-actions">
          <a className="btn secondary" href="/api/system/status?download=1" download>
            Export diagnostics
          </a>
          <button className="btn secondary" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? 'Checking…' : 'Refresh'}
          </button>
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
          {status && ' Showing the last available status.'}
        </div>
      )}
      {notice && (
        <p className="notice-banner" role="status">
          {notice}
        </p>
      )}
      <div className="settings-page">
        <nav className="section-links" aria-label="System sections">
          <a href="#host-health">Host health</a>
          <a href="#operations">Needs attention</a>
          <a href="#recovery">Recovery & backups</a>
        </nav>
        <section className="card stack" id="host-health">
          <div className="section-heading">
            <h2>
              {status
                ? status.ok
                  ? 'Panel ready'
                  : 'Needs attention'
                : error
                  ? 'System status unavailable'
                  : 'Checking system…'}
            </h2>
            {status && (
              <span
                className={`status-pill ${error ? 'warning' : status.ok ? 'success' : 'danger'}`}
              >
                {error ? 'Status is stale' : status.ok ? 'Available' : 'Action needed'}
              </span>
            )}
          </div>
          {status && (
            <p className="muted">
              {status.mode === 'ready' || status.mode === 'running'
                ? 'Normal operation'
                : status.mode}{' '}
              · Docker {status.capabilities?.dockerVersion || 'unavailable'}
              {status.capabilities && ` · ${status.capabilities.architecture}`} · Updated{' '}
              {new Date(status.measuredAt).toLocaleTimeString()}
            </p>
          )}
          <div className="health-checks">
            {Object.entries(status?.checks || {}).map(([check, ok]) => (
              <div className="settings-item" key={check}>
                <strong>{checkNames[check] || check}</strong>
                <span className={`status-pill ${ok ? 'success' : 'danger'}`}>
                  {ok ? 'OK' : 'Unavailable'}
                </span>
              </div>
            ))}
          </div>
          {status?.checks.collation === false && (
            <p className="summary-notice warning">
              Database sorting needs maintenance. Run a backed-up upgrade with the supplied host
              launcher to rebuild its indexes before normal operation resumes.
            </p>
          )}
          {status?.capabilities &&
            (!status.capabilities.ioWeight || !status.capabilities.swapLimit) && (
              <p className="summary-notice warning">
                Some hardware controls are unavailable on this host. Open a server’s Settings
                section to see which limits can be applied.
              </p>
            )}
          <h3>Storage</h3>
          {status?.storage.map((disk) => (
            <div className="settings-item" key={disk.name}>
              <div>
                <strong>{disk.name}</strong>
                <p className="muted">
                  {disk.freeBytes === null
                    ? 'Measurement unavailable'
                    : `${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes || 0)}`}
                </p>
              </div>
              {disk.freeBytes !== null && disk.freeBytes < 2 * 1024 ** 3 && (
                <span className="status-pill danger">Low disk space</span>
              )}
            </div>
          ))}
        </section>
        <section className="card stack" id="operations">
          <h2>Needs attention</h2>
          {!status ? (
            <p className="muted">Waiting for a system check.</p>
          ) : (
            <>
              {!hasOperations && <p className="empty-note">No server operations need attention.</p>}
              {status.attention.map((server) => (
                <div className="settings-item" key={server.uid}>
                  <div>
                    <strong>{server.name}</strong>
                    {server.reasons.map((reason) => (
                      <p className="muted" key={reason}>
                        {reason}
                      </p>
                    ))}
                  </div>
                  <Link className="btn secondary" href={`/servers/${server.uid}`}>
                    Review server
                  </Link>
                </div>
              ))}
              {status.installations.map((attempt) => (
                <div className="settings-item" key={attempt.uid}>
                  <div>
                    <strong>
                      {attempt.server.name} · Installation {attempt.state}
                    </strong>
                    <p className="muted">{attempt.error}</p>
                  </div>
                  <Link className="btn secondary" href={`/servers/${attempt.server.uid}`}>
                    Review installation
                  </Link>
                </div>
              ))}
              {status.interruptedSchedules.map((schedule) => (
                <div className="settings-item" key={schedule.uid}>
                  <div>
                    <strong>
                      {schedule.server.name} · {schedule.name}
                    </strong>
                    <p className="muted">{schedule.lastRunError}</p>
                  </div>
                  <Link
                    className="btn secondary"
                    href={`/servers/${schedule.server.uid}#schedules`}
                  >
                    Review schedule
                  </Link>
                </div>
              ))}
              <p className="muted">
                {status.activeOperations.length} active server operations. Status refreshes every 15
                seconds.
              </p>
            </>
          )}
        </section>
        <section className="card stack" id="recovery">
          <h2>Recovery & backups</h2>
          <div className="settings-field-grid">
            <div className="recovery-product">
              <h3>Panel backup</h3>
              <p className="muted">
                Accounts, panel settings, and database. Runs daily and keeps seven successful
                copies. Games keep running.
              </p>
              <code>./serverforge backup</code>
              <CopyButton
                value="./serverforge backup"
                label="Copy panel backup command"
                text="Copy command"
              />
            </div>
            <div className="recovery-product">
              <h3>Full recovery bundle</h3>
              <p className="muted">
                Includes the panel and all game worlds, mods, and files. Stops games during capture,
                then resumes them. Keeps three successful bundles.
              </p>
              <code>./serverforge backup --full</code>
              <CopyButton
                value="./serverforge backup --full"
                label="Copy full backup command"
                text="Copy command"
              />
            </div>
          </div>
          <p className="field-hint">
            Run these on the host from the folder containing your serverforge launcher, with
            SERVERFORGE_HOME set to your installation directory. Keep a copy on another device:
            local backups alone cannot protect against losing this host. For one game, use its
            Backups & restore section.
          </p>
          {status && !status.recovery.some((row) => row.key === 'recovery.lastSuccess') && (
            <p className="summary-notice warning">
              No successful panel backup has been recorded yet. Create one before upgrading or
              changing this host.
            </p>
          )}
          {status?.recovery
            .filter((row) => row.key !== 'recovery.schedule')
            .map((row) => (
              <div className="settings-item" key={row.key}>
                <div>
                  <strong>
                    {row.key === 'recovery.lastSuccess'
                      ? 'Latest successful backup'
                      : 'Recovery attention'}
                  </strong>
                  <p className="muted break-text">
                    {String(row.value.id || row.value.message || 'Review host diagnostics')}
                    {row.value.at && ` · ${new Date(String(row.value.at)).toLocaleString()}`}
                  </p>
                </div>
              </div>
            ))}
          {currentUser?.role === 'owner' && status && (
            <details className="settings-details">
              <summary>Schedule full recovery bundles</summary>
              <p className="muted">
                Choose a daily maintenance window when it’s safe to briefly stop your games.
              </p>
              <form
                className="stack"
                key={String(policy?.fullEnabled) + String(policy?.fullHourUtc)}
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  setChange({
                    fullEnabled: form.get('enabled') === 'on',
                    fullHourUtc: Number(form.get('hour')),
                  });
                }}
              >
                <label className="setting-checkbox">
                  <input
                    name="enabled"
                    type="checkbox"
                    defaultChecked={policy?.fullEnabled === true}
                  />
                  Allow daily full backups in this maintenance window
                </label>
                <label>
                  Start hour (UTC)
                  <select name="hour" defaultValue={Number(policy?.fullHourUtc ?? 3)}>
                    {Array.from({ length: 24 }, (_, hour) => (
                      <option key={hour} value={hour}>
                        {String(hour).padStart(2, '0')}:00 UTC
                      </option>
                    ))}
                  </select>
                </label>
                <p className="field-hint">
                  Times use UTC throughout the year. Current time:{' '}
                  {new Date(status.measuredAt).toLocaleTimeString([], {
                    timeZone: 'UTC',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}{' '}
                  UTC.
                </p>
                <div className="form-actions">
                  <button className="btn" disabled={!account}>
                    Save maintenance window
                  </button>
                </div>
              </form>
            </details>
          )}
        </section>
      </div>
      {change && (
        <SecurityDialog
          title="Save maintenance window"
          description={
            change.fullEnabled
              ? `Full backups will run daily at ${String(change.fullHourUtc).padStart(2, '0')}:00 UTC. Running games will stop during the backup and resume afterward.`
              : 'Disable scheduled full backups. Daily panel backups will continue.'
          }
          requireCode={!!account?.totpEnabledAt}
          onClose={() => setChange(null)}
          onConfirm={async (proof) => {
            await api('/api/system/backup-policy', {
              method: 'PUT',
              body: JSON.stringify({ ...change, ...proof }),
            });
            setNotice('Maintenance window saved.');
            await refresh();
          }}
        />
      )}
    </>
  );
}
