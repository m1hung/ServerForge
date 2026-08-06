'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, UserMinus, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { inkOn, timeAgo } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Skeleton,
  Toggle,
  useToast,
} from '@/components/ui';

/**
 * Sub-users.
 *
 * Sharing a server should not mean sharing a password. The permission list is
 * deliberately short and described in terms of what someone can do, not which
 * endpoint it maps to — "can restart the server" rather than `server.power`.
 *
 * `server.view` is not offered as a choice: it is what being added means, and
 * a membership without it would be a person who can see nothing.
 */

interface AssignedRole {
  uid: string;
  name: string;
  permissions: Record<string, 'allow' | 'deny'>;
}

interface Subuser {
  userId: string;
  permissions: string[];
  roles: AssignedRole[];
  /** What they can actually do once roles and denies are applied. */
  effectivePermissions: string[];
  createdAt: string;
  user: {
    uid: string;
    username: string;
    displayName: string;
    avatarColor: string;
  };
}

const PERMISSIONS: { key: string; label: string; help: string }[] = [
  {
    key: 'server.power',
    label: 'Start, stop and restart',
    help: 'Includes forcing a stop when the server has hung.',
  },
  {
    key: 'server.console',
    label: 'Use the console',
    help: 'Read the log and type commands. Most game commands are as powerful as the game allows.',
  },
  {
    key: 'server.settings',
    label: 'Change game settings',
    help: 'Difficulty, player limit, world settings — anything on the Settings tab.',
  },
  {
    key: 'server.files',
    label: 'Manage files',
    help: 'Browse, edit, upload and delete anything in the server folder.',
  },
  {
    key: 'server.backups',
    label: 'Create and restore backups',
    help: 'Restoring replaces the current world, so this is a bigger permission than it sounds.',
  },
  {
    key: 'server.schedules',
    label: 'Manage scheduled tasks',
    help: 'Add and remove automatic restarts, commands and backups.',
  },
  {
    key: 'server.mods',
    label: 'Install and remove mods',
    help: 'Anything on the Mods tab.',
  },
  {
    key: 'server.subusers',
    label: 'Manage who has access',
    help: 'They can add and remove other people, including granting what they hold themselves.',
  },
];

const PRESETS = {
  moderator: ['server.power', 'server.console'],
  builder: ['server.power', 'server.console', 'server.files'],
  admin: PERMISSIONS.map((p) => p.key).filter((k) => k !== 'server.subusers'),
};

function Avatar({ color, name }: { color: string; name: string }) {
  return (
    <div
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-medium"
      style={{ backgroundColor: color, color: inkOn(color) }}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function SubusersPanel({ uid, permissions }: { uid: string; permissions: string[] }) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<Subuser | 'new' | null>(null);
  const [removing, setRemoving] = useState<Subuser | null>(null);

  const canManage = permissions.includes('server.subusers');

  const subusers = useQuery({
    queryKey: ['subusers', uid],
    queryFn: () => api.get<{ subusers: Subuser[] }>(`/api/servers/${uid}/subusers`),
  });

  const onError = (error: unknown) => {
    if (error instanceof ApiError) {
      toast.push({ tone: 'danger', message: error.body.message, hint: error.body.hint });
    }
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['subusers', uid] });

  const remove = useMutation({
    mutationFn: (subuser: Subuser) =>
      api.delete(`/api/servers/${uid}/subusers/${subuser.user.uid}`),
    onSuccess: (_result, subuser) => {
      toast.push({ tone: 'ok', message: `${subuser.user.displayName} no longer has access.` });
      setRemoving(null);
      refresh();
    },
    onError,
  });

  if (subusers.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  const list = subusers.data?.subusers ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-[13px] text-ink-muted">
          {list.length === 0
            ? 'Only you have access.'
            : `${list.length} ${list.length === 1 ? 'person has' : 'people have'} access.`}{' '}
          They sign in with their own account and see only this server.
        </p>
        {canManage && (
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <UserPlus className="h-4 w-4" aria-hidden />
            Give someone access
          </Button>
        )}
      </div>

      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title="Nobody else has access"
            description="Add someone who already has an account on this panel, and choose exactly what they can do. You can change or remove it at any time."
            action={
              canManage ? (
                <Button variant="primary" onClick={() => setEditing('new')}>
                  Give someone access
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {list.map((subuser) => {
              // The *effective* list, not the switches: someone can have
              // "Restart" turned on and still not be able to restart, because
              // a role denies it. Showing the switch state here would be a lie.
              const effective = subuser.effectivePermissions ?? subuser.permissions;
              const granted = PERMISSIONS.filter((p) => effective.includes(p.key));
              const takenAway = PERMISSIONS.filter(
                (p) => subuser.permissions.includes(p.key) && !effective.includes(p.key),
              );

              return (
                <li key={subuser.user.uid} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Avatar color={subuser.user.avatarColor} name={subuser.user.displayName} />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-ink">
                        {subuser.user.displayName}
                      </span>
                      <span className="truncate font-mono text-[11.5px] text-ink-subtle">
                        {subuser.user.username}
                      </span>
                      {effective.includes('server.subusers') && (
                        <Badge tone="warn">Can add others</Badge>
                      )}
                      {(subuser.roles ?? []).map((role) => (
                        <Badge key={role.uid} tone="accent">
                          {role.name}
                        </Badge>
                      ))}
                    </div>
                    <p className="mt-0.5 text-[12px] text-ink-muted">
                      {granted.length === 0
                        ? 'Can view this server only'
                        : granted.map((p) => p.label.toLowerCase()).join(' · ')}
                    </p>
                    {takenAway.length > 0 && (
                      <p className="mt-0.5 text-[12px] text-danger">
                        Blocked by a role: {takenAway.map((p) => p.label.toLowerCase()).join(' · ')}
                      </p>
                    )}
                    <p className="mt-0.5 text-[11.5px] text-ink-subtle">
                      Added {timeAgo(subuser.createdAt)}
                    </p>
                  </div>

                  {canManage && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(subuser)}>
                        Permissions
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Remove access"
                        aria-label={`Remove ${subuser.user.displayName}`}
                        onClick={() => setRemoving(subuser)}
                      >
                        <UserMinus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {editing && (
        <AccessEditor
          uid={uid}
          subuser={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            toast.push({ tone: 'ok', message });
            setEditing(null);
            refresh();
          }}
          onError={onError}
        />
      )}

      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.user.displayName}?`}
        description="They lose access to this server immediately."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => removing && remove.mutate(removing)}
            >
              Remove access
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Their panel account stays — this only removes them from this server. Anything they already
          changed stays as it is.
        </p>
      </Modal>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── editor ──

function AccessEditor({
  uid,
  subuser,
  onClose,
  onSaved,
  onError,
}: {
  uid: string;
  subuser: Subuser | null;
  onClose: () => void;
  onSaved: (message: string) => void;
  onError: (error: unknown) => void;
}) {
  const [username, setUsername] = useState(subuser?.user.username ?? '');
  const [granted, setGranted] = useState<string[]>(
    subuser?.permissions.filter((p) => p !== 'server.view') ?? PRESETS.moderator,
  );
  const [roleUids, setRoleUids] = useState<string[]>(
    subuser?.roles.map((role) => role.uid) ?? [],
  );

  // Roles are defined panel-wide; this only picks which of them apply here.
  const roles = useQuery({
    queryKey: ['access-roles'],
    queryFn: () => api.get<{ roles: AssignedRole[] }>('/api/admin/roles'),
    retry: false,
  });

  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/servers/${uid}/subusers`, {
        username: username.trim().toLowerCase(),
        // The API needs a role or a permission, and view is what the row means.
        permissions: ['server.view', ...granted],
        roleUids,
      }),
    onSuccess: () =>
      onSaved(
        subuser
          ? `Updated what ${subuser.user.displayName} can do.`
          : `${username.trim()} now has access.`,
      ),
    onError,
  });

  const toggle = (key: string) =>
    setGranted((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );

  const fieldIssue = (key: string) =>
    save.error instanceof ApiError
      ? save.error.fieldIssues.find((issue) => issue.key === key)?.message
      : undefined;

  return (
    <Modal
      open
      onClose={onClose}
      title={subuser ? `What ${subuser.user.displayName} can do` : 'Give someone access'}
      description={
        subuser
          ? undefined
          : 'They need an account on this panel already — you cannot invite someone by email yet.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!username.trim()}
            onClick={() => save.mutate()}
          >
            {subuser ? 'Save changes' : 'Give access'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {subuser ? (
          <div className="flex items-center gap-2.5">
            <Avatar color={subuser.user.avatarColor} name={subuser.user.displayName} />
            <div>
              <p className="text-[13px] text-ink">{subuser.user.displayName}</p>
              <p className="font-mono text-[11.5px] text-ink-subtle">{subuser.user.username}</p>
            </div>
          </div>
        ) : (
          <Field
            label="Username"
            required
            help="Their username on this panel, not their in-game name."
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
        )}

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="legend text-ink-muted">What they can do</p>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setGranted(PRESETS.moderator)}
                className="text-[12px] text-ink-muted underline-offset-2 hover:text-accent hover:underline"
              >
                Moderator
              </button>
              <span className="text-ink-subtle" aria-hidden>
                ·
              </span>
              <button
                type="button"
                onClick={() => setGranted(PRESETS.builder)}
                className="text-[12px] text-ink-muted underline-offset-2 hover:text-accent hover:underline"
              >
                Builder
              </button>
              <span className="text-ink-subtle" aria-hidden>
                ·
              </span>
              <button
                type="button"
                onClick={() => setGranted(PRESETS.admin)}
                className="text-[12px] text-ink-muted underline-offset-2 hover:text-accent hover:underline"
              >
                Co-admin
              </button>
            </div>
          </div>

          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            Everyone added can see the server, its status and its resource graphs. Everything below
            is on top of that.
          </p>

          {(roles.data?.roles.length ?? 0) > 0 && (
            <div className="space-y-2">
              <p className="legend text-ink-muted">Roles</p>
              <p className="text-[12.5px] leading-relaxed text-ink-muted">
                A role applies its own permissions on top of the switches below.
                Anything a role <span className="text-danger">denies</span> is
                taken away even if it is switched on here.
              </p>
              <ul className="divide-y divide-line rounded-lg border border-line">
                {(roles.data?.roles ?? []).map((role) => {
                  const denied = Object.entries(role.permissions)
                    .filter(([, state]) => state === 'deny')
                    .map(([key]) => key.replace('server.', ''));
                  return (
                    <li key={role.uid} className="flex items-start gap-3 px-3.5 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] text-ink">{role.name}</p>
                        {denied.length > 0 && (
                          <p className="mt-0.5 text-[12px] text-danger">
                            Denies {denied.join(', ')}
                          </p>
                        )}
                      </div>
                      <Toggle
                        checked={roleUids.includes(role.uid)}
                        onChange={() =>
                          setRoleUids((current) =>
                            current.includes(role.uid)
                              ? current.filter((entry) => entry !== role.uid)
                              : [...current, role.uid],
                          )
                        }
                        label={role.name}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <ul className="divide-y divide-line rounded-lg border border-line">
            {PERMISSIONS.map((permission) => (
              <li key={permission.key} className="flex items-start gap-3 px-3.5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-ink">{permission.label}</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">
                    {permission.help}
                  </p>
                </div>
                <Toggle
                  checked={granted.includes(permission.key)}
                  onChange={() => toggle(permission.key)}
                  label={permission.label}
                />
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-start gap-2.5 rounded-lg border border-line bg-surface-raised px-4 py-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" aria-hidden />
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            Nobody added here can delete the server, change its memory or disk limits, or reach any
            other server on this panel.
          </p>
        </div>
      </div>
    </Modal>
  );
}
