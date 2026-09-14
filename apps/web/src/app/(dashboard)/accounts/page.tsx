'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { permissionLabels } from '@/lib/permission-labels';
import { PageTitle } from '@/components/PageTitle';
import { CopyButton } from '@/components/CopyButton';
import { SecurityDialog } from '@/components/SecurityDialog';
import { useCurrentUser } from '@/components/Shell';
import { SERVER_PERMISSIONS } from '@serverforge/core/types';

type User = {
  uid: string;
  username: string;
  displayName: string;
  role: string;
  suspended: boolean;
  totpEnabledAt: string | null;
};
type Invite = {
  uid: string;
  role: string;
  expiresAt: string;
  revokedAt: string | null;
  acceptedAt: string | null;
};

export default function AccountsPage() {
  const currentUser = useCurrentUser();
  const [users, setUsers] = useState<User[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [servers, setServers] = useState<{ uid: string; name: string }[]>([]);
  const [inviteRole, setInviteRole] = useState('user');
  const [access, setAccess] = useState('view');
  const [selectedServers, setSelectedServers] = useState<string[]>([]);
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [change, setChange] = useState<{
    user: User;
    body: { role?: string; suspended?: boolean };
  } | null>(null);
  const role = currentUser?.role;
  const refresh = useCallback(async () => {
    const [a, b, c] = await Promise.all([
      api<{ users: User[] }>('/api/admin/users'),
      api<{ invitations: Invite[] }>('/api/admin/invites'),
      api<{ servers: { uid: string; name: string }[] }>('/api/servers'),
    ]);
    setUsers(a.users);
    setInvites(b.invitations);
    setServers(c.servers);
  }, []);
  useEffect(() => {
    void refresh().catch((err) => setError(err.message));
  }, [refresh]);
  async function action(url: string, body: object, method = 'POST') {
    if (pending) return;
    setPending(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ path?: string }>(url, { method, body: JSON.stringify(body) });
      if (result.path) setLink(new URL(result.path, window.location.origin).href);
      else setLink('');
      setNotice(
        result.path
          ? 'Invitation created. Copy the private link below.'
          : 'Invitation revoked. The link can no longer be used.',
      );
      await refresh().catch(() => setError('Change saved. Reload to refresh the invitation list.'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update workspace access.');
    } finally {
      setPending(false);
    }
  }
  function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const permissions =
      access === 'operate'
        ? ['server.view', 'server.power', 'server.console']
        : access === 'custom'
          ? [...new Set(['server.view', ...form.getAll('permission')])]
          : ['server.view'];
    void action('/api/admin/invites', {
      role: inviteRole,
      grants:
        inviteRole === 'admin'
          ? []
          : selectedServers.map((serverUid) => ({ serverUid, permissions })),
    });
  }
  const pendingInvites = invites.filter(
    (invite) =>
      !invite.acceptedAt && !invite.revokedAt && Date.parse(invite.expiresAt) > Date.now(),
  );
  const activeOwners = users?.filter((user) => user.role === 'owner' && !user.suspended).length;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PEOPLE & PERMISSIONS</div>
          <PageTitle>Workspace accounts</PageTitle>
          <p className="muted">
            Invite people to the dashboard and choose what they can manage. Players joining a game
            don’t need a dashboard account.
          </p>
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button
            className="text-button"
            onClick={() =>
              void refresh()
                .then(() => setError(''))
                .catch((err) => setError(err.message))
            }
          >
            Try again
          </button>
        </div>
      )}
      {notice && (
        <p className="notice-banner" role="status">
          {notice}
        </p>
      )}
      <div className="settings-page">
        <nav className="section-links" aria-label="Workspace account sections">
          <a href="#invite-people">Invite people</a>
          <a href="#invitations">Pending invitations</a>
          <a href="#manage-accounts">Manage accounts</a>
        </nav>
        <section className="card stack" id="invite-people">
          <h2>Create an invitation</h2>
          <p className="muted">Share the link privately. It expires in 72 hours and works once.</p>
          <form className="stack" onSubmit={invite} aria-busy={pending}>
            <fieldset className="configuration-inputs stack" disabled={pending || !users}>
              <label>
                Workspace role
                <select
                  name="role"
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value)}
                >
                  <option value="user">Member — selected servers only</option>
                  {role === 'owner' && (
                    <option value="admin">Administrator — all servers and workspace users</option>
                  )}
                </select>
              </label>
              {inviteRole === 'admin' ? (
                <p className="summary-notice">
                  Administrators can manage every server and invite members. Only owners can change
                  administrator access.
                </p>
              ) : (
                <>
                  <fieldset className="settings-group">
                    <legend>Initial server access</legend>
                    <div className="permission-grid">
                      {servers.map((server) => (
                        <label className="setting-checkbox" key={server.uid}>
                          <input
                            type="checkbox"
                            name="server"
                            value={server.uid}
                            checked={selectedServers.includes(server.uid)}
                            onChange={(event) =>
                              setSelectedServers(
                                event.target.checked
                                  ? [...selectedServers, server.uid]
                                  : selectedServers.filter((uid) => uid !== server.uid),
                              )
                            }
                          />
                          {server.name}
                        </label>
                      ))}
                    </div>
                    <p className="field-hint">
                      {selectedServers.length
                        ? `${selectedServers.length} server${selectedServers.length === 1 ? '' : 's'} selected.`
                        : 'No servers selected. This person will see an empty workspace until you add shared access on a server.'}
                    </p>
                  </fieldset>
                  {!!selectedServers.length && (
                    <>
                      <label>
                        Access level
                        <select value={access} onChange={(event) => setAccess(event.target.value)}>
                          <option value="view">View only — server status and performance</option>
                          <option value="operate">
                            Operator — also start, stop, and use the console
                          </option>
                          <option value="custom">Custom — choose individual permissions</option>
                        </select>
                      </label>
                      {access === 'operate' && (
                        <p className="field-hint">
                          Console access includes game administrator commands. Give it only to
                          people you trust to run the server.
                        </p>
                      )}
                      {access === 'custom' && (
                        <fieldset className="settings-group">
                          <legend>Permissions on selected servers</legend>
                          <div className="permission-grid">
                            {SERVER_PERMISSIONS.filter(
                              (permission) => permission !== 'server.view',
                            ).map((permission) => (
                              <label className="setting-checkbox" key={permission}>
                                <input type="checkbox" name="permission" value={permission} />
                                {permissionLabels[permission]}
                              </label>
                            ))}
                          </div>
                          <p className="field-hint">Viewing the server is always included.</p>
                        </fieldset>
                      )}
                    </>
                  )}
                </>
              )}
              <div className="form-actions">
                <button className="btn">{pending ? 'Creating…' : 'Create invitation link'}</button>
              </div>
            </fieldset>
          </form>
          {link && (
            <div className="invite-result stack">
              <label>
                Invitation link
                <input readOnly value={link} onFocus={(event) => event.target.select()} />
              </label>
              <div className="form-actions">
                <CopyButton value={link} label="Copy invitation" />
              </div>
            </div>
          )}
        </section>
        <section className="card stack" id="invitations">
          <h2>Pending invitations</h2>
          {users && !pendingInvites.length && (
            <p className="empty-note">
              No pending invitations. New links will appear here until accepted, revoked, or
              expired.
            </p>
          )}
          {pendingInvites.map((invite) => (
            <div className="settings-item" key={invite.uid}>
              <div>
                <strong>{invite.role === 'admin' ? 'Administrator' : 'Member'} invitation</strong>
                <p className="muted">Expires {new Date(invite.expiresAt).toLocaleString()}</p>
              </div>
              <button
                className="btn secondary"
                disabled={pending || (role !== 'owner' && invite.role !== 'user')}
                onClick={() => void action(`/api/admin/invites/${invite.uid}`, {}, 'DELETE')}
              >
                Revoke
              </button>
            </div>
          ))}
        </section>
        <section className="card stack" id="manage-accounts">
          <h2>Manage accounts</h2>
          <p className="muted">
            Role and suspension changes sign out that person and revoke their API keys. You’ll
            confirm with your own password before saving.
          </p>
          {!users && (
            <p className="muted" role="status">
              {error ? 'Account list unavailable.' : 'Loading accounts…'}
            </p>
          )}
          {users?.map((user) => {
            const lastOwner = user.role === 'owner' && !user.suspended && activeOwners === 1;
            const canEdit = !lastOwner && (role === 'owner' || user.role === 'user');
            return (
              <form
                className="settings-item"
                key={`${user.uid}-${user.role}-${user.suspended}`}
                aria-label={`Manage ${user.username}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  const nextRole = String(form.get('role'));
                  const suspended = form.get('suspended') === 'yes';
                  const body = {
                    ...(nextRole !== user.role ? { role: nextRole } : {}),
                    ...(suspended !== user.suspended ? { suspended } : {}),
                  };
                  if (!Object.keys(body).length) {
                    setNotice('No changes to save.');
                    return;
                  }
                  setChange({ user, body });
                }}
              >
                <div>
                  <strong>{user.displayName}</strong>
                  <p className="muted">
                    @{user.username} ·{' '}
                    {user.totpEnabledAt ? 'Two-factor enabled' : 'Password sign-in'}
                  </p>
                  {lastOwner && (
                    <p className="field-hint">
                      Last active owner — add another owner before changing this account’s access.
                    </p>
                  )}
                </div>
                <fieldset
                  className="configuration-inputs form-actions"
                  disabled={!canEdit || pending}
                >
                  <label>
                    Role
                    <select name="role" defaultValue={user.role}>
                      <option value="user">Member</option>
                      {(role === 'owner' || user.role === 'admin') && (
                        <option value="admin">Administrator</option>
                      )}
                      {(role === 'owner' || user.role === 'owner') && (
                        <option value="owner">Owner</option>
                      )}
                    </select>
                  </label>
                  <label>
                    Status
                    <select name="suspended" defaultValue={user.suspended ? 'yes' : 'no'}>
                      <option value="no">Active</option>
                      <option value="yes">Suspended</option>
                    </select>
                  </label>
                  <button className="btn secondary">Save</button>
                </fieldset>
              </form>
            );
          })}
        </section>
      </div>
      {change && (
        <SecurityDialog
          title={`Update ${change.user.displayName}`}
          description={`Apply these account changes: ${change.body.role ? `role → ${change.body.role}` : ''}${change.body.role && change.body.suspended !== undefined ? '; ' : ''}${change.body.suspended !== undefined ? `status → ${change.body.suspended ? 'suspended' : 'active'}` : ''}. Existing sessions and API keys will be revoked.`}
          requireCode={
            !!users?.find((user) => user.username === currentUser?.username)?.totpEnabledAt
          }
          onClose={() => setChange(null)}
          onConfirm={async (proof) => {
            await api(`/api/admin/users/${change.user.uid}`, {
              method: 'PATCH',
              body: JSON.stringify({ ...proof, ...change.body }),
            });
            if (change.user.username === currentUser?.username) {
              window.location.href = '/login';
              return;
            }
            setNotice(`${change.user.displayName} updated.`);
            setError('');
            await refresh().catch(() =>
              setError('Change saved. Reload to refresh account access.'),
            );
          }}
        />
      )}
    </>
  );
}
