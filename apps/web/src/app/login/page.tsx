'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { PageTitle } from '@/components/PageTitle';
import { useBrand } from '@/components/BrandProvider';

export default function LoginPage() {
  const [needsSetup, setNeedsSetup] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState<string | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const brand = useBrand().name;

  useEffect(() => {
    api<{ needsSetup: boolean }>('/api/setup')
      .then((data) => setNeedsSetup(data.needsSetup))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (ticket) codeInput.current?.focus();
  }, [ticket]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setError('');
    setBusy(true);
    try {
      if (ticket) {
        await api('/api/auth/login/2fa', {
          method: 'POST',
          body: JSON.stringify({ ticket, code: String(form.get('code')) }),
        });
        window.location.href = '/';
        return;
      }
      const path = needsSetup ? '/api/auth/register' : '/api/auth/login';
      const result = await api<{ twoFactor?: boolean; ticket?: string }>(path, {
        method: 'POST',
        body: JSON.stringify({
          username: String(form.get('username')),
          password: String(form.get('password')),
          ...(needsSetup ? { setupToken: String(form.get('setupToken') || '') } : {}),
          ...(form.get('displayName') ? { displayName: String(form.get('displayName')) } : {}),
        }),
      });
      if (result.twoFactor && result.ticket) {
        setTicket(result.ticket);
        return;
      }
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-brand-panel">
        <Link href="/" className="brand">
          <span className="brand-mark">
            <Icon name="server" size={24} />
          </span>
          {brand}
          <span className="brand-dot">.</span>
        </Link>
        <div>
          <div className="eyebrow">YOUR WORLD. YOUR RULES.</div>
          <h2>
            Good times.
            <br />
            Great company.
            <br />
            Your own server.
          </h2>
          <p>A home for your community and a launchpad for your next adventure.</p>
        </div>
        <span>Self-hosted. Under your control.</span>
      </section>
      <section className="login-form-panel">
        <div className="login-form">
          <div className="eyebrow">WELCOME TO YOUR WORKSPACE</div>
          <PageTitle>
            {ticket ? 'One last step' : needsSetup ? 'Make yourself at home' : 'Welcome back'}
          </PageTitle>
          <p className="muted">
            {ticket
              ? 'Enter your authenticator code or a recovery code.'
              : needsSetup
                ? 'Create the owner account. The first one owns the panel.'
                : 'Sign in to manage your servers.'}
          </p>
          <form className="card stack" onSubmit={(event) => void onSubmit(event)}>
            {ticket ? (
              <label>
                Verification code
                <input
                  ref={codeInput}
                  name="code"
                  autoComplete="one-time-code"
                  autoCapitalize="off"
                  spellCheck={false}
                  required
                  maxLength={32}
                  placeholder="6-digit or recovery code"
                />
              </label>
            ) : (
              <>
                {needsSetup ? (
                  <label>
                    One-time setup token
                    <input name="setupToken" autoComplete="off" required placeholder="Token displayed by the host installer" />
                  </label>
                ) : null}
                {needsSetup ? (
                  <label>
                    Display name
                    <input name="displayName" placeholder="Will" />
                  </label>
                ) : null}
                <label>
                  Username
                  <input name="username" autoComplete="username" required minLength={3} />
                </label>
                <label>
                  Password
                  <input
                    name="password"
                    type="password"
                    autoComplete={needsSetup ? 'new-password' : 'current-password'}
                    required
                    minLength={10}
                    maxLength={200}
                  />
                </label>
              </>
            )}
            {error ? (
              <p className="error" role="alert">
                {error}
              </p>
            ) : null}
            <button className="btn" type="submit" disabled={busy} aria-busy={busy}>
              {busy
                ? 'Signing in…'
                : ticket
                  ? 'Verify and sign in'
                  : needsSetup
                    ? 'Create account'
                    : 'Sign in'}
            </button>
            {ticket ? (
              <button
                className="btn secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  setTicket(null);
                  setError('');
                }}
              >
                Back to sign in
              </button>
            ) : !needsSetup ? (
              <p className="muted">
                Need an account? Ask the owner, or <Link href="/login">refresh</Link> if this is a
                new install.
              </p>
            ) : null}
          </form>
        </div>
      </section>
    </main>
  );
}
