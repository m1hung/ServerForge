'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Plus, Save, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { copyToClipboard, inkOn, timeAgo } from '@/lib/utils';
import {
  DEFAULT_CSS_THEME,
  readStoredCssTheme,
  storeCssTheme,
} from '@/lib/theme-css';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  useToast,
} from '@/components/ui';

/**
 * Account settings.
 *
 * Split by consequence rather than by data type: the things you can change
 * freely sit at the top, password changes require your current password, and
 * the keys that grant programmatic access sit last with a clear warning.
 */

interface Me {
  user: {
    uid: string;
    username: string;
    displayName: string;
    role: string;
    avatarColor: string;
    createdAt: string;
    lastLoginAt: string | null;
    twoFactorEnabled: boolean;
    recoveryCodesLeft: number;
  };
}

interface ApiKeyRow {
  uid: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/** A small, legible palette — free colour pickers produce unreadable avatars. */
const AVATAR_COLORS = [
  '#f97316',
  '#ef4444',
  '#ec4899',
  '#8b5cf6',
  '#3b82f6',
  '#06b6d4',
  '#10b981',
  '#84cc16',
  '#eab308',
  '#64748b',
];

export default function AccountPage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/api/auth/me') });

  if (me.isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!me.data) return null;
  const user = me.data.user;

  return (
    <div className="mx-auto max-w-3xl space-y-5 pb-24">
      <div>
        <p className="legend mb-2">Operator</p>
        <h1 className="engraved text-lg sm:text-xl">Account</h1>
        <p className="mt-1.5 text-[13px] text-ink-muted">
          Signed in as {user.username} · {user.role}
          {user.lastLoginAt && ` · last signed in ${timeAgo(user.lastLoginAt)}`}
        </p>
      </div>

      <ProfileCard user={user} onSaved={() => queryClient.invalidateQueries({ queryKey: ['me'] })} />
      <AppearanceCard role={user.role} />
      <PasswordCard />
      <TwoFactorCard
        user={user}
        onChanged={() => queryClient.invalidateQueries({ queryKey: ['me'] })}
      />
      <ApiKeysCard />

      <p className="text-[12px] text-ink-subtle">Account created {timeAgo(user.createdAt)}.</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── appearance ──

interface ThemeOption {
  id: string;
  name: string;
  description: string | null;
  source: 'builtin' | 'custom';
}

function AppearanceCard({ role }: { role: string }) {
  const toast = useToast();
  const canSetDefault = role === 'owner' || role === 'admin';
  const catalogue = useQuery({
    queryKey: ['themes'],
    queryFn: () =>
      api.get<{ themes: ThemeOption[]; active: string }>('/api/themes'),
  });

  const [selected, setSelected] = useState(DEFAULT_CSS_THEME);
  const [asDefault, setAsDefault] = useState(false);

  useEffect(() => {
    const stored = readStoredCssTheme();
    if (stored) {
      setSelected(stored);
      return;
    }
    if (catalogue.data?.active) setSelected(catalogue.data.active);
  }, [catalogue.data?.active]);

  const saveDefault = useMutation({
    mutationFn: (theme: string) => api.put('/api/themes/active', { theme }),
    onSuccess: () => {
      void catalogue.refetch();
      toast.push({ tone: 'ok', message: 'Panel default theme updated.' });
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        toast.push({ tone: 'danger', message: err.body.message, hint: err.body.hint });
      }
    },
  });

  const apply = (id: string) => {
    setSelected(id);
    storeCssTheme(id);
    toast.push({
      tone: 'ok',
      message: id === DEFAULT_CSS_THEME ? 'Using the default theme.' : `Theme “${id}” applied.`,
    });
    if (asDefault && canSetDefault) saveDefault.mutate(id);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>
          Themes can recolour the panel or fully restyle it (fonts, chrome,
          motion). Drop a <code className="text-[12px]">.css</code> file in{' '}
          <code className="text-[12px]">data/themes/</code> — see{' '}
          <code className="text-[12px]">themes/README.md</code>.
        </CardDescription>
      </CardHeader>
      <CardBody className="space-y-4">
        {catalogue.isLoading ? (
          <Skeleton className="h-9 w-full" />
        ) : (
          <Field label="Colour theme">
            <Select
              value={selected}
              onChange={(e) => apply(e.target.value)}
              aria-label="Colour theme"
            >
              {(catalogue.data?.themes ?? []).map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.name}
                  {theme.source === 'custom' ? ' (custom)' : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {catalogue.data?.themes.find((t) => t.id === selected)?.description && (
          <p className="text-[13px] text-ink-muted">
            {catalogue.data.themes.find((t) => t.id === selected)?.description}
          </p>
        )}

        {canSetDefault && (
          <label className="flex items-start gap-2.5 text-[13px] text-ink-muted">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={asDefault}
              onChange={(e) => setAsDefault(e.target.checked)}
            />
            <span>
              Also set this as the panel default for people who have not chosen a
              theme yet.
            </span>
          </label>
        )}

        {canSetDefault && asDefault && selected !== catalogue.data?.active && (
          <div className="flex justify-end">
            <Button
              variant="secondary"
              loading={saveDefault.isPending}
              onClick={() => saveDefault.mutate(selected)}
            >
              Save panel default
            </Button>
          </div>
        )}

        <p className="text-[12px] text-ink-subtle">
          Light and dark mode still use the sun/moon control in the sidebar —
          themes redefine colours for both.
        </p>
      </CardBody>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────── profile ──

function ProfileCard({ user, onSaved }: { user: Me['user']; onSaved: () => void }) {
  const toast = useToast();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [avatarColor, setAvatarColor] = useState(user.avatarColor);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(user.displayName);
    setAvatarColor(user.avatarColor);
  }, [user.displayName, user.avatarColor]);

  const dirty = displayName !== user.displayName || avatarColor !== user.avatarColor;

  const save = useMutation({
    mutationFn: () => api.patch('/api/auth/me', { displayName: displayName.trim(), avatarColor }),
    onSuccess: () => {
      setError(null);
      toast.push({ tone: 'ok', message: 'Profile updated.' });
      onSaved();
    },
    onError: (err) => {
      if (err instanceof ApiError) setError(err.body.message);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>How you appear in activity logs and to people you share servers with.</CardDescription>
      </CardHeader>
      <CardBody className="space-y-5">
        <div className="flex items-center gap-4">
          <div
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold"
            style={{ backgroundColor: avatarColor, color: inkOn(avatarColor) }}
            aria-hidden
          >
            {(displayName || '?').slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <Field label="Display name" error={error ?? undefined} required>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={64}
              />
            </Field>
          </div>
        </div>

        <fieldset>
          <legend className="mb-2 text-[13px] font-medium text-ink">
            Avatar colour
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {AVATAR_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setAvatarColor(color)}
                aria-label={`Use colour ${color}`}
                aria-pressed={avatarColor === color}
                className="flex h-8 w-8 items-center justify-center rounded-md ring-offset-2 ring-offset-[hsl(var(--surface))] transition-transform hover:scale-105"
                style={{ backgroundColor: color }}
              >
                {avatarColor === color && (
                  <Check
                    className="h-4 w-4 text-[hsl(var(--canvas))]"
                    aria-hidden
                  />
                )}
              </button>
            ))}
          </div>
        </fieldset>

        {dirty && (
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setDisplayName(user.displayName);
                setAvatarColor(user.avatarColor);
                setError(null);
              }}
            >
              Discard
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              <Save className="h-4 w-4" aria-hidden />
              Save
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ───────────────────────────────────────────────────────────────── password ──

function PasswordCard() {
  const router = useRouter();
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm !== '' && newPassword !== confirm;

  const change = useMutation({
    mutationFn: () =>
      api.post<{ message: string; hint?: string }>('/api/auth/password', {
        currentPassword,
        newPassword,
      }),
    onSuccess: (result) => {
      // The hint calls out still-valid API keys, which a password change does
      // not revoke — worth reading before being redirected to sign in again.
      toast.push({ tone: 'ok', message: result.message, hint: result.hint });
      // The API invalidates every other session on a password change, so this
      // one is gone too — send the user to sign in again rather than letting
      // the next request fail mysteriously.
      setTimeout(() => router.push('/login'), result.hint ? 5000 : 1500);
    },
    onError: (err) => {
      if (err instanceof ApiError) setError(err.body.message);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          Changing it signs you out everywhere, including here — that is the point of changing it.
        </CardDescription>
      </CardHeader>
      <CardBody>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            change.mutate();
          }}
        >
          <Field label="Current password" required>
            <Input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>

          <Field
            label="New password"
            help="At least 10 characters. A short phrase is easier to remember and harder to guess."
            required
          >
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              minLength={10}
            />
          </Field>

          <Field
            label="Confirm new password"
            error={mismatch ? 'These do not match.' : (error ?? undefined)}
            required
          >
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </Field>

          <div className="flex justify-end">
            <Button
              type="submit"
              variant="secondary"
              loading={change.isPending}
              disabled={
                currentPassword === '' || newPassword.length < 10 || newPassword !== confirm
              }
            >
              Change password
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

// ───────────────────────────────────────────────────────────── two-factor ──

/**
 * Two-factor setup.
 *
 * Three states, and the middle one matters: a secret that has been generated
 * but not yet confirmed with a working code changes nothing about signing in.
 * Confirmation is what turns it on, which is what stops someone locking
 * themselves out of a panel their authenticator never actually scanned.
 */
function TwoFactorCard({ user, onChanged }: { user: Me['user']; onChanged: () => void }) {
  const toast = useToast();

  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [enrolling, setEnrolling] = useState<{ secret: string; formattedSecret: string; otpauthUri: string; qrDataUri: string | null } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);

  const fail = (error: unknown) => {
    if (error instanceof ApiError) {
      toast.push({ tone: 'danger', message: error.body.message, hint: error.body.hint });
    }
  };

  const reset = () => {
    setPassword('');
    setCode('');
    setEnrolling(null);
    setDisabling(false);
  };

  const setup = useMutation({
    mutationFn: () =>
      api.post<{ secret: string; formattedSecret: string; otpauthUri: string; qrDataUri: string | null }>(
        '/api/auth/2fa/setup',
        { password },
      ),
    onSuccess: (result) => {
      setEnrolling(result);
      setPassword('');
    },
    onError: fail,
  });

  const enable = useMutation({
    mutationFn: () =>
      api.post<{ recoveryCodes: string[] }>('/api/auth/2fa/enable', { code: code.trim() }),
    onSuccess: (result) => {
      setCodes(result.recoveryCodes);
      reset();
      onChanged();
    },
    onError: fail,
  });

  const disable = useMutation({
    mutationFn: () =>
      api.post('/api/auth/2fa/disable', { password, code: code.trim() }),
    onSuccess: () => {
      toast.push({ tone: 'ok', message: 'Two-factor authentication is off.' });
      reset();
      onChanged();
    },
    onError: fail,
  });

  const regenerate = useMutation({
    mutationFn: () =>
      api.post<{ recoveryCodes: string[] }>('/api/auth/2fa/recovery-codes', { password }),
    onSuccess: (result) => {
      setCodes(result.recoveryCodes);
      reset();
      onChanged();
    },
    onError: fail,
  });

  const lowOnCodes = user.twoFactorEnabled && user.recoveryCodesLeft <= 2;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Two-factor authentication</CardTitle>
              <CardDescription>
                A code from your phone on top of your password. It is the single
                most useful thing you can turn on if this panel is reachable from
                the internet.
              </CardDescription>
            </div>
            <Badge tone={user.twoFactorEnabled ? 'ok' : 'neutral'}>
              {user.twoFactorEnabled ? 'On' : 'Off'}
            </Badge>
          </div>
        </CardHeader>

        <CardBody className="space-y-4">
          {lowOnCodes && (
            <div className="rounded-md border border-line border-l-2 border-l-warn bg-warn/[0.07] px-3 py-2.5">
              <p className="text-[12.5px] text-ink-muted">
                {user.recoveryCodesLeft === 0
                  ? 'You have no recovery codes left. If you lose your phone you will be locked out — generate a new set now.'
                  : `Only ${user.recoveryCodesLeft} recovery code${user.recoveryCodesLeft === 1 ? '' : 's'} left.`}
              </p>
            </div>
          )}

          {/* ── Off, and not yet enrolling ─────────────────────────────── */}
          {!user.twoFactorEnabled && !enrolling && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                setup.mutate();
              }}
            >
              <Field label="Confirm your password" required>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </Field>
              <Button
                type="submit"
                variant="primary"
                loading={setup.isPending}
                disabled={password === ''}
              >
                Set up two-factor
              </Button>
            </form>
          )}

          {/* ── Secret issued, waiting for a code to prove it works ─────── */}
          {enrolling && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                enable.mutate();
              }}
            >
              <div className="space-y-3">
                {enrolling.qrDataUri && (
                  <div className="space-y-2">
                    <p className="text-[13px] text-ink">
                      Scan this with your authenticator app.
                    </p>
                    {/* White plate regardless of theme: a scanner wants
                        contrast and a quiet zone, not our palette. */}
                    <div className="flex justify-center rounded-md border border-line bg-white p-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={enrolling.qrDataUri}
                        alt="QR code containing your two-factor setup key"
                        width={232}
                        height={232}
                        className="h-[232px] w-[232px] max-w-full"
                      />
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <p className="text-[13px] text-ink">
                    {enrolling.qrDataUri
                      ? 'Cannot scan it? Type this key in instead.'
                      : 'Add this key to your authenticator app.'}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="readout flex-1 px-3 py-2 text-[13px] tracking-[0.12em]">
                      {enrolling.formattedSecret}
                    </code>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        void copyToClipboard(enrolling.secret);
                        toast.push({ tone: 'ok', message: 'Setup key copied.' });
                      }}
                    >
                      <Copy className="h-4 w-4" aria-hidden />
                      Copy
                    </Button>
                  </div>
                  <p className="text-[12.5px] leading-relaxed text-ink-subtle">
                    Choose &ldquo;enter a setup key&rdquo; in your app and paste
                    it in. If you are reading this on the same phone,{' '}
                    <a className="text-accent underline" href={enrolling.otpauthUri}>
                      this link
                    </a>{' '}
                    opens the app directly.
                  </p>
                </div>
              </div>

              <Field
                label="Enter the code it shows"
                help="Six digits. This proves the app and the panel agree before anything is switched on."
                required
              >
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  maxLength={16}
                  required
                />
              </Field>

              <div className="flex gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  loading={enable.isPending}
                  disabled={code.trim().length < 6}
                >
                  Turn on
                </Button>
                <Button type="button" variant="ghost" onClick={reset}>
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {/* ── On ─────────────────────────────────────────────────────── */}
          {user.twoFactorEnabled && !disabling && (
            <div className="space-y-4">
              <p className="text-[13px] text-ink-muted">
                You will be asked for a code from your app each time you sign in.
                {user.recoveryCodesLeft > 0 &&
                  ` You have ${user.recoveryCodesLeft} unused recovery code${user.recoveryCodesLeft === 1 ? '' : 's'}.`}
              </p>

              <form
                className="space-y-4 border-t border-line pt-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  regenerate.mutate();
                }}
              >
                <Field
                  label="Confirm your password"
                  help="Needed to generate a new set of recovery codes, or to turn two-factor off."
                  required
                >
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    variant="secondary"
                    loading={regenerate.isPending}
                    disabled={password === ''}
                  >
                    New recovery codes
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    disabled={password === ''}
                    onClick={() => setDisabling(true)}
                  >
                    Turn off
                  </Button>
                </div>
              </form>
            </div>
          )}

          {/* ── Turning it off, which needs a code as well as the password ── */}
          {user.twoFactorEnabled && disabling && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                disable.mutate();
              }}
            >
              <p className="text-[13px] text-ink-muted">
                Turning this off means your password alone is enough to sign in.
              </p>
              <Field
                label="Code from your app"
                help="Or a recovery code, if you no longer have the app."
                required
              >
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  maxLength={32}
                  required
                  data-autofocus
                />
              </Field>
              <div className="flex gap-2">
                <Button
                  type="submit"
                  variant="danger"
                  loading={disable.isPending}
                  disabled={code.trim() === ''}
                >
                  Turn off two-factor
                </Button>
                <Button type="button" variant="ghost" onClick={() => setDisabling(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </CardBody>
      </Card>

      {/* Shown once, and never again — same bargain as an API key. */}
      <Modal
        open={codes !== null}
        onClose={() => setCodes(null)}
        title="Save your recovery codes"
        description="Each one works once, and only these get you in if you lose your phone. They are not shown again."
        footer={
          <Button variant="primary" onClick={() => setCodes(null)}>
            I have saved them
          </Button>
        }
      >
        <div className="space-y-3">
          <ul className="readout grid grid-cols-2 gap-1.5 px-3 py-3 text-[13px]">
            {(codes ?? []).map((entry) => (
              <li key={entry} className="tracking-[0.08em]">
                {entry}
              </li>
            ))}
          </ul>
          <Button
            variant="secondary"
            onClick={() => {
              void copyToClipboard((codes ?? []).join('\n'));
              toast.push({ tone: 'ok', message: 'Recovery codes copied.' });
            }}
          >
            <Copy className="h-4 w-4" aria-hidden />
            Copy all
          </Button>
          <p className="text-[12.5px] leading-relaxed text-ink-subtle">
            Keep these somewhere that is not your phone — a password manager, or
            printed. If you lose both the app and these codes, nobody can let you
            back in.
          </p>
        </div>
      </Modal>
    </>
  );
}

// ───────────────────────────────────────────────────────────────── api keys ──

function ApiKeysCard() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);

  const keys = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api.get<{ keys: ApiKeyRow[] }>('/api/keys'),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['api-keys'] });

  const create = useMutation({
    mutationFn: () => api.post<{ token: string }>('/api/keys', { name: name.trim(), scopes: ['*'] }),
    onSuccess: (result) => {
      setCreating(false);
      setName('');
      setIssued(result.token);
      refresh();
    },
    onError: (err) => {
      if (err instanceof ApiError) toast.push({ tone: 'danger', message: err.body.message });
    },
  });

  const revoke = useMutation({
    mutationFn: (uid: string) => api.delete(`/api/keys/${uid}`),
    onSuccess: () => {
      toast.push({ tone: 'ok', message: 'Key revoked.' });
      setRevoking(null);
      refresh();
    },
    onError: (err) => {
      if (err instanceof ApiError) toast.push({ tone: 'danger', message: err.body.message });
    },
  });

  const list = keys.data?.keys ?? [];

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>API keys</CardTitle>
              <CardDescription>
                For scripts and automation. Choose full access or limit a key to
                specific permissions — treat every key like a password.
              </CardDescription>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              New key
            </Button>
          </div>
        </CardHeader>

        {list.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No API keys"
            description="Create one if you want to control your servers from a script, a cron job, or another tool."
          />
        ) : (
          <ul className="divide-y divide-line">
            {list.map((key) => (
              <li key={key.uid} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-ink">
                      {key.name}
                    </span>
                    <code className="rounded-sm border border-line bg-canvas/60 px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
                      {key.prefix}…
                    </code>
                    {key.expiresAt && <Badge tone="warn">Expires {timeAgo(key.expiresAt)}</Badge>}
                  </div>
                  <p className="mt-0.5 text-[11.5px] text-ink-subtle">
                    Created {timeAgo(key.createdAt)} ·{' '}
                    {key.lastUsedAt ? `last used ${timeAgo(key.lastUsedAt)}` : 'never used'}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Revoke ${key.name}`}
                  title="Revoke"
                  onClick={() => setRevoking(key)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New API key"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={name.trim() === ''}
              onClick={() => create.mutate()}
            >
              Create key
            </Button>
          </>
        }
      >
        <Field
          label="What is it for?"
          help="A name you will recognise later, like “backup script” or “status page”."
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            placeholder="Backup script"
            data-autofocus
          />
        </Field>
      </Modal>

      {/* The one and only time the plaintext key exists in the UI. */}
      <Modal
        open={issued !== null}
        onClose={() => setIssued(null)}
        title="Copy your key now"
        description="This is the only time it is shown. If you lose it, revoke it and make another."
        footer={
          <Button variant="primary" onClick={() => setIssued(null)}>
            Done
          </Button>
        }
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <code className="readout min-w-0 flex-1 break-all px-3 py-2 text-[12px]">
              {issued}
            </code>
            <Button
              variant="secondary"
              size="icon"
              aria-label="Copy key"
              onClick={async () => {
                const ok = await copyToClipboard(issued ?? '');
                toast.push({ tone: ok ? 'ok' : 'danger', message: ok ? 'Copied' : 'Could not copy' });
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            Send it as a header:{' '}
            <code className="text-ink">Authorization: Bearer &lt;key&gt;</code>
          </p>
        </div>
      </Modal>

      <Modal
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={`Revoke "${revoking?.name}"?`}
        description="Anything using this key stops working immediately."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={revoke.isPending}
              onClick={() => revoking && revoke.mutate(revoking.uid)}
            >
              Revoke key
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-muted">This cannot be undone, but you can create a new key.</p>
      </Modal>
    </>
  );
}
