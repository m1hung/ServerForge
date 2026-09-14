'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ScheduleInput } from '@serverforge/core';
import { SERVER_PERMISSIONS } from '@serverforge/core/types';
import { formatBytes } from '@serverforge/core/format';
import { api, apiBase } from '@/lib/api';
import { displayName, type Server } from '@/lib/servers';
import { permissionLabels } from '@/lib/permission-labels';
import { scheduleTiming, scheduleCron, scheduleDescription } from '@/lib/schedule';
import { Icon } from './Icon';

export type ServerTool =
  | 'files'
  | 'backups'
  | 'diagnostics'
  | 'updates'
  | 'schedules'
  | 'players'
  | 'access';
export const serverTools: { id: ServerTool; label: string; permission: string }[] = [
  { id: 'backups', label: 'Backups & restore', permission: 'server.backups' },
  { id: 'files', label: 'Files', permission: 'server.files' },
  { id: 'diagnostics', label: 'Performance & recovery', permission: 'server.view' },
  { id: 'updates', label: 'Updates & rollback', permission: 'server.mods' },
  { id: 'schedules', label: 'Schedules & alerts', permission: 'server.schedules' },
  { id: 'players', label: 'Players', permission: 'server.view' },
  { id: 'access', label: 'Shared access', permission: 'server.subusers' },
];
const permitted = (server: Server, permission: string) =>
  server.permissions?.includes(permission) ?? true;
const date = (value: string | number | null | undefined) =>
  value ? new Date(value).toLocaleString() : '—';
function useResource<T>(url: string, interval = 5000) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const next = await api<T>(url);
      setData(next);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load data.');
    }
  }, [url]);
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    setData(null);
    const poll = async () => {
      try {
        const next = await api<T>(url);
        if (active) {
          setData(next);
          setError('');
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Could not load data.');
      } finally {
        if (active && interval) timer = setTimeout(() => void poll(), interval);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [url, interval]);
  return { data, error, refresh };
}
function ToolPanel({
  title,
  description,
  error,
  children,
}: {
  title: string;
  description: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <section className="card tool-panel">
      <div className="tool-panel-heading">
        <h2>{title}</h2>
        <p className="muted">{description}</p>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {children}
    </section>
  );
}
function useAction(refresh: () => Promise<unknown>) {
  const [pending, setPending] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const run = async (work: () => Promise<unknown>, success = 'Saved.') => {
    setPending(true);
    setError('');
    setMessage('');
    try {
      await work();
      setMessage(success);
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed.');
      return false;
    } finally {
      setPending(false);
    }
  };
  return { pending, message, error, run };
}
function Notice({ message }: { message: string }) {
  return (
    <p className="tool-notice" role="status">
      {message}
    </p>
  );
}
function ConfirmButton({
  children,
  title,
  description,
  disabled,
  onConfirm,
  danger = false,
}: {
  children: ReactNode;
  title: string;
  description: string;
  disabled?: boolean;
  onConfirm: () => void;
  danger?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        className={`btn secondary${danger ? ' danger' : ''}`}
        disabled={disabled}
        onClick={() => dialog.current?.showModal()}
      >
        {children}
      </button>
      <dialog className="tool-dialog" ref={dialog} aria-label={title}>
        <h2>{title}</h2>
        <p>{description}</p>
        <div className="row">
          <button autoFocus className="btn secondary" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button
            className={`btn${danger ? ' danger' : ''}`}
            onClick={() => {
              dialog.current?.close();
              onConfirm();
            }}
          >
            {children}
          </button>
        </div>
      </dialog>
    </>
  );
}

function Backups({ server }: { server: Server }) {
  const url = `/api/servers/${server.uid}/backups`;
  const { data, error, refresh } = useResource<{
    busy: boolean;
    lastOperation?: { action: string; message: string; at: string } | null;
    backups: {
      uid: string;
      name: string;
      state: string;
      createdAt: string;
      sizeBytes: number;
      error?: string;
    }[];
  }>(url);
  const action = useAction(refresh),
    [name, setName] = useState('');
  const busy = action.pending || data?.busy || server.busy;
  const lastFailure = !busy && data?.lastOperation?.action.endsWith('.failed') ? data.lastOperation.message : '';
  const canRestore = ['server.power', 'server.files', 'server.settings'].every((p) =>
    permitted(server, p),
  );
  return (
    <ToolPanel
      title="Backups & restore"
      description="A complete copy of your server files and saved panel configuration. Running servers briefly stop for a consistent backup, then resume."
      error={action.error || error || lastFailure}
    >
      <form
        className="tool-form-inline"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(
            () => api(url, { method: 'POST', body: JSON.stringify({ name }) }),
            'Backup started. Progress appears below.',
          );
        }}
      >
        <label>
          Backup name
          <input
            value={name}
            maxLength={64}
            placeholder="Before adding new mods"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button className="btn" disabled={busy || !permitted(server, 'server.power')}>
          Back up now
        </button>
      </form>
      <Notice message={busy ? action.message || 'A server operation is in progress…' : lastFailure ? '' : data?.lastOperation?.message || action.message} />
      <div className="tool-list">
        {data?.backups.map((backup) => (
          <article className="tool-list-item" key={backup.uid}>
            <div>
              <strong>{backup.name}</strong>
              <p>
                {date(backup.createdAt)} · {formatBytes(backup.sizeBytes)} ·{' '}
                {displayName(backup.state)}
              </p>
              {backup.error && <p className="error">{backup.error}</p>}
            </div>
            <div className="row">
              {backup.state === 'completed' && (
                <>
                  <a className="btn secondary" href={`${apiBase()}${url}/${backup.uid}/download`}>
                    Download
                  </a>
                  <ConfirmButton
                    title="Restore this backup?"
                    description="The current server will be backed up first, then replaced with this snapshot. It will stay offline so you can review it before starting."
                    disabled={busy || !canRestore}
                    onConfirm={() =>
                      void action.run(
                        () => api(`${url}/${backup.uid}/restore`, { method: 'POST', body: '{}' }),
                        'Restore started. Progress appears here.',
                      )
                    }
                  >
                    Restore
                  </ConfirmButton>
                </>
              )}
              <ConfirmButton
                title="Delete backup?"
                description={`Permanently delete “${backup.name}”. Your running server files are unaffected.`}
                danger
                disabled={busy || ['running', 'pending'].includes(backup.state)}
                onConfirm={() =>
                  void action.run(
                    () => api(`${url}/${backup.uid}`, { method: 'DELETE' }),
                    'Backup deleted.',
                  )
                }
              >
                Delete
              </ConfirmButton>
            </div>
          </article>
        ))}
      </div>
      {data && !data.backups.length && (
        <div className="tool-empty">
          <Icon name="shield" size={28} />
          <h3>Your first recovery point</h3>
          <p>Create a backup before changing mods, updating, or importing a world.</p>
        </div>
      )}
      {!data && !error && <p>Loading backups…</p>}
    </ToolPanel>
  );
}

type FileEntry = { name: string; directory: boolean; size: number; modified: string };
function Files({ server }: { server: Server }) {
  const url = `/api/servers/${server.uid}/files`,
    [folder, setFolder] = useState('/'),
    [search, setSearch] = useState('');
  const { data, error, refresh } = useResource<{ path: string; entries: FileEntry[] }>(
    `${url}?path=${encodeURIComponent(folder)}`,
    0,
  );
  const action = useAction(refresh),
    input = useRef<HTMLInputElement>(null);
  const [editor, setEditor] = useState<{
    path: string;
    content: string;
    original: string;
    revision: string;
  } | null>(null);
  const [operation, setOperation] = useState<{
    type: 'folder' | 'rename' | 'extract';
    path?: string;
    value: string;
  } | null>(null);
  const editable = ['offline', 'crashed'].includes(server.state) && !server.busy && !action.pending;
  const child = (name: string) => `${folder === '/' ? '' : folder}/${name}`;
  const navigate = (next: string) => {
    setFolder(next);
    setSearch('');
  };
  async function openFile(name: string) {
    const file = child(name);
    await action.run(async () => {
      const result = await api<{ content: string; revision: string }>(
        `${url}/content?path=${encodeURIComponent(file)}`,
      );
      setEditor({ path: file, ...result, original: result.content });
    }, '');
  }
  if (editor)
    return (
      <ToolPanel
        title={editor.path.split('/').at(-1) || 'File editor'}
        description="Panel-managed settings are reapplied on startup. Use Configuration for those values; edit mod and plugin settings here."
        error={action.error}
      >
        <div className="tool-editor-header">
          <code>{editor.path}</code>
          {editor.content !== editor.original ? (
            <ConfirmButton
              title="Discard file edits?"
              description="Leave the editor without saving your changes."
              onConfirm={() => setEditor(null)}
            >
              Back to files
            </ConfirmButton>
          ) : (
            <button className="btn secondary" onClick={() => setEditor(null)}>
              Back to files
            </button>
          )}
        </div>
        <textarea
          className="file-editor"
          aria-label="File contents"
          spellCheck={false}
          value={editor.content}
          readOnly={!editable}
          onChange={(e) => setEditor({ ...editor, content: e.target.value })}
        />
        <div className="form-footer">
          <span>
            {editable
              ? 'Changes are written atomically. Concurrent changes are detected before saving.'
              : 'Stop the server to edit files.'}
          </span>
          <button
            className="btn"
            disabled={!editable || editor.content === editor.original}
            onClick={() =>
              void action.run(async () => {
                const result = await api<{ revision: string }>(`${url}/content`, {
                  method: 'PUT',
                  body: JSON.stringify({
                    path: editor.path,
                    content: editor.content,
                    revision: editor.revision,
                  }),
                });
                setEditor({ ...editor, original: editor.content, revision: result.revision });
              }, 'File saved.')
            }
          >
            Save file
          </button>
        </div>
        <Notice message={action.message} />
      </ToolPanel>
    );
  return (
    <ToolPanel
      title="Files"
      description="Browse and download server files. Stop the server before uploading, extracting, renaming, or editing."
      error={action.error || error}
    >
      <div className="tool-toolbar">
        <div className="row">
          <button
            className="btn secondary"
            disabled={folder === '/'}
            onClick={() => navigate(folder.slice(0, folder.lastIndexOf('/')) || '/')}
          >
            Up a folder
          </button>
          <code className="file-path">{folder}</code>
        </div>
        <div className="row">
          <button className="btn secondary" onClick={() => void refresh()}>
            Refresh
          </button>
          <button
            className="btn secondary"
            disabled={!editable}
            onClick={() => setOperation({ type: 'folder', value: '' })}
          >
            New folder
          </button>
          <button className="btn" disabled={!editable} onClick={() => input.current?.click()}>
            Upload file
          </button>
          <input
            ref={input}
            type="file"
            className="sr-only"
            aria-label="Upload server file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const form = new FormData();
              form.append('file', file);
              void action.run(
                () =>
                  api(`${url}/upload?path=${encodeURIComponent(folder)}`, {
                    method: 'POST',
                    body: form,
                  }),
                'File uploaded.',
              );
              e.target.value = '';
            }}
          />
        </div>
      </div>
      {operation && (
        <form
          className="tool-form-inline"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await api(`${url}/${operation.type}`, {
                method: 'POST',
                body: JSON.stringify(
                  operation.type === 'folder'
                    ? { path: child(operation.value) }
                    : operation.type === 'rename'
                      ? { from: operation.path, to: child(operation.value) }
                      : { path: operation.path, destination: child(operation.value) },
                ),
              });
              setOperation(null);
            }, 'Files updated.');
          }}
        >
          <label>
            {operation.type === 'extract'
              ? 'New extraction folder'
              : operation.type === 'rename'
                ? 'New name'
                : 'Folder name'}
            <input
              autoFocus
              required
              pattern="[^/\\\\]+"
              value={operation.value}
              onChange={(e) => setOperation({ ...operation, value: e.target.value })}
            />
          </label>
          <button className="btn" disabled={!editable}>
            Apply
          </button>
          <button type="button" className="btn secondary" onClick={() => setOperation(null)}>
            Cancel
          </button>
        </form>
      )}
      <Notice message={action.message} />
      <input
        className="tool-search"
        aria-label="Filter files"
        placeholder="Filter this folder…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="tool-list">
        {data?.entries
          .filter((f) => f.name.toLowerCase().includes(search.toLowerCase()))
          .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
          .map((file) => (
            <article className="tool-list-item file-row" key={file.name}>
              <button
                className="file-name"
                onClick={() =>
                  file.directory ? navigate(child(file.name)) : void openFile(file.name)
                }
              >
                <Icon name={file.directory ? 'cube' : 'book'} size={18} />
                <span>{file.name}</span>
              </button>
              <span className="file-meta">
                {file.directory ? 'Folder' : formatBytes(file.size)}
              </span>
              <div className="row">
                {!file.directory && (
                  <a
                    className="text-button"
                    href={`${apiBase()}${url}/download?path=${encodeURIComponent(child(file.name))}`}
                  >
                    Download
                  </a>
                )}
                <button
                  className="text-button"
                  disabled={!editable}
                  onClick={() =>
                    setOperation({ type: 'rename', path: child(file.name), value: file.name })
                  }
                >
                  Rename
                </button>
                {file.name.toLowerCase().endsWith('.zip') && (
                  <button
                    className="text-button"
                    disabled={!editable}
                    onClick={() =>
                      setOperation({
                        type: 'extract',
                        path: child(file.name),
                        value: file.name.slice(0, -4),
                      })
                    }
                  >
                    Extract
                  </button>
                )}
              </div>
            </article>
          ))}
      </div>
      {data && !data.entries.length && <p className="tool-empty">This folder is empty.</p>}
    </ToolPanel>
  );
}

type UpdatePlan = {
  state: string;
  version: string;
  error?: string;
  preparedAt?: string;
  preserve: string[];
  changes?: { added: string[]; changed: string[]; removed: string[]; total: number };
};
function Updates({ server }: { server: Server }) {
  const url = `/api/servers/${server.uid}/updates`,
    { data, error, refresh } = useResource<{ busy: boolean; plan: UpdatePlan | null }>(url);
  const action = useAction(refresh),
    [version, setVersion] = useState('latest'),
    [packVersion, setPackVersion] = useState(''),
    [file, setFile] = useState<File | null>(null),
    [startAfter, setStartAfter] = useState(false);
  const zip = server.variantId === 'custom-modpack',
    busy = action.pending || data?.busy || server.busy;
  return (
    <ToolPanel
      title="Updates & rollback"
      description="Prepare an isolated installation, review the file changes, then apply it with a recovery backup. Current worlds and configuration are preserved at apply time."
      error={action.error || error || data?.plan?.error}
    >
      <div className="tool-callout">
        <strong>
          Installed: {server.version} · {displayName(server.variantId)}
        </strong>
        <p>
          The server keeps running during preparation. Applying stops it; Backups contains the
          previous version for rollback.
        </p>
      </div>
      <form
        className="tool-form-inline"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            if (zip) {
              if (!file) throw new Error('Choose a server pack ZIP.');
              const form = new FormData();
              form.append('pack', file);
              await api(`${url}/prepare`, { method: 'POST', body: form });
            } else
              await api(`${url}/prepare`, {
                method: 'POST',
                body: JSON.stringify({
                  version,
                  ...(server.variantId === 'modrinth-modpack' ? { packVersion } : {}),
                }),
              });
          }, 'Update preparation requested. Progress appears below.');
        }}
      >
        {zip ? (
          <label>
            New server pack ZIP
            <input
              type="file"
              accept=".zip"
              required
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
        ) : (
          <>
            <label>
              Target game version
              <input
                required
                value={version}
                maxLength={64}
                onChange={(e) => setVersion(e.target.value)}
              />
            </label>
            {server.variantId === 'modrinth-modpack' && (
              <label>
                Modrinth pack version
                <input
                  value={packVersion}
                  placeholder="Latest compatible pack"
                  onChange={(e) => setPackVersion(e.target.value)}
                />
              </label>
            )}
          </>
        )}
        <button className="btn" disabled={busy}>
          {busy ? 'Operation in progress…' : 'Prepare update'}
        </button>
      </form>
      <Notice message={action.message} />
      {data?.plan && (
        <>
          <div className="tool-toolbar">
            <div>
              <h3>
                {displayName(data.plan.state)} · {data.plan.version}
              </h3>
              <p className="muted">{date(data.plan.preparedAt)}</p>
            </div>
            {data.plan.state === 'ready' && (
              <div className="row">
                <label className="setting-checkbox">
                  <input
                    type="checkbox"
                    checked={startAfter}
                    onChange={(e) => setStartAfter(e.target.checked)}
                  />
                  Start after update
                </label>
                <ConfirmButton
                  title="Apply this update?"
                  description="A full backup is created first. The server stops while its installation is replaced, and your latest world data is copied into the new version."
                  disabled={
                    busy ||
                    !['server.backups', 'server.power', 'server.settings'].every((p) =>
                      permitted(server, p),
                    )
                  }
                  onConfirm={() =>
                    void action.run(
                      () =>
                        api(`${url}/apply`, {
                          method: 'POST',
                          body: JSON.stringify({ startAfter }),
                        }),
                      'Update started. Check the activity timeline for the result.',
                    )
                  }
                >
                  Back up & apply
                </ConfirmButton>
              </div>
            )}
          </div>
          {data.plan.changes && (
            <>
              <p>
                {data.plan.changes.total} installation-file changes. Showing up to 200 paths per
                category.
              </p>
              <div className="update-diff">
                {(['added', 'changed', 'removed'] as const).map((kind) => (
                  <details key={kind} open>
                    <summary>
                      {displayName(kind)} ({data.plan!.changes![kind].length})
                    </summary>
                    <ul>
                      {data.plan!.changes![kind].map((file) => (
                        <li key={file}>
                          <code>{file}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
              </div>
            </>
          )}
          <details>
            <summary>Preserved worlds and configuration</summary>
            <ul>
              {data.plan.preserve.map((file) => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </ToolPanel>
  );
}

type Sample = {
  at: string;
  cpuPercent: number;
  memoryBytes: number;
  tps: number | null;
  mspt: number | null;
};
type DiagnosticsData = {
  autoRestart: boolean;
  crashCount: number;
  observations: { ticks: { tps: number | null; mspt: number | null; at: number } | null };
  history: Sample[];
  timeline: { id: string; action: string; message: string; at: string }[];
};
function HistoryChart({
  title,
  values,
  format,
}: {
  title: string;
  values: { at: string; value: number | null }[];
  format: (value: number) => string;
}) {
  const valid = values.filter((v): v is { at: string; value: number } => v.value !== null);
  const max = Math.max(...valid.map((v) => v.value), 1),
    first = new Date(values[0]?.at ?? 0).getTime(),
    duration = Math.max(1, new Date(values.at(-1)?.at ?? 0).getTime() - first);
  const points = valid
    .map(
      (v) =>
        `${((new Date(v.at).getTime() - first) / duration) * 500},${90 - (v.value / max) * 78}`,
    )
    .join(' ');
  return (
    <div className="history-chart">
      <div className="row">
        <h3>{title}</h3>
        <strong>{valid.length ? format(valid.at(-1)!.value) : 'No readings yet'}</strong>
      </div>
      {valid.length > 1 ? (
        <svg
          viewBox="0 0 500 100"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${title}. Latest ${format(valid.at(-1)!.value)}. Peak ${format(max)}.`}
        >
          <path d="M0 90H500 M0 50H500 M0 12H500" stroke="var(--stroke)" fill="none" />
          <polyline points={points} stroke="var(--ok)" strokeWidth="2" fill="none" />
        </svg>
      ) : (
        <p className="muted">History appears after two samples.</p>
      )}
      <div className="chart-range">
        <span>{date(values[0]?.at)}</span>
        <span>{date(values.at(-1)?.at)}</span>
      </div>
    </div>
  );
}
function Diagnostics({ server }: { server: Server }) {
  const [hours, setHours] = useState(1),
    url = `/api/servers/${server.uid}`;
  const { data, error, refresh } = useResource<DiagnosticsData>(
      `${url}/diagnostics?hours=${hours}`,
    ),
    action = useAction(refresh);
  return (
    <ToolPanel
      title="Performance & recovery"
      description="Resource history is sampled every 30 seconds and retained for 7 days. CPU is shown in core equivalents; 1 core equals 100% combined CPU."
      error={action.error || error}
    >
      <div className="tool-toolbar">
        <label>
          History
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            <option value={1}>Last hour</option>
            <option value={24}>Last 24 hours</option>
            <option value={168}>Last 7 days</option>
          </select>
        </label>
        <label className="setting-checkbox">
          <input
            type="checkbox"
            checked={data?.autoRestart ?? false}
            disabled={!data || action.pending || !permitted(server, 'server.settings')}
            onChange={(e) =>
              void action.run(
                () =>
                  api(`${url}/recovery`, {
                    method: 'PATCH',
                    body: JSON.stringify({ autoRestart: e.target.checked }),
                  }),
                'Recovery preference saved.',
              )
            }
          />
          Restart after crashes
        </label>
      </div>
      <p className="field-hint">
        Up to 3 recovery attempts with increasing delays. A stable 10-minute run resets the counter.
        Manual stops stay stopped.
      </p>
      <Notice message={action.message} />
      {data && (
        <div className="history-grid">
          <HistoryChart
            title="CPU cores used"
            values={data.history.map((s) => ({ at: s.at, value: s.cpuPercent / 100 }))}
            format={(v) => `${v.toFixed(2)} cores`}
          />
          <HistoryChart
            title="Memory"
            values={data.history.map((s) => ({ at: s.at, value: s.memoryBytes }))}
            format={formatBytes}
          />
        </div>
      )}
      {server.gameId === 'minecraft-java' && (
        <div className="tool-callout">
          <div className="tool-toolbar">
            <div>
              <h3>Minecraft tick health</h3>
              <p>
                <strong>{data?.observations.ticks?.tps ?? '—'} TPS</strong> ·{' '}
                <strong>{data?.observations.ticks?.mspt ?? '—'} ms per tick</strong>
              </p>
              <p className="field-hint">
                20 TPS and tick times below 50 ms indicate the server is keeping up. Requires Spark
                for your loader. Readings expire after 2 minutes.
              </p>
            </div>
            <button
              className="btn secondary"
              disabled={
                action.pending || server.state !== 'running' || !permitted(server, 'server.console')
              }
              onClick={() =>
                void action.run(async () => {
                  const response = await api<{ output: string }>(`${url}/diagnostics/ticks`, {
                    method: 'POST',
                    body: '{}',
                  });
                  if (/unknown|not found/i.test(response.output))
                    throw new Error(
                      'Spark is not available. Install its matching mod or plugin, then try again.',
                    );
                }, 'Requested tick metrics. Check the console if no reading appears.')
              }
            >
              Collect tick metrics
            </button>
          </div>
        </div>
      )}
      <h3 className="tool-section-title">Activity & crash reports</h3>
      <div className="activity-list">
        {data?.timeline.map((item) => (
          <article key={item.id}>
            <span
              className={`status-dot ${item.action.includes('failed') || item.action.includes('crashed') ? 'activity-failed' : ''}`}
            />
            <div>
              <strong>{item.message}</strong>
              <p>
                {date(item.at)} · {displayName(item.action.replaceAll('.', ' '))}
              </p>
            </div>
          </article>
        ))}
        {data && !data.timeline.length && (
          <p className="muted">Server operations and crash explanations will appear here.</p>
        )}
      </div>
    </ToolPanel>
  );
}

type StoredSchedule = ScheduleInput & {
  uid: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  lastRunError: string | null;
};
function Schedules({ server }: { server: Server }) {
  const [customTiming, setCustomTiming] = useState(false);
  const url = `/api/servers/${server.uid}/schedules`,
    { data, error, refresh } = useResource<{ schedules: StoredSchedule[] }>(url),
    action = useAction(refresh);
  const empty = (): ScheduleInput => ({
    name: '',
    cron: '0 4 * * *',
    triggerType: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cooldownSeconds: 60,
    enabled: true,
    onlyWhenOnline: false,
    actions: [{ type: 'backup', retain: 7 }],
  });
  const [draft, setDraft] = useState<ScheduleInput | null>(null),
    [editing, setEditing] = useState<string | null>(null);
  const timing = scheduleTiming(draft?.cron || null);
  const frequency = customTiming ? 'custom' : timing.frequency;
  const changeAction = (index: number, next: ScheduleInput['actions'][number]) => {
    if (draft)
      setDraft({ ...draft, actions: draft.actions.map((a, i) => (i === index ? next : a)) });
  };
  const defaults: Record<string, ScheduleInput['actions'][number]> = {
    backup: { type: 'backup', retain: 7 },
    power: {
      type: 'power',
      action: 'restart',
      warningSeconds: server.gameId === 'minecraft-java' || server.gameId === 'palworld' ? 30 : 0,
    },
    command: { type: 'command', command: '' },
    update: { type: 'update', startAfter: false },
    webhook: { type: 'webhook', url: '', template: '{server}: {event}', format: 'discord' },
  };
  return (
    <ToolPanel
      title="Schedules & alerts"
      description="Automate backups and maintenance, or send Discord/webhook alerts when a server event occurs. Actions run in order, using the creator’s current permissions."
      error={action.error || error}
    >
      <div className="tool-toolbar">
        <p className="muted">Server events are observed while the panel is running.</p>
        <button
          className="btn"
          onClick={() => {
            setEditing(null);
            setCustomTiming(false);
            setDraft(empty());
          }}
        >
          New schedule
        </button>
      </div>
      <Notice message={action.message} />
      {draft && (
        <form
          className="schedule-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await api(editing ? `${url}/${editing}` : url, {
                method: editing ? 'PUT' : 'POST',
                body: JSON.stringify(draft),
              });
              setDraft(null);
            }, 'Schedule saved.');
          }}
        >
          <div className="settings-field-grid">
            <label>
              Name
              <input
                required
                maxLength={64}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label>
              When
              <select
                value={draft.triggerType ? 'event' : 'clock'}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    cron: e.target.value === 'clock' ? '0 4 * * *' : null,
                    triggerType: e.target.value === 'event' ? 'server.crashed' : null,
                    onlyWhenOnline: false,
                  })
                }
              >
                <option value="clock">On a schedule</option>
                <option value="event">On a server event</option>
              </select>
            </label>
            {draft.triggerType ? (
              <>
                <label>
                  Event
                  <select
                    value={draft.triggerType}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        triggerType: e.target.value as ScheduleInput['triggerType'],
                      })
                    }
                  >
                    <option value="server.crashed">Server crashes</option>
                    <option value="server.ready">Server reports ready</option>
                    <option value="server.stopped">Server stops</option>
                    <option value="player.join">Player joins</option>
                    <option value="player.leave">Player leaves</option>
                  </select>
                </label>
                <label>
                  Cooldown (seconds)
                  <input
                    type="number"
                    min={0}
                    max={86400}
                    value={draft.cooldownSeconds}
                    onChange={(e) =>
                      setDraft({ ...draft, cooldownSeconds: Number(e.target.value) })
                    }
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  Repeat
                  <select
                    value={frequency}
                    onChange={(event) => {
                      setCustomTiming(event.target.value === 'custom');
                      if (event.target.value !== 'custom')
                        setDraft({
                          ...draft,
                          cron: scheduleCron(event.target.value, timing.time, timing.weekday),
                        });
                    }}
                  >
                    <option value="daily">Every day</option>
                    <option value="weekly">Every week</option>
                    <option value="hourly">Every hour</option>
                    <option value="custom">Custom cron expression</option>
                  </select>
                </label>
                {frequency === 'custom' ? (
                  <label>
                    Five-field cron
                    <input
                      required
                      value={draft.cron ?? ''}
                      onChange={(event) => {
                        setCustomTiming(true);
                        setDraft({ ...draft, cron: event.target.value });
                      }}
                    />
                    <span className="field-hint">
                      Minute, hour, day, month, weekday. Example: 0 4 * * * runs daily at 04:00.
                    </span>
                  </label>
                ) : (
                  <>
                    {frequency !== 'hourly' && (
                      <label>
                        Run at
                        <input
                          type="time"
                          required
                          value={timing.time}
                          onChange={(event) => {
                            if (event.target.value)
                              setDraft({
                                ...draft,
                                cron: scheduleCron(frequency, event.target.value, timing.weekday),
                              });
                          }}
                        />
                      </label>
                    )}
                    {frequency === 'weekly' && (
                      <label>
                        Day
                        <select
                          value={timing.weekday}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              cron: scheduleCron(frequency, timing.time, event.target.value),
                            })
                          }
                        >
                          {[
                            'Sunday',
                            'Monday',
                            'Tuesday',
                            'Wednesday',
                            'Thursday',
                            'Friday',
                            'Saturday',
                          ].map((day, index) => (
                            <option key={day} value={index}>
                              {day}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </>
                )}
                <label>
                  Timezone
                  <input
                    required
                    value={draft.timezone}
                    onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                  />
                  <span className="field-hint">
                    Starts with your browser’s timezone. Use UTC for a fixed time all year.
                  </span>
                </label>
              </>
            )}
          </div>
          <h3>Actions</h3>
          {draft.actions.map((item, i) => (
            <div className="schedule-action" key={i}>
              <label>
                Action {i + 1}
                <select
                  value={item.type}
                  onChange={(e) => changeAction(i, defaults[e.target.value]!)}
                >
                  <option value="backup">Create backup</option>
                  <option value="power">Power action</option>
                  <option value="command">Console command</option>
                  <option value="update">Apply prepared update</option>
                  <option value="webhook">Discord / webhook alert</option>
                </select>
              </label>
              {item.type === 'backup' && (
                <label>
                  Keep latest
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={item.retain}
                    onChange={(e) => changeAction(i, { ...item, retain: Number(e.target.value) })}
                  />
                </label>
              )}
              {item.type === 'power' && (
                <>
                  <label>
                    Power action
                    <select
                      value={item.action}
                      onChange={(e) =>
                        changeAction(i, {
                          ...item,
                          action: e.target.value as 'start' | 'stop' | 'restart',
                        })
                      }
                    >
                      <option value="restart">Restart</option>
                      <option value="stop">Stop</option>
                      <option value="start">Start</option>
                    </select>
                  </label>
                  {item.action === 'restart' &&
                    ['minecraft-java', 'palworld'].includes(server.gameId) && (
                      <label>
                        Warn players (seconds)
                        <input
                          type="number"
                          min={0}
                          max={300}
                          value={item.warningSeconds}
                          onChange={(e) =>
                            changeAction(i, { ...item, warningSeconds: Number(e.target.value) })
                          }
                        />
                      </label>
                    )}
                </>
              )}
              {item.type === 'command' && (
                <label>
                  Command
                  <input
                    required
                    value={item.command}
                    onChange={(e) => changeAction(i, { ...item, command: e.target.value })}
                  />
                </label>
              )}
              {item.type === 'update' && (
                <label className="setting-checkbox">
                  <input
                    type="checkbox"
                    checked={item.startAfter}
                    onChange={(e) => changeAction(i, { ...item, startAfter: e.target.checked })}
                  />
                  Start after update
                </label>
              )}
              {item.type === 'webhook' && (
                <>
                  <label>
                    Webhook URL
                    <input
                      type="password"
                      autoComplete="off"
                      required
                      value={item.url}
                      onChange={(e) => changeAction(i, { ...item, url: e.target.value })}
                    />
                  </label>
                  <label>
                    Format
                    <select
                      value={item.format}
                      onChange={(e) =>
                        changeAction(i, { ...item, format: e.target.value as 'discord' | 'json' })
                      }
                    >
                      <option value="discord">Discord</option>
                      <option value="json">JSON webhook</option>
                    </select>
                  </label>
                  <label className="schedule-template">
                    Message
                    <input
                      required
                      value={item.template}
                      onChange={(e) => changeAction(i, { ...item, template: e.target.value })}
                    />
                    <span className="field-hint">
                      Available: {'{server} {player} {event} {task}'}
                    </span>
                  </label>
                </>
              )}
              <button
                className="text-button"
                type="button"
                disabled={draft.actions.length === 1}
                onClick={() =>
                  setDraft({ ...draft, actions: draft.actions.filter((_a, n) => n !== i) })
                }
              >
                Remove action
              </button>
            </div>
          ))}
          <button
            className="btn secondary"
            type="button"
            disabled={draft.actions.length >= 10}
            onClick={() =>
              setDraft({ ...draft, actions: [...draft.actions, { type: 'backup', retain: 7 }] })
            }
          >
            Add action
          </button>
          <div className="row">
            <label className="setting-checkbox">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              />
              Enabled
            </label>
            <label className="setting-checkbox">
              <input
                type="checkbox"
                checked={draft.onlyWhenOnline}
                onChange={(e) => setDraft({ ...draft, onlyWhenOnline: e.target.checked })}
              />
              Only when server is running
            </label>
          </div>
          <div className="form-footer">
            <span>Only backups made by this schedule are pruned by its retention rule.</span>
            <div className="row">
              <button className="btn secondary" type="button" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button className="btn" disabled={action.pending}>
                Save schedule
              </button>
            </div>
          </div>
        </form>
      )}
      <div className="tool-list">
        {data?.schedules.map((item) => (
          <article className="tool-list-item" key={item.uid}>
            <div>
              <strong>{item.name}</strong>
              <p>
                {item.enabled ? 'Enabled' : 'Paused'} ·{' '}
                {item.cron
                  ? `${scheduleDescription(item.cron)} · ${item.timezone}`
                  : displayName(item.triggerType ?? '')}
              </p>
              <p>
                Next: {date(item.nextRunAt)} · Last: {date(item.lastRunAt)}
                {item.lastRunAt
                  ? ` · ${item.lastRunOk === null ? 'Running' : item.lastRunOk ? 'Succeeded' : 'Failed'}`
                  : ''}
              </p>
              {item.lastRunError && (
                <p className={item.lastRunOk ? 'muted' : 'error'}>{item.lastRunError}</p>
              )}
            </div>
            <div className="row">
              <button
                className="btn secondary"
                onClick={() => {
                  setEditing(item.uid);
                  setCustomTiming(false);
                  setDraft(item);
                }}
              >
                Edit
              </button>
              <ConfirmButton
                title="Run schedule now?"
                description={`Run all actions in “${item.name}” now, including any power actions or webhook messages.`}
                disabled={action.pending || server.busy}
                onConfirm={() =>
                  void action.run(
                    () => api(`${url}/${item.uid}/run`, { method: 'POST', body: '{}' }),
                    'Schedule started.',
                  )
                }
              >
                Run now
              </ConfirmButton>
              <button
                className="btn secondary"
                disabled={action.pending}
                onClick={() =>
                  void action.run(
                    () =>
                      api(`${url}/${item.uid}`, {
                        method: 'PUT',
                        body: JSON.stringify({ ...item, enabled: !item.enabled }),
                      }),
                    item.enabled ? 'Schedule paused.' : 'Schedule enabled.',
                  )
                }
              >
                {item.enabled ? 'Pause' : 'Enable'}
              </button>
              <ConfirmButton
                title="Delete schedule?"
                description="Remove this schedule. Backups it already created will be kept."
                disabled={action.pending}
                onConfirm={() =>
                  void action.run(
                    () => api(`${url}/${item.uid}`, { method: 'DELETE' }),
                    'Schedule deleted.',
                  )
                }
                danger
              >
                Delete
              </ConfirmButton>
            </div>
          </article>
        ))}
      </div>
      {data && !data.schedules.length && !draft && (
        <div className="tool-empty">
          <h3>Make maintenance automatic</h3>
          <p>Start with a daily backup, a weekly restart, or a Discord crash alert.</p>
        </div>
      )}
    </ToolPanel>
  );
}

function Players({ server }: { server: Server }) {
  const url = `/api/servers/${server.uid}/players`,
    { data, error, refresh } = useResource<{
      supported: boolean;
      players: string[];
      since: number | null;
      commands: { command: string; summary: string }[];
    }>(url),
    action = useAction(refresh);
  const [player, setPlayer] = useState(''),
    [command, setCommand] = useState('whitelist-add');
  return (
    <ToolPanel
      title="Players"
      description="Players observed joining and leaving while monitoring is connected. This may omit players already online when the panel started."
      error={action.error || error}
    >
      {data?.supported ? (
        <>
          <p className="muted">Observing since {date(data.since)}</p>
          <div className="player-chips">
            {data.players.map((name) => (
              <button className="btn secondary" key={name} onClick={() => setPlayer(name)}>
                {name}
              </button>
            ))}
          </div>
          {!data.players.length && <p className="tool-empty">No players observed online.</p>}
        </>
      ) : (
        <p className="tool-callout">
          This game does not expose player join and leave events to the panel.
        </p>
      )}
      {server.gameId === 'minecraft-java' ? (
        <form
          className="tool-form-inline"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              const result = await api<{ output: string }>(`${url}/action`, {
                method: 'POST',
                body: JSON.stringify({ player, action: command }),
              });
              if (result.output) setPlayer('');
            }, 'Player command sent. Check the server console for the result.');
          }}
        >
          <label>
            Player username
            <input
              required
              pattern="[a-zA-Z0-9_]{1,16}"
              maxLength={16}
              value={player}
              onChange={(e) => setPlayer(e.target.value)}
            />
          </label>
          <label>
            Action
            <select value={command} onChange={(e) => setCommand(e.target.value)}>
              <option value="whitelist-add">Add to allowlist</option>
              <option value="whitelist-remove">Remove from allowlist</option>
              <option value="kick">Kick</option>
              <option value="ban">Ban</option>
              <option value="pardon">Unban</option>
              <option value="op">Make operator</option>
              <option value="deop">Remove operator</option>
            </select>
          </label>
          <button
            className="btn"
            disabled={
              action.pending || server.state !== 'running' || !permitted(server, 'server.console')
            }
          >
            Send command
          </button>
        </form>
      ) : (
        <>
          <h3>Game admin commands</h3>
          <p className="muted">
            Use the server console where supported, or the game’s admin console.
          </p>
          <div className="tool-list">
            {data?.commands.map((item) => (
              <article key={item.command} className="tool-list-item">
                <code>{item.command}</code>
                <p>{item.summary}</p>
              </article>
            ))}
          </div>
        </>
      )}
      <Notice message={action.message} />
    </ToolPanel>
  );
}
function Access({ server }: { server: Server }) {
  const url = `/api/servers/${server.uid}/access`,
    { data, error, refresh } = useResource<{
      available: string[];
      members: { username: string; displayName: string; permissions: string[] }[];
    }>(url),
    action = useAction(refresh);
  const [username, setUsername] = useState(''),
    [grants, setGrants] = useState<string[]>(['server.view']);
  return (
    <ToolPanel
      title="Shared access"
      description="Give an existing panel account access to this server. Grant only the controls that person needs; the owner keeps full access."
      error={action.error || error}
    >
      <form
        className="access-editor"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api(url, {
              method: 'PUT',
              body: JSON.stringify({ username, permissions: grants }),
            });
            setUsername('');
            setGrants(['server.view']);
          }, 'Server access saved.');
        }}
      >
        <label>
          Panel username
          <input
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            placeholder="Their existing account username"
          />
        </label>
        <fieldset className="permission-grid">
          <legend>Permissions</legend>
          {SERVER_PERMISSIONS.filter(
            (p) => p !== 'server.delete' && (data?.available.includes(p) ?? false),
          ).map((permission) => (
            <label className="setting-checkbox" key={permission}>
              <input
                type="checkbox"
                checked={grants.includes(permission)}
                disabled={permission === 'server.view'}
                onChange={(e) =>
                  setGrants(
                    e.target.checked
                      ? [...grants, permission]
                      : grants.filter((p) => p !== permission),
                  )
                }
              />
              {permissionLabels[permission] || permission}
            </label>
          ))}
        </fieldset>
        <p className="field-hint">
          Files, backups, console, and settings can expose sensitive server data. Shared access
          permission lets this person manage other memberships.
        </p>
        <button className="btn" disabled={action.pending}>
          Save access
        </button>
      </form>
      <Notice message={action.message} />
      <div className="tool-list">
        {data?.members.map((member) => (
          <article className="tool-list-item" key={member.username}>
            <div>
              <strong>
                {member.displayName} <span className="muted">@{member.username}</span>
              </strong>
              <p>
                {member.permissions
                  .map((p) => permissionLabels[p] || displayName(p.replace('server.', '')))
                  .join(' · ')}
              </p>
            </div>
            <div className="row">
              <button
                className="btn secondary"
                onClick={() => {
                  setUsername(member.username);
                  setGrants(member.permissions);
                }}
              >
                Edit
              </button>
              <ConfirmButton
                title="Remove server access?"
                description={`Remove ${member.username} from this server. Their panel account remains active.`}
                disabled={action.pending}
                onConfirm={() =>
                  void action.run(
                    () =>
                      api(`${url}/${encodeURIComponent(member.username)}`, { method: 'DELETE' }),
                    'Server access removed.',
                  )
                }
              >
                Remove access
              </ConfirmButton>
            </div>
          </article>
        ))}
      </div>
    </ToolPanel>
  );
}
export function ServerTools({ server, tool }: { server: Server; tool: ServerTool }) {
  const panels = {
    files: Files,
    backups: Backups,
    diagnostics: Diagnostics,
    updates: Updates,
    schedules: Schedules,
    players: Players,
    access: Access,
  };
  const Component = panels[tool];
  return <Component key={`${server.uid}-${tool}`} server={server} />;
}
