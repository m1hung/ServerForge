'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Icon } from '@/components/Icon';

export default function LoginPage() {
  const [needsSetup, setNeedsSetup] = useState(false);
  const [error, setError] = useState('');
  const brand = process.env.NEXT_PUBLIC_BRAND_NAME ?? 'ServerForge';

  useEffect(() => {
    api<{ needsSetup: boolean }>('/api/setup')
      .then((data) => setNeedsSetup(data.needsSetup))
      .catch(() => undefined);
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    try {
      const path = needsSetup ? '/api/auth/register' : '/api/auth/login';
      const result = await api<{ twoFactor?: boolean; ticket?: string }>(path, {
        method: 'POST',
        body: JSON.stringify({
          username: String(form.get('username')),
          password: String(form.get('password')),
          displayName: String(form.get('displayName') || ''),
        }),
      });
      if (result.twoFactor && result.ticket) {
        const code = window.prompt('Authenticator code');
        if (!code) return;
        await api('/api/auth/login/2fa', {
          method: 'POST',
          body: JSON.stringify({ ticket: result.ticket, code }),
        });
      }
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
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
          <h1 className="h1">{needsSetup ? 'Make yourself at home.' : 'Welcome back.'}</h1>
          <p className="muted">
            {needsSetup
              ? 'Create the owner account. The first one owns the panel.'
              : 'Sign in to manage your servers.'}
          </p>
          <form className="card stack" onSubmit={(event) => void onSubmit(event)}>
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
              />
            </label>
            {error ? (
              <p className="error" role="alert">
                {error}
              </p>
            ) : null}
            <button className="btn" type="submit">
              {needsSetup ? 'Create account' : 'Sign in'}
            </button>
            {!needsSetup ? (
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
