'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldAlert, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { inkOn, timeAgo } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  useToast,
} from '@/components/ui';

/**
 * People.
 *
 * Panel accounts, not per-server access — that lives on each server's Access
 * tab. The two are deliberately separate: adding someone here does not give
 * them a single server, and it should not look like it does.
 *
 * The API enforces the rules that keep a panel administrable (only an owner
 * changes roles, the last owner cannot be demoted, nobody suspends
 * themselves). This screen mirrors them so the controls are absent rather
 * than present-and-rejected.
 */

interface PanelUser {
  uid: string;
  username: string;
  displayName: string;
  role: 'owner' | 'admin' | 'user';
  suspended: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  _count: { ownedServers: number };
}

interface Me {
  user: { uid: string; role: string };
}

const ROLE_LABELS: Record<PanelUser['role'], { label: string; help: string }> = {
  owner: { label: 'Owner', help: 'Everything, including network settings and other owners.' },
  admin: { label: 'Admin', help: 'Every server and every account, but cannot change roles.' },
  user: { label: 'Member', help: 'Only the servers they own or have been given access to.' },
};

export default function PeoplePage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [inviting, setInviting] = useState(false);
  const [confirming, setConfirming] = useState<PanelUser | null>(null);

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/api/auth/me') });
  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.get<{ users: PanelUser[] }>('/api/admin/users'),
    retry: false,
  });

  const onError = (error: unknown) => {
    if (error instanceof ApiError) {
      toast.push({ tone: 'danger', message: error.body.message, hint: error.body.hint });
    }
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-users'] });

  const update = useMutation({
    mutationFn: ({ user, body }: { user: PanelUser; body: Record<string, unknown> }) =>
      api.patch(`/api/admin/users/${user.uid}`, body),
    onSuccess: (_result, { user, body }) => {
      toast.push({
        tone: 'ok',
        message:
          body.suspended !== undefined
            ? `${user.displayName} ${body.suspended ? 'suspended' : 'restored'}.`
            : `${user.displayName} is now ${ROLE_LABELS[body.role as PanelUser['role']].label.toLowerCase()}.`,
      });
      setConfirming(null);
      refresh();
    },
    onError,
  });

  if (users.error instanceof ApiError && users.error.status === 403) {
    return (
      <div className="page-shell">
        <Card>
          <CardBody className="py-10 text-center">
            <p className="text-[13px] text-ink-muted">
              Only the panel owner and administrators can manage accounts.
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  const list = users.data?.users ?? [];
  const isOwner = me.data?.user.role === 'owner';

  return (
    <div className="page-shell space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="legend mb-2">Panel</p>
          <h1 className="engraved text-lg sm:text-xl">People</h1>
          <p className="mt-1.5 text-[13px] text-ink-muted">
            Everyone with an account on this panel. To share one server rather than the panel, use
            that server&apos;s Access tab.
          </p>
        </div>
        <Button variant="primary" onClick={() => setInviting(true)}>
          <UserPlus className="h-4 w-4" aria-hidden />
          Add an account
        </Button>
      </div>

      {users.isLoading ? (
        <Skeleton className="h-44 w-full rounded-lg" />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title="No accounts yet"
            description="That should not be possible — you are signed in. Try reloading."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {list.map((user) => {
              const isSelf = user.uid === me.data?.user.uid;
              // Roles are the owner's to change, and never your own — the API
              // says the same, so this only removes a control that would fail.
              const canChangeRole = isOwner && !isSelf;
              const canSuspend = !isSelf && user.role !== 'owner';

              return (
                <li key={user.uid} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-medium"
                    style={{ backgroundColor: '#6b7280', color: inkOn('#6b7280') }}
                    aria-hidden
                  >
                    {user.displayName.slice(0, 1).toUpperCase()}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-ink">
                        {user.displayName}
                      </span>
                      <span className="truncate font-mono text-[11.5px] text-ink-subtle">
                        {user.username}
                      </span>
                      {isSelf && <Badge tone="accent">You</Badge>}
                      {user.suspended && <Badge tone="danger">Suspended</Badge>}
                    </div>
                    <p className="mt-0.5 text-[11.5px] text-ink-subtle">
                      {ROLE_LABELS[user.role].label} · {user._count.ownedServers} server
                      {user._count.ownedServers === 1 ? '' : 's'} ·{' '}
                      {user.lastLoginAt
                        ? `last signed in ${timeAgo(user.lastLoginAt)}`
                        : 'never signed in'}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {canChangeRole ? (
                      <Select
                        className="w-28"
                        aria-label={`Role for ${user.displayName}`}
                        value={user.role}
                        disabled={update.isPending}
                        onChange={(e) =>
                          update.mutate({ user, body: { role: e.target.value } })
                        }
                      >
                        <option value="user">Member</option>
                        <option value="admin">Admin</option>
                        <option value="owner">Owner</option>
                      </Select>
                    ) : (
                      <Badge tone={user.role === 'user' ? 'neutral' : 'info'}>
                        {ROLE_LABELS[user.role].label}
                      </Badge>
                    )}

                    {canSuspend && (
                      <Button
                        variant={user.suspended ? 'secondary' : 'ghost'}
                        size="sm"
                        onClick={() =>
                          user.suspended
                            ? update.mutate({ user, body: { suspended: false } })
                            : setConfirming(user)
                        }
                      >
                        {user.suspended ? 'Restore' : 'Suspend'}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <div className="flex items-start gap-2.5 rounded-lg border border-line bg-surface-raised px-4 py-3">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" aria-hidden />
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          There is no password reset by email yet. If someone is locked out, suspend the account and
          create them a new one, or reset it directly in the database.
        </p>
      </div>

      {inviting && (
        <InviteModal
          canMakeAdmins={isOwner}
          onClose={() => setInviting(false)}
          onCreated={(name) => {
            toast.push({ tone: 'ok', message: `${name} can now sign in.` });
            setInviting(false);
            refresh();
          }}
          onError={onError}
        />
      )}

      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={`Suspend ${confirming?.displayName}?`}
        description="They are signed out everywhere and cannot sign back in."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={update.isPending}
              onClick={() =>
                confirming && update.mutate({ user: confirming, body: { suspended: true } })
              }
            >
              Suspend account
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-ink-muted">
            Their servers keep running and nothing is deleted. You can restore the account at any
            time.
          </p>
          {confirming && confirming._count.ownedServers > 0 && (
            <div className="flex items-start gap-2.5 rounded-lg border border-warn/30 bg-warn/10 px-4 py-3">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
              <p className="text-[12.5px] leading-relaxed text-ink-muted">
                They own {confirming._count.ownedServers} server
                {confirming._count.ownedServers === 1 ? '' : 's'}. Nobody but an admin will be able
                to manage {confirming._count.ownedServers === 1 ? 'it' : 'them'} while the account is
                suspended.
              </p>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── invite ──

function InviteModal({
  canMakeAdmins,
  onClose,
  onCreated,
  onError,
}: {
  canMakeAdmins: boolean;
  onClose: () => void;
  onCreated: (displayName: string) => void;
  onError: (error: unknown) => void;
}) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<PanelUser['role']>('user');

  const create = useMutation({
    mutationFn: () =>
      api.post<{ user: PanelUser }>('/api/admin/users', {
        username: username.trim().toLowerCase(),
        displayName: displayName.trim() || undefined,
        password,
        role,
      }),
    onSuccess: (result) => onCreated(result.user.displayName),
    onError,
  });

  const fieldIssue = (key: string) =>
    create.error instanceof ApiError
      ? create.error.fieldIssues.find((issue) => issue.key === key)?.message
      : undefined;

  return (
    <Modal
      open
      onClose={onClose}
      title="Add an account"
      description="You set the first password and pass it on — there are no invite emails."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!username.trim() || password.length < 10}
            onClick={() => create.mutate()}
          >
            Create account
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Username"
          required
          help="What they type to sign in. Lowercase, no spaces."
          error={fieldIssue('username')}
        >
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="jordan"
            autoCapitalize="none"
            autoCorrect="off"
            data-autofocus
          />
        </Field>

        <Field label="Display name" help="Optional. Defaults to the username.">
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Jordan"
          />
        </Field>

        <Field
          label="Starting password"
          required
          help="At least 10 characters. Give it to them over something private and ask them to change it in Account."
          error={fieldIssue('password')}
        >
          <Input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="correct-horse-battery-staple"
            autoComplete="off"
          />
        </Field>

        <Field label="Role" help={ROLE_LABELS[role].help}>
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as PanelUser['role'])}
            disabled={!canMakeAdmins}
          >
            <option value="user">Member</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </Select>
        </Field>

        {!canMakeAdmins && (
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            Only the panel owner can create administrator accounts.
          </p>
        )}
      </div>
    </Modal>
  );
}
