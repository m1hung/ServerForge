'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { AuthLayout } from '@/components/AuthLayout';

export default function LoginPage() {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(true);
  const [setupError, setSetupError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState<string | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const checkSetup = useCallback(async () => {
    setChecking(true);
    setSetupError('');
    try {
      const data = await api<{ needsSetup: boolean }>('/api/setup');
      setNeedsSetup(data.needsSetup);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'Could not reach your workspace.');
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void checkSetup();
  }, [checkSetup]);

  useEffect(() => {
    if (ticket) codeInput.current?.focus();
  }, [ticket]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || checking || needsSetup === null) return;
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
    <AuthLayout
      eyebrow="WELCOME TO YOUR WORKSPACE"
      title={
        ticket
          ? 'One last step'
          : needsSetup === null
            ? 'Connect to your workspace'
            : needsSetup
              ? 'Make yourself at home'
              : 'Welcome back'
      }
      description={
        ticket
          ? 'Enter your authenticator code or a recovery code.'
          : needsSetup === null
            ? 'Connect to the panel to sign in or finish setup.'
            : needsSetup
              ? 'Create the owner account using the token from your host installer.'
              : 'Sign in to manage your servers.'
      }
    >
      <form
        className="card stack"
        onSubmit={(event) => void onSubmit(event)}
        aria-busy={busy || checking}
      >
        {checking && (
          <p className="muted" role="status">
            Connecting to your workspace…
          </p>
        )}
        {setupError && (
          <div className="error-banner" role="alert">
            <span>{setupError}</span>
            <button
              className="text-button"
              type="button"
              disabled={checking}
              onClick={() => void checkSetup()}
            >
              Retry connection
            </button>
          </div>
        )}
        {needsSetup !== null && (
          <>
            <fieldset className="configuration-inputs stack" disabled={busy || checking}>
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
                  {needsSetup && (
                    <>
                      <label>
                        One-time setup token
                        <input
                          name="setupToken"
                          autoComplete="off"
                          required
                          placeholder="Token displayed by the host installer"
                        />
                      </label>
                      <label>
                        Display name
                        <input name="displayName" maxLength={80} placeholder="Will" />
                      </label>
                    </>
                  )}
                  <label>
                    Username
                    <input
                      name="username"
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      required
                      minLength={3}
                      maxLength={32}
                    />
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
            </fieldset>
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}
            <button className="btn" type="submit" disabled={busy || checking}>
              {busy
                ? needsSetup
                  ? 'Creating account…'
                  : 'Signing in…'
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
              <p className="muted">Need an account? Ask your workspace owner for an invitation.</p>
            ) : null}
          </>
        )}
      </form>
    </AuthLayout>
  );
}
