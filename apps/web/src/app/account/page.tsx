'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Shell } from '@/components/Shell';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';

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
export default function AccountPage() {
  const [user, setUser] = useState<Account | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [enrollment, setEnrollment] = useState<{ secret: string; qr: string } | null>(null);
  const [shownSecret, setShownSecret] = useState('');
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
  async function change(path: string, extra: object = {}, method = 'POST') {
    if (pending) return;
    setPending(true);
    setError('');
    setNotice('');
    try {
      const data = await api<{
        signInRequired?: boolean;
        secret?: string;
        qr?: string;
        recoveryCodes?: string[];
      }>(`/api/account/${path}`, { method, body: JSON.stringify({ password, code, ...extra }) });
      setCode('');
      if (data.signInRequired) {
        window.location.href = '/login';
        return;
      }
      if (data.qr && data.secret) setEnrollment({ secret: data.secret, qr: data.qr });
      else if (data.secret) setShownSecret(data.secret);
      if (data.recoveryCodes) {
        setShownSecret(data.recoveryCodes.join('\n'));
        setEnrollment(null);
      }
      setNotice('Account updated.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update account.');
    } finally {
      setPending(false);
    }
  }
  function newKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void change('api-keys', {
      name: form.get('name'),
      scopes: form.getAll('scope'),
      expiresInDays: Number(form.get('expiry')),
    });
  }
  return (
    <Shell>
      <div className="page-heading">
        <div>
          <h1 className="h1">Account</h1>
          <p className="muted">
            {user?.displayName} · {user?.username} · {user?.role}
          </p>
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="stack" style={{ maxWidth: 1000 }}>
        <section className="card stack">
          <h2>Verify security changes</h2>
          <p className="muted">
            Enter your current password and, when enabled, a fresh authenticator code or recovery
            code for each change.
          </p>
          <div className="row" style={{ flexWrap: 'wrap', gap: 16 }}>
            <label style={{ flex: 1 }}>
              Current password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label style={{ flex: 1 }}>
              Authenticator or recovery code
              <input
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
          </div>
        </section>
        {shownSecret && (
          <section className="card stack" role="status">
            <h2>Save this now</h2>
            <p className="muted">This secret is shown once. Keep it in your password manager.</p>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{shownSecret}</pre>
            <div className="row">
              <button
                className="btn secondary"
                onClick={() =>
                  void copyText(shownSecret)
                    .then(() => setNotice('Copied.'))
                    .catch(() => setError('Select and copy the secret manually.'))
                }
              >
                Copy
              </button>
              <button className="btn" onClick={() => setShownSecret('')}>
                I saved it
              </button>
            </div>
          </section>
        )}
        <section className="card stack">
          <h2>Two-factor authentication</h2>
          <p className="muted">
            {user?.totpEnabledAt
              ? `Enabled · ${user.recoveryCodesRemaining} recovery codes remaining`
              : 'Add an authenticator app to protect your account.'}
          </p>
          {enrollment ? (
            <div className="stack">
              {/* The QR is generated locally by the API and contains the enrollment secret. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={enrollment.qr}
                width={256}
                height={256}
                alt="Authenticator enrollment QR code"
              />
              <code style={{ overflowWrap: 'anywhere' }}>{enrollment.secret}</code>
              <p>
                Scan the QR code, then enter its six-digit code in the verification field above.
              </p>
              <button
                className="btn"
                disabled={pending || !password || !code}
                onClick={() => void change('totp/confirm')}
              >
                Confirm authenticator
              </button>
            </div>
          ) : (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {user?.totpEnabledAt ? (
                <>
                  <button
                    className="btn secondary"
                    disabled={pending || !password}
                    onClick={() => void change('totp/recovery-codes')}
                  >
                    Regenerate recovery codes
                  </button>
                  <button
                    className="btn secondary danger"
                    disabled={pending || !password}
                    onClick={() => void change('totp', {}, 'DELETE')}
                  >
                    Remove authenticator
                  </button>
                </>
              ) : (
                <button
                  className="btn"
                  disabled={pending || !password}
                  onClick={() => void change('totp/enroll')}
                >
                  Set up authenticator
                </button>
              )}
            </div>
          )}
        </section>
        <section className="card stack">
          <h2>Change password</h2>
          <form
            className="row"
            style={{ alignItems: 'end', flexWrap: 'wrap' }}
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void change('password', { newPassword: form.get('newPassword') });
            }}
          >
            <label style={{ flex: 1 }}>
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
            <button className="btn" disabled={pending || !password}>
              Change and sign out
            </button>
          </form>
        </section>
        <section className="card stack">
          <h2>Signed-in devices</h2>
          {sessions.map((session) => (
            <div
              className="row"
              key={session.id}
              style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}
            >
              <div style={{ overflowWrap: 'anywhere', flex: 1 }}>
                <strong>{session.current ? 'This session' : session.ip || 'Another device'}</strong>
                <p className="muted" style={{ fontSize: 12 }}>
                  {session.userAgent || 'Unknown browser'} · Expires{' '}
                  {new Date(session.expiresAt).toLocaleDateString()}
                </p>
              </div>
              <button
                className="btn secondary"
                disabled={pending || !password}
                onClick={() => void change(`sessions/${session.id}`, {}, 'DELETE')}
              >
                Revoke
              </button>
            </div>
          ))}
        </section>
        <section className="card stack">
          <h2>API keys</h2>
          <p className="muted">
            Keys inherit your current server access and are further limited by the selected scopes.
          </p>
          {keys
            .filter((key) => !key.revokedAt)
            .map((key) => (
              <div
                className="row"
                key={key.uid}
                style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}
              >
                <div>
                  <strong>{key.name}</strong>
                  <p className="muted">
                    {key.prefix}… · {key.scopes.join(', ')} ·{' '}
                    {key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : 'No expiry'}
                  </p>
                </div>
                <button
                  className="btn secondary"
                  disabled={pending || !password}
                  onClick={() => void change(`api-keys/${key.uid}`, {}, 'DELETE')}
                >
                  Revoke
                </button>
              </div>
            ))}
          <form className="stack" onSubmit={newKey}>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <label style={{ flex: 1 }}>
                Key name
                <input name="name" required maxLength={100} />
              </label>
              <label>
                Expires in days
                <input name="expiry" type="number" defaultValue={90} min={1} max={365} required />
              </label>
            </div>
            <fieldset>
              <legend>Allowed actions</legend>
              <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
                {scopes.map((scope) => (
                  <label key={scope} className="row">
                    <input
                      name="scope"
                      type="checkbox"
                      value={scope}
                      defaultChecked={scope === 'server.view'}
                    />
                    {scope}
                  </label>
                ))}
              </div>
            </fieldset>
            <button className="btn" disabled={pending || !password}>
              Create key
            </button>
          </form>
        </section>
      </div>
    </Shell>
  );
}
