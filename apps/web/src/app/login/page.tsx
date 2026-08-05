'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2, Server } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { BRAND } from '@/lib/utils';
import { Button, Card, CardBody, Field, Input } from '@/components/ui';

interface AuthContext {
  needsSetup: boolean;
  user: { uid: string } | null;
  brand: { name: string; tagline: string };
}

/**
 * Sign in, or create the very first account.
 *
 * A fresh install shows "create your account" instead of a login form with no
 * credentials to enter — the single most common first-run confusion in
 * self-hosted software.
 */
export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const context = useQuery({
    queryKey: ['auth-context'],
    queryFn: () => api.get<AuthContext>('/api/auth/context'),
    retry: 1,
  });

  const isSetup = context.data?.needsSetup ?? false;

  const submit = useMutation({
    mutationFn: async () => {
      const handle = username.trim().toLowerCase();
      if (isSetup) {
        return api.post('/api/auth/register', {
          username: handle,
          password,
          displayName: handle,
        });
      }
      return api.post('/api/auth/login', { username: handle, password });
    },
    onSuccess: () => router.push('/servers'),
    onError: (err) => {
      if (err instanceof ApiError) {
        setError(err.body.message);
        setHint(err.body.hint ?? err.fieldIssues[0]?.message ?? null);
      } else {
        setError('Could not reach the panel. Is the API running?');
        setHint(null);
      }
    },
  });

  if (context.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-ink-subtle" />
        <span className="sr-only">Loading</span>
      </div>
    );
  }

  if (context.isError) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <Card className="max-w-md">
          <CardBody className="space-y-3 text-center">
            <p className="eyebrow text-danger">connection refused</p>
            <h1 className="display text-lg">Can&apos;t reach the panel</h1>
            <p className="text-[13px] leading-relaxed text-ink-muted">
              The dashboard loaded, but the API did not answer. Check that it is running and that{' '}
              <code className="rounded bg-surface-raised px-1 py-0.5 text-[12px]">
                NEXT_PUBLIC_API_URL
              </code>{' '}
              points at it.
            </p>
            <Button variant="secondary" onClick={() => context.refetch()}>
              Try again
            </Button>
          </CardBody>
        </Card>
      </main>
    );
  }

  return (
    <main
      id="main"
      className="flex min-h-screen flex-col items-center justify-center px-4 py-10"
    >
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="inset-well mb-4 flex h-11 w-11 items-center justify-center rounded-xl text-accent">
            <Server className="h-5 w-5" aria-hidden />
          </div>
          <h1 className="engraved text-lg">{BRAND.name}</h1>
          <p className="mt-2.5 text-[13px] text-ink-muted">
            {isSetup ? 'Create the account that will own this panel.' : BRAND.tagline}
          </p>
        </div>

        <Card>
          <CardBody>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                setError(null);
                setHint(null);
                submit.mutate();
              }}
            >
              <Field
                label="Username"
                help={
                  isSetup
                    ? 'Letters, numbers, underscores or dashes. This is how you sign in.'
                    : undefined
                }
                required
              >
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="alex"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  minLength={3}
                  maxLength={32}
                  required
                  data-autofocus
                />
              </Field>

              <Field
                label="Password"
                help={isSetup ? 'At least 10 characters. A short phrase works well.' : undefined}
                required
              >
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={isSetup ? 'new-password' : 'current-password'}
                  minLength={isSetup ? 10 : undefined}
                  required
                />
              </Field>

              {error && (
                <div
                  role="alert"
                  className="rounded-md border border-line border-l-2 border-l-danger bg-danger/[0.07] px-3 py-2.5"
                >
                  <p className="text-[12.5px] font-medium text-danger">{error}</p>
                  {hint && <p className="mt-1 text-[12.5px] text-ink-muted">{hint}</p>}
                </div>
              )}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="w-full"
                loading={submit.isPending}
                loadingText={isSetup ? 'Creating account…' : 'Signing in…'}
              >
                {isSetup ? 'Create account' : 'Sign in'}
              </Button>
            </form>
          </CardBody>
        </Card>

        {isSetup && (
          <p className="mt-4 text-center text-[12.5px] leading-relaxed text-ink-subtle">
            This first account becomes the owner. Everyone else joins by invitation.
          </p>
        )}
      </div>
    </main>
  );
}
