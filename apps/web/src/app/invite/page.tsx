'use client';
import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
export default function InvitePage() {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setToken(window.location.hash.slice(1));
    window.history.replaceState(null, '', window.location.pathname);
  }, []);
  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    <main style={{ maxWidth: 520, margin: '10vh auto', padding: 24 }}>
      <Link href="/login" className="back-link">
        Back to sign in
      </Link>
      <h1 className="h1">Join the workspace</h1>
      <p className="muted">
        Create your account with this invitation. Links expire after 72 hours and can be used once.
      </p>
      <form className="card stack" onSubmit={(event) => void accept(event)}>
        <label>
          Username
          <input name="username" required autoComplete="username" minLength={3} maxLength={32} />
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
        {!token && <p role="alert">Open the complete invitation link from the workspace owner.</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn" disabled={pending || !token}>
          {pending ? 'Creating account…' : 'Accept invitation'}
        </button>
      </form>
    </main>
  );
}
