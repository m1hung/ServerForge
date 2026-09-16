'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { permissionLabels } from '@/lib/permission-labels';
import { PageTitle } from '@/components/PageTitle';
import { CopyButton } from '@/components/CopyButton';
import { SecurityDialog, type SecurityProof } from '@/components/SecurityDialog';
import { PreferencesSettings } from '@/components/Preferences';

type Account = {
  username: string;
  displayName: string;
  role: string;
  totpEnabledAt: string | null;
  recoveryCodesRemaining: number;
};
type Session = {
  id: string;
  userAgent: string | null;
  ip: string | null;
  expiresAt: string;
  current: boolean;
};
type ApiKey = {
  uid: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
};
type Change = { path: string; title: string; description: string; body?: object; method?: string };

export default function AccountPage() {
  const [user, setUser] = useState<Account | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [change, setChange] = useState<Change | null>(null);
  const [enrollment, setEnrollment] = useState<{ secret: string; qr: string } | null>(null);
  const [shownSecret, setShownSecret] = useState<{ title: string; value: string } | null>(null);
  const resultPanel = useRef<HTMLElement>(null);
  const enrollmentPanel = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    const [account, sessionData, keyData] = await Promise.all([
      api<{ user: Account }>('/api/account'),
      api<{ sessions: Session[] }>('/api/account/sessions'),
      api<{ keys: ApiKey[]; availableScopes: string[] }>('/api/account/api-keys'),
    ]);
    setUser(account.user);
    setSessions(sessionData.sessions);
    setKeys(keyData.keys);
    setScopes(keyData.availableScopes);
  }, []);
  useEffect(() => {
    void refresh().catch((err) => setError(err.message));
  }, [refresh]);

  async function confirm(proof: SecurityProof) {
    if (!change) return;
    const data = await api<{
      signInRequired?: boolean;
      secret?: string;
      qr?: string;
      recoveryCodes?: string[];
    }>(`/api/account/${change.path}`, {
      method: change.method || 'POST',
      body: JSON.stringify({ ...proof, ...change.body }),
    });
    if (
      data.signInRequired ||
      sessions.some((session) => session.current && change.path === `sessions/${session.id}`)
    ) {
      window.location.href = '/login';
      return;
    }
    if (data.qr && data.secret) setEnrollment({ secret: data.secret, qr: data.qr });
    else if (data.secret) setShownSecret({ title: 'Save your new API key', value: data.secret });
    if (data.recoveryCodes) {
      setShownSecret({ title: 'Save your recovery codes', value: data.recoveryCodes.join('\n') });
      setEnrollment(null);
    }
    setNotice(data.qr ? 'Scan the code below to finish setup.' : `${change.title} — done.`);
    setError('');
    await refresh().catch(() =>
      setError(
        'Your change was saved, but account details could not be refreshed. Reload before making another change.',
      ),
    );
  }
  function newKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const selected = form.getAll('scope');
    if (!selected.length) {
      setError('Choose at least one allowed action for this key.');
      return;
    }
    setChange({
      path: 'api-keys',
      title: 'Create API key',
      description: `Create “${form.get('name')}” with the actions you selected. The key will be shown once.`,
      body: { name: form.get('name'), scopes: selected, expiresInDays: Number(form.get('expiry')) },
    });
  }
  const unavailable = !user || !!shownSecret;
  const activeKeys = keys.filter((key) => !key.revokedAt);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR PROFILE & SECURITY</div>
          <PageTitle>Account</PageTitle>
          <p className="muted">
            Personalize your dashboard and manage sign-in security, devices, and connected tools.
          </p>
        </div>
        {user && (
          <span className="status-pill neutral">
            {user.displayName} · {user.role}
          </span>
        )}
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button
            className="text-button"
            onClick={() =>
              void refresh()
                .then(() => setError(''))
                .catch((err) => setError(err.message))
            }
          >
            Try again
          </button>
        </div>
      )}
      {notice && (
        <p className="notice-banner" role="status">
          {notice}
        </p>
      )}
      <div className="settings-page">
        <nav className="section-links" aria-label="Account sections">
          <a href="#preferences">Appearance & preferences</a>
          <a href="#security">Sign-in security</a>
          <a href="#devices">Signed-in devices</a>
          <a href="#api-keys">API keys</a>
        </nav>
        {!user && (
          <p className="muted" role="status">
            {error ? 'Account details are unavailable.' : 'Loading your account…'}
          </p>
        )}
        {shownSecret && (
          <section
            ref={resultPanel}
            tabIndex={-1}
            className="card stack secret-panel"
            aria-labelledby="secret-title"
          >
            <h2 id="secret-title">{shownSecret.title}</h2>
            <p className="muted">
              Shown only once. Save this in your password manager before continuing. Recovery codes
              can each be used once if you lose your authenticator.
            </p>
            <pre className="secret-value">{shownSecret.value}</pre>
            <div className="form-actions">
              <CopyButton value={shownSecret.value} label="Copy secret" />
              <button className="btn" onClick={() => setShownSecret(null)}>
                I saved it
              </button>
            </div>
          </section>
        )}
        <PreferencesSettings />
        <section className="card stack" id="security">
          <div className="section-heading">
            <h2>Sign-in security</h2>
            {user && (
              <span className={`status-pill ${user.totpEnabledAt ? 'success' : 'neutral'}`}>
                {user.totpEnabledAt ? 'Two-factor enabled' : 'Password sign-in'}
              </span>
            )}
          </div>
          <p className="muted">
            We’ll ask for your current password when you make a security change.
          </p>
          <div className="settings-item">
            <div>
              <h3>Two-factor authentication</h3>
              <p className="muted">
                {user?.totpEnabledAt
                  ? `${user.recoveryCodesRemaining} recovery codes remaining. Keep them somewhere safe.`
                  : 'Protect your account with a code from an authenticator app.'}
              </p>
            </div>
            {!enrollment &&
              (user?.totpEnabledAt ? (
                <div className="form-actions">
                  <button
                    className="btn secondary"
                    disabled={unavailable}
                    onClick={() =>
                      setChange({
                        path: 'totp/recovery-codes',
                        title: 'Replace recovery codes',
                        description:
                          'Your old recovery codes will stop working. Save the new codes after confirming.',
                      })
                    }
                  >
                    Replace recovery codes
                  </button>
                  <button
                    className="btn secondary danger"
                    disabled={unavailable}
                    onClick={() =>
                      setChange({
                        path: 'totp',
                        method: 'DELETE',
                        title: 'Remove authenticator',
                        description:
                          'This removes two-factor protection and signs out every device. You can sign in again with your password.',
                      })
                    }
                  >
                    Remove authenticator
                  </button>
                </div>
              ) : (
                <button
                  className="btn secondary"
                  disabled={unavailable}
                  onClick={() =>
                    setChange({
                      path: 'totp/enroll',
                      title: 'Set up authenticator',
                      description:
                        'Verify your password to display a QR code for your authenticator app.',
                    })
                  }
                >
                  Set up authenticator
                </button>
              ))}
          </div>
          {enrollment && (
            <div ref={enrollmentPanel} tabIndex={-1} className="enrollment-panel stack">
              <h3>Finish authenticator setup</h3>
              <p className="muted">
                1. Scan this QR code with your authenticator app, or enter the setup key manually.
              </p>
              {/* Generated locally by the API; the image contains a private enrollment secret. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={enrollment.qr}
                width={224}
                height={224}
                alt="Authenticator enrollment QR code"
              />
              <details>
                <summary>Manual setup key</summary>
                <code className="secret-value">{enrollment.secret}</code>
              </details>
              <p className="muted">
                2. Confirm with the six-digit code in your app. Two-factor authentication is off
                until this succeeds.
              </p>
              <button
                className="btn"
                onClick={() =>
                  setChange({
                    path: 'totp/confirm',
                    title: 'Confirm authenticator',
                    description:
                      'Enter your current password and the six-digit code from the authenticator you just added.',
                  })
                }
              >
                Confirm authenticator
              </button>
            </div>
          )}
          <form
            className="settings-item"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              setChange({
                path: 'password',
                title: 'Change password',
                description:
                  'This signs out all devices, including this one. Use your new password to sign back in.',
                body: { newPassword: form.get('newPassword') },
              });
            }}
          >
            <div>
              <h3>Password</h3>
              <p className="muted">
                Use at least 10 characters. Changing it signs out all your devices.
              </p>
            </div>
            <div className="form-actions">
              <label>
                New password
                <input
                  name="newPassword"
                  type="password"
                  required
                  minLength={10}
                  maxLength={200}
                  autoComplete="new-password"
                />
              </label>
              <button className="btn secondary" disabled={unavailable}>
                Change password
              </button>
            </div>
          </form>
        </section>
        <section className="card stack" id="devices">
          <h2>Signed-in devices</h2>
          <p className="muted">Sign out a device you no longer use or don’t recognize.</p>
          {sessions.map((session) => (
            <div className="settings-item" key={session.id}>
              <div>
                <strong>{session.current ? 'This device' : session.ip || 'Another device'}</strong>
                <p className="muted">Expires {new Date(session.expiresAt).toLocaleDateString()}</p>
                <details className="settings-details">
                  <summary>Browser details</summary>
                  <p className="muted break-text">{session.userAgent || 'Unknown browser'}</p>
                </details>
              </div>
              <button
                className="btn secondary"
                disabled={unavailable}
                onClick={() =>
                  setChange({
                    path: `sessions/${session.id}`,
                    method: 'DELETE',
                    title: 'Sign out device',
                    description: session.current
                      ? 'You’ll be returned to the sign-in page.'
                      : 'This device will need to sign in again to use your account.',
                  })
                }
              >
                Sign out{session.current ? ' this device' : ' device'}
              </button>
            </div>
          ))}
          {user && !sessions.length && (
            <p className="muted">
              No active sessions were found. Sign in again to refresh your account.
            </p>
          )}
        </section>
        <section className="card stack" id="api-keys">
          <h2>API keys</h2>
          <p className="muted">
            Optional: let scripts and other tools use ServerForge. Each key is limited to your own
            server access and the actions you choose.
          </p>
          {!activeKeys.length && (
            <p className="empty-note">No API keys yet. You don’t need one to use the dashboard.</p>
          )}
          {activeKeys.map((key) => (
            <div className="settings-item" key={key.uid}>
              <div>
                <strong>{key.name}</strong>
                <p className="muted break-text">
                  {key.prefix}… ·{' '}
                  {key.expiresAt
                    ? `${Date.parse(key.expiresAt) < Date.now() ? 'Expired' : 'Expires'} ${new Date(key.expiresAt).toLocaleDateString()}`
                    : 'No expiry'}
                </p>
                <p className="muted">
                  {key.scopes.map((scope) => permissionLabels[scope] || scope).join(' · ')}
                </p>
              </div>
              <button
                className="btn secondary danger"
                disabled={unavailable}
                onClick={() =>
                  setChange({
                    path: `api-keys/${key.uid}`,
                    method: 'DELETE',
                    title: 'Revoke API key',
                    description: `“${key.name}” will immediately stop working. Any connected tool will need a new key.`,
                  })
                }
              >
                Revoke key
              </button>
            </div>
          ))}
          <details className="settings-details">
            <summary>Create an API key</summary>
            <form className="stack" onSubmit={newKey}>
              <div className="settings-field-grid">
                <label>
                  Key name
                  <input
                    name="name"
                    required
                    maxLength={100}
                    placeholder="For example, home automation"
                  />
                </label>
                <label>
                  Expires in days
                  <input name="expiry" type="number" defaultValue={90} min={1} max={365} required />
                </label>
              </div>
              <fieldset className="settings-group">
                <legend>Allowed actions</legend>
                <div className="permission-grid">
                  {scopes.map((scope) => (
                    <label key={scope} className="setting-checkbox">
                      <input
                        name="scope"
                        type="checkbox"
                        value={scope}
                        defaultChecked={scope === 'server.view'}
                      />
                      {permissionLabels[scope] || scope}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="form-actions">
                <button className="btn" disabled={unavailable}>
                  Create key
                </button>
              </div>
            </form>
          </details>
        </section>
      </div>
      {change && (
        <SecurityDialog
          title={change.title}
          description={change.description}
          requireCode={!!user?.totpEnabledAt || change.path === 'totp/confirm'}
          codeLabel={change.path === 'totp/confirm' ? 'Six-digit authenticator code' : undefined}
          onConfirm={confirm}
          onClose={() => {
            setChange(null);
            requestAnimationFrame(() => {
              if (shownSecret) resultPanel.current?.focus();
              else if (enrollment) enrollmentPanel.current?.focus();
            });
          }}
        />
      )}
    </>
  );
}
