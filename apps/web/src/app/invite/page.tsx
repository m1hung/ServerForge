'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { ProtectedLink as Link } from '@/components/UnsavedChanges';
import { api } from '@/lib/api';
import { AuthLayout } from '@/components/AuthLayout';
export default function InvitePage() {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const readInvitation = () => {
      const fragment = window.location.hash.slice(1);
      if (fragment) {
        setToken(fragment);
        setError('');
        window.history.replaceState(window.history.state, '', window.location.pathname);
      } else {
        setToken((current) => current ?? '');
      }
    };
    readInvitation();
    window.addEventListener('hashchange', readInvitation);
    return () => window.removeEventListener('hashchange', readInvitation);
  }, []);
  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !token) return;
    setPending(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/auth/invites/accept', {
        method: 'POST',
        body: JSON.stringify({
          token,
          username: form.get('username'),
          displayName: form.get('displayName'),
          password: form.get('password'),
        }),
      });
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not accept invitation.');
    } finally {
      setPending(false);
    }
  }
  return (
    <AuthLayout
      eyebrow="YOUR INVITATION"
      title="Join the workspace"
      description="Create your account with this invitation. Links expire after 72 hours and can be used once."
    >
      <Link href="/login" className="back-link">
        Back to sign in
      </Link>
      {token === null ? (
        <p className="muted" role="status">
          Reading your invitation…
        </p>
      ) : !token ? (
        <div className="error-banner" role="alert">
          Open the complete invitation link from your workspace owner. If it has expired, ask for a
          new invitation.
        </div>
      ) : (
        <form className="card stack" onSubmit={(event) => void accept(event)} aria-busy={pending}>
          <fieldset className="configuration-inputs stack" disabled={pending}>
            <label>
              Username
              <input
                name="username"
                required
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                minLength={3}
                maxLength={32}
              />
            </label>
            <label>
              Display name
              <input name="displayName" required maxLength={80} />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                required
                autoComplete="new-password"
                minLength={10}
                maxLength={200}
              />
            </label>
          </fieldset>
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <button className="btn" disabled={pending || !token}>
            {pending ? 'Creating account…' : 'Accept invitation'}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
