'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { PageTitle } from '@/components/PageTitle';
import { displayName } from '@/lib/servers';
import { copyText } from '@/lib/clipboard';
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
  const [users, setUsers] = useState<User[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [servers, setServers] = useState<{ uid: string; name: string }[]>([]);
  const [role, setRole] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const refresh = useCallback(async () => {
    const [a, b, c, me] = await Promise.all([
      api<{ users: User[] }>('/api/admin/users'),
      api<{ invitations: Invite[] }>('/api/admin/invites'),
      api<{ servers: { uid: string; name: string }[] }>('/api/servers'),
      api<{ user: { role: string } }>('/api/me'),
    ]);
    setUsers(a.users);
    setInvites(b.invitations);
    setServers(c.servers);
    setRole(me.user.role);
  }, []);
  useEffect(() => {
    void refresh().catch((err) => setError(err.message));
  }, [refresh]);
  async function action(url: string, body: object, method = 'POST') {
    setPending(true);
    setError('');
    try {
      const result = await api<{ path?: string }>(url, { method, body: JSON.stringify(body) });
      if (result.path) setLink(new URL(result.path, window.location.origin).href);
      setCode('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update workspace access.');
    } finally {
      setPending(false);
    }
  }
  function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const selected = form
      .getAll('server')
      .map((serverUid) => ({
        serverUid,
        permissions: [...new Set(['server.view', ...form.getAll('permission')])],
      }));
    void action('/api/admin/invites', { role: form.get('role'), grants: selected });
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PEOPLE & PERMISSIONS</div>
          <PageTitle>Workspace accounts</PageTitle>
          <p className="muted">Invite your community and control who can manage this host.</p>
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="stack" style={{ maxWidth: 1100 }}>
        <section className="card stack">
          <h2>Create an invitation</h2>
          <p className="muted">Share the link privately. It expires in 72 hours and works once.</p>
          <form className="stack" onSubmit={invite}>
            <label>
              Workspace role
              <select name="role" defaultValue="user">
                <option value="user">User — selected servers only</option>
                {role === 'owner' && (
                  <option value="admin">Administrator — all servers and workspace users</option>
                )}
              </select>
            </label>
            <fieldset className="settings-group">
              <legend>Initial server access</legend>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {servers.map((server) => (
                  <label className="setting-checkbox" key={server.uid}>
                    <input type="checkbox" name="server" value={server.uid} />
                    {server.name}
                  </label>
                ))}
              </div>
              {!servers.length && <p className="muted">You can add server access later.</p>}
            </fieldset>
            <fieldset className="settings-group">
              <legend>Permissions on selected servers</legend>
              <div className="row" style={{ flexWrap: 'wrap', gap: 14 }}>
                {SERVER_PERMISSIONS.filter((permission) => permission !== 'server.view').map(
                  (permission) => (
                    <label className="setting-checkbox" key={permission}>
                      <input type="checkbox" name="permission" value={permission} />
                      {displayName(permission.replace('server.', ''))}
                    </label>
                  ),
                )}
              </div>
              <small className="muted">Viewing the server is included.</small>
            </fieldset>
            <button className="btn" disabled={pending}>
              Create invitation link
            </button>
          </form>
          {link && (
            <div className="stack" role="status">
              <label>
                Invitation link
                <input readOnly value={link} onFocus={(event) => event.target.select()} />
              </label>
              <button
                className="btn secondary"
                onClick={() =>
                  void copyText(link).catch(() =>
                    setError('Select and copy the invitation link manually.'),
                  )
                }
              >
                Copy invitation
              </button>
            </div>
          )}
        </section>
        <section className="card stack">
          <h2>Pending invitations</h2>
          {invites
            .filter(
              (invite) =>
                !invite.acceptedAt &&
                !invite.revokedAt &&
                Date.parse(invite.expiresAt) > Date.now(),
            )
            .map((invite) => (
              <div className="row" key={invite.uid} style={{ justifyContent: 'space-between' }}>
                <span>
                  {invite.role} · Expires {new Date(invite.expiresAt).toLocaleString()}
                </span>
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
        <section className="card stack">
          <h2>Manage accounts</h2>
          <p className="muted">
            Role and suspension changes revoke existing sessions and keys. Verify these changes with
            your current password and second factor.
          </p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label style={{ flex: 1 }}>
              Your current password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label style={{ flex: 1 }}>
              Your authenticator or recovery code
              <input
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
          </div>
          {users.map((user) => (
            <form
              className="row"
              key={user.uid}
              style={{
                justifyContent: 'space-between',
                alignItems: 'end',
                flexWrap: 'wrap',
                padding: '12px 0',
                gap: 12,
              }}
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void action(
                  `/api/admin/users/${user.uid}`,
                  {
                    password,
                    code,
                    role: form.get('role'),
                    suspended: form.get('suspended') === 'yes',
                  },
                  'PATCH',
                );
              }}
            >
              <div style={{ flex: '1 1 180px' }}>
                <strong>{user.displayName}</strong>
                <p className="muted">
                  {user.username} · {user.totpEnabledAt ? '2FA enabled' : 'Password sign-in'}
                </p>
              </div>
              <label>
                Role
                <select
                  name="role"
                  defaultValue={user.role}
                  disabled={role !== 'owner' && user.role !== 'user'}
                >
                  <option value="user">User</option>
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
              <button
                className="btn secondary"
                disabled={pending || !password || (role !== 'owner' && user.role !== 'user')}
              >
                Save
              </button>
            </form>
          ))}
        </section>
      </div>
    </>
  );
}
