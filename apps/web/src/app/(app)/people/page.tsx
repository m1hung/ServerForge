'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, ShieldAlert, UserPlus, Users } from 'lucide-react';
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

      <RolesCard canManage={isOwner || me.data?.user.role === 'admin'} onError={onError} />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────── roles ──

const SERVER_PERMISSIONS = [
  'server.view',
  'server.power',
  'server.console',
  'server.settings',
  'server.files',
  'server.backups',
  'server.schedules',
  'server.mods',
  'server.subusers',
  'server.delete',
] as const;
type ServerPermission = (typeof SERVER_PERMISSIONS)[number];
type PermissionState = 'allow' | 'deny';
type PermissionMap = Partial<Record<ServerPermission, PermissionState>>;

interface AccessRole {
  uid: string;
  name: string;
  description: string | null;
  permissions: PermissionMap;
  assignments: number;
}

function permissionLabel(permission: ServerPermission): string {
  return permission.replace('server.', '').replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Reusable permission sets, assigned per server on a server's Access tab.
 *
 * The three-way control is the whole point. "Neutral" is not the same as "no":
 * it leaves the decision to whatever else the person has, while "deny" takes
 * the permission away even from a panel admin or the server's own owner.
 */
function RolesCard({
  canManage,
  onError,
}: {
  canManage: boolean;
  onError: (error: unknown) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<AccessRole | 'new' | null>(null);

  const roles = useQuery({
    queryKey: ['access-roles'],
    queryFn: () => api.get<{ roles: AccessRole[] }>('/api/admin/roles'),
    retry: false,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['access-roles'] });

  const remove = useMutation({
    mutationFn: (role: AccessRole) => api.delete(`/api/admin/roles/${role.uid}`),
    onSuccess: (_result, role) => {
      toast.push({ tone: 'ok', message: `"${role.name}" deleted.` });
      refresh();
    },
    onError,
  });

  const list = roles.data?.roles ?? [];

  return (
    <>
      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="engraved text-[15px]">Access roles</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
                Named sets of server permissions. Define one here, then hand it
                out on a server&apos;s Access tab — changing the role changes
                what everyone holding it can do, everywhere, at once.
              </p>
            </div>
            {canManage && (
              <Button variant="secondary" onClick={() => setEditing('new')}>
                <Plus className="h-4 w-4" aria-hidden />
                New role
              </Button>
            )}
          </div>

          {roles.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : list.length === 0 ? (
            <p className="text-[13px] text-ink-subtle">
              No roles yet. Direct permissions on each server still work — roles
              are for when you are repeating yourself.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {list.map((role) => {
                const allowed = SERVER_PERMISSIONS.filter((p) => role.permissions[p] === 'allow');
                const denied = SERVER_PERMISSIONS.filter((p) => role.permissions[p] === 'deny');
                return (
                  <li key={role.uid} className="flex flex-wrap items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-medium text-ink">{role.name}</span>
                        <Badge tone="neutral">
                          {role.assignments} assignment{role.assignments === 1 ? '' : 's'}
                        </Badge>
                      </div>
                      {role.description && (
                        <p className="mt-0.5 text-[12.5px] text-ink-muted">{role.description}</p>
                      )}
                      <p className="mt-1 text-[12px] text-ink-subtle">
                        {allowed.length > 0 && `Allows ${allowed.map(permissionLabel).join(', ')}`}
                        {allowed.length > 0 && denied.length > 0 && ' · '}
                        {denied.length > 0 && (
                          <span className="text-danger">
                            Denies {denied.map(permissionLabel).join(', ')}
                          </span>
                        )}
                        {allowed.length === 0 && denied.length === 0 && 'Grants nothing yet.'}
                      </p>
                    </div>
                    {canManage && (
                      <div className="flex shrink-0 gap-1.5">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(role)}>
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={remove.isPending}
                          onClick={() => remove.mutate(role)}
                        >
                          Delete
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      {editing && (
        <RoleEditor
          role={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
          onError={onError}
        />
      )}
    </>
  );
}

function RoleEditor({
  role,
  onClose,
  onSaved,
  onError,
}: {
  role: AccessRole | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [permissions, setPermissions] = useState<PermissionMap>(role?.permissions ?? {});

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        permissions,
      };
      return role
        ? api.patch(`/api/admin/roles/${role.uid}`, body)
        : api.post('/api/admin/roles', body);
    },
    onSuccess: onSaved,
    onError,
  });

  const setState = (permission: ServerPermission, next: PermissionState | null) =>
    setPermissions((current) => {
      const copy = { ...current };
      // Neutral is expressed by absence, so it deletes rather than storing a
      // third value — one representation, one meaning.
      if (next === null) delete copy[permission];
      else copy[permission] = next;
      return copy;
    });

  return (
    <Modal
      open
      onClose={onClose}
      title={role ? `Edit "${role.name}"` : 'New access role'}
      description="Neutral leaves the decision to whatever else the person has. Deny takes the permission away even from an admin."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={name.trim() === ''}
            onClick={() => save.mutate()}
          >
            {role ? 'Save changes' : 'Create role'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Name" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={48}
            placeholder="Moderators"
            data-autofocus
          />
        </Field>

        <Field label="Description" help="Optional. What this role is for.">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={200}
            placeholder="Console and restarts, nothing destructive"
          />
        </Field>

        <div className="space-y-1.5">
          <p className="legend text-ink-muted">Permissions</p>
          <ul className="divide-y divide-line">
            {SERVER_PERMISSIONS.map((permission) => {
              const state = permissions[permission] ?? null;
              return (
                <li key={permission} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-[13px] text-ink">{permissionLabel(permission)}</span>
                  <div className="flex shrink-0 gap-1" role="group" aria-label={permission}>
                    {(
                      [
                        { value: null, label: 'Neutral' },
                        { value: 'allow', label: 'Allow' },
                        { value: 'deny', label: 'Deny' },
                      ] as const
                    ).map((option) => {
                      const active = state === option.value;
                      const tone =
                        option.value === 'deny'
                          ? 'border-danger bg-danger/10 text-danger'
                          : option.value === 'allow'
                            ? 'border-ok bg-ok/10 text-ok'
                            : 'border-accent bg-accent/10 text-accent';
                      return (
                        <button
                          key={option.label}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setState(permission, option.value)}
                          className={
                            active
                              ? `rounded-md border px-2 py-1 text-[12px] ${tone}`
                              : 'rounded-md border border-line bg-surface-raised px-2 py-1 text-[12px] text-ink-subtle hover:text-ink'
                          }
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </Modal>
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
