'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ProtectedLink as Link } from '@/components/UnsavedChanges';
import { api } from '@/lib/api';
import type { Server } from '@/lib/servers';
import { Icon } from './Icon';
import { useCurrentUser } from './Shell';

type Mod = { name: string; enabled: boolean; size: number };
type Mods = {
  directory: string | null;
  extensions: string[];
  description: string;
  canManage: boolean;
  files: Mod[];
};

export function ModsPanel({ server }: { server: Server }) {
  const currentUser = useCurrentUser();
  const canCreate = !!currentUser && ['owner', 'admin'].includes(currentUser.role);
  const canOpenFiles = server.permissions?.includes('server.files') ?? true;
  const [data, setData] = useState<Mods | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<File[]>([]);
  const stopped = ['offline', 'crashed'].includes(server.state);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const result = await api<Mods>(`/api/servers/${server.uid}/mods`, { signal });
      setData(result);
    },
    [server.uid],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((err: Error) => {
      if (!controller.signal.aborted) setError(err.message);
    });
    return () => controller.abort();
  }, [refresh, server.state]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !selected.length) return;
    const form = event.currentTarget;
    setPending(true);
    setError('');
    setMessage('');
    let uploaded = 0;
    try {
      for (const file of selected) {
        if (file.size > 256 * 1024 ** 2)
          throw new Error(`${file.name} exceeds the 256 MiB file limit.`);
        const body = new FormData();
        body.append('file', file);
        await api(`/api/servers/${server.uid}/mods`, { method: 'POST', body });
        uploaded++;
      }
      setSelected([]);
      form.reset();
      setMessage(
        `${uploaded} ${uploaded === 1 ? 'file' : 'files'} added. Start the server to load your mods.`,
      );
    } catch (err) {
      setError(
        `${uploaded ? `${uploaded} files uploaded. ` : ''}${err instanceof Error ? err.message : 'Upload failed.'}`,
      );
      // Successful uploads stay installed; retry only the remaining files.
      setSelected((files) => files.slice(uploaded));
    } finally {
      await refresh().catch(() =>
        setError('Could not refresh the mod list. Refresh before making more changes.'),
      );
      setPending(false);
    }
  }

  async function toggle(mod: Mod) {
    setPending(true);
    setError('');
    setMessage('');
    try {
      await api(`/api/servers/${server.uid}/mods`, {
        method: 'PATCH',
        body: JSON.stringify({ name: mod.name, enabled: !mod.enabled }),
      });
      await refresh();
      setMessage(
        `${mod.name.replace(/\.disabled$/, '')} ${mod.enabled ? 'disabled' : 'enabled'}. Changes apply on the next start.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the mod.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card mods-panel" aria-labelledby="mods-title" aria-busy={pending}>
      <div className="mods-heading">
        <div>
          <div className="eyebrow">MAKE IT YOUR WORLD</div>
          <h2 id="mods-title">
            {server.gameId === 'minecraft-bedrock' ? 'Add-ons' : 'Mods & plugins'}
          </h2>
          <p className="muted">Manage the files that make this server yours.</p>
        </div>
        <button
          className="btn secondary"
          disabled={pending}
          onClick={() => {
            setError('');
            void refresh().catch((err: Error) => setError(err.message));
          }}
        >
          <Icon name="refresh" size={16} />
          Refresh
        </button>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          <Icon name="alert" size={17} />
          {error}
        </div>
      )}
      {message && (
        <div className="mod-notice" role="status">
          <Icon name="check" size={17} />
          {message}
        </div>
      )}
      {!data ? (
        <p className="muted" role="status">
          {error ? 'Mod details are unavailable.' : 'Loading mods…'}
        </p>
      ) : !data.directory && server.gameId === 'minecraft-bedrock' ? (
        <div className="empty-state compact">
          <Icon name="cube" size={26} />
          <h3>Bedrock add-ons</h3>
          <p>
            Stop the server, then use Files to upload and unpack Bedrock behavior and resource
            packs. Attach them to your world using its world_behavior_packs.json and
            world_resource_packs.json files.
          </p>
          <p>Java mods, plugins and CurseForge Java server packs cannot run on Bedrock.</p>
          {canOpenFiles ? (
            <a className="btn secondary" href="#files">
              Open files
              <Icon name="arrow" size={14} />
            </a>
          ) : (
            <p>Ask the server owner for file access to install add-ons.</p>
          )}
        </div>
      ) : !data.directory ? (
        <div className="mod-empty">
          <Icon name="shield" size={28} />
          <h3>This is a vanilla server</h3>
          <p>Deploy a mod-enabled edition of this game to use mods and plugins.</p>
          {canCreate ? (
            <Link className="btn secondary" href="/deploy">
              Deploy a server
              <Icon name="arrow" size={14} />
            </Link>
          ) : (
            <p>Ask your workspace owner to deploy a mod-enabled edition.</p>
          )}
        </div>
      ) : (
        <>
          <div className="mod-compatibility">
            <Icon name="cube" size={20} />
            <div>
              <strong>
                {server.gameId === 'palworld'
                  ? 'Linux PAK compatibility'
                  : 'Match your loader and game version'}
              </strong>
              <p>{data.description}</p>
              <span className="field-hint">
                Install every required dependency. Only add mods from sources you trust.
              </span>
            </div>
          </div>
          {!data.canManage ? (
            <p className="mod-notice">
              Your account needs permission to manage this server’s mods.
            </p>
          ) : (
            <>
              <form className="mod-upload" onSubmit={(event) => void upload(event)}>
                <div>
                  <h3>Add mods</h3>
                  <p>{data.extensions.join(', ')} files · 256 MiB per file</p>
                  <span className="field-hint">
                    {stopped
                      ? 'Files are added enabled. Existing files are never overwritten.'
                      : 'Stop the server to upload, enable, or disable mods.'}
                  </span>
                </div>
                <div className="mod-upload-actions">
                  <label className="mod-file-label">
                    Choose mod files
                    <input
                      type="file"
                      accept={data.extensions.join(',')}
                      multiple
                      disabled={!stopped || pending}
                      onChange={(event) => setSelected(Array.from(event.target.files ?? []))}
                    />
                  </label>
                  <button
                    className="btn"
                    disabled={!stopped || pending || !selected.length}
                    type="submit"
                  >
                    <Icon name="plus" size={16} />
                    {pending
                      ? 'Saving…'
                      : `Upload${selected.length ? ` (${selected.length})` : ''}`}
                  </button>
                </div>
              </form>
              <div className="mod-list-heading">
                <h3>
                  Installed files <span className="count-badge">{data.files.length}</span>
                </h3>
                <span>{data.files.filter((file) => file.enabled).length} enabled</span>
              </div>
              {!data.files.length ? (
                <div className="mod-empty">
                  <Icon name="cube" size={30} />
                  <h3>A clean slate</h3>
                  <p>Upload your first mod and its dependencies to get started.</p>
                </div>
              ) : (
                <ul className="mod-list">
                  {data.files.map((mod) => (
                    <li key={mod.name}>
                      <div className="mod-file-icon">
                        <Icon name="cube" size={20} />
                      </div>
                      <div className="mod-file-name">
                        <strong>{mod.name.replace(/\.disabled$/, '')}</strong>
                        <span>
                          {mod.size < 1024 ** 2
                            ? `${Math.ceil(mod.size / 1024)} KiB`
                            : `${(mod.size / 1024 ** 2).toFixed(1)} MiB`}
                        </span>
                      </div>
                      <span className={`status-pill ${mod.enabled ? 'success' : 'neutral'}`}>
                        {mod.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                      <button
                        className="btn secondary"
                        disabled={!stopped || pending}
                        aria-label={`${mod.enabled ? 'Disable' : 'Enable'} ${mod.name.replace(/\.disabled$/, '')}`}
                        onClick={() => void toggle(mod)}
                      >
                        {mod.enabled ? 'Disable' : 'Enable'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mod-directory">
                Server folder <code>{data.directory}</code>
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
