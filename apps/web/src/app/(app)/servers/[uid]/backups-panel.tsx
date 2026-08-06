'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Download, History, Loader2, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { formatBytes, timeAgo } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Skeleton,
  useToast,
} from '@/components/ui';
import type { ServerState } from '@/components/server-status';

/**
 * Backups.
 *
 * Two things this screen has to get right: making it obvious that a restore
 * replaces the current world, and never letting a half-finished backup look
 * like a safe one to restore from.
 */

type BackupState = 'pending' | 'running' | 'completed' | 'failed' | 'deleting';

interface Backup {
  uid: string;
  name: string;
  state: BackupState;
  sizeBytes: number;
  checksum: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  scheduleId: string | null;
}

const STATE_LABELS: Record<BackupState, { label: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' }> = {
  pending: { label: 'Queued', tone: 'warn' },
  running: { label: 'Running', tone: 'warn' },
  completed: { label: 'Ready', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  deleting: { label: 'Deleting', tone: 'neutral' },
};

export function BackupsPanel({
  uid,
  state,
  permissions,
}: {
  uid: string;
  state: ServerState;
  permissions: string[];
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const [deleting, setDeleting] = useState<Backup | null>(null);

  const canManage = permissions.includes('server.backups');

  const backups = useQuery({
    queryKey: ['backups', uid],
    queryFn: () => api.get<{ backups: Backup[] }>(`/api/servers/${uid}/backups`),
    // Backups run in a worker with no websocket channel of their own, so the
    // list polls only while something is actually in flight.
    refetchInterval: (query) => {
      const list = query.state.data?.backups ?? [];
      return list.some((b) => b.state === 'pending' || b.state === 'running') ? 3000 : false;
    },
  });

  const onError = (error: unknown) => {
    if (error instanceof ApiError) {
      toast.push({ tone: 'danger', message: error.body.message, hint: error.body.hint });
    }
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['backups', uid] });

  const create = useMutation({
    mutationFn: () =>
      api.post(`/api/servers/${uid}/backups`, { name: name.trim() || undefined, ignore: [] }),
    onSuccess: (result: unknown) => {
      toast.push({
        tone: 'ok',
        message: (result as { message: string }).message,
      });
      setCreating(false);
      setName('');
      refresh();
    },
    onError,
  });

  const restore = useMutation({
    mutationFn: (backupUid: string) =>
      api.post(`/api/servers/${uid}/backups/${backupUid}/restore`),
    onSuccess: (result: unknown) => {
      toast.push({ tone: 'ok', message: (result as { message: string }).message });
      setRestoring(null);
      queryClient.invalidateQueries({ queryKey: ['server', uid] });
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (backupUid: string) => api.delete(`/api/servers/${uid}/backups/${backupUid}`),
    onSuccess: () => {
      toast.push({ tone: 'ok', message: 'Backup deleted.' });
      setDeleting(null);
      refresh();
    },
    onError,
  });

  const list = backups.data?.backups ?? [];
  const inFlight = list.some((b) => b.state === 'pending' || b.state === 'running');
  const isLive = ['running', 'starting'].includes(state);

  if (backups.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[13px] text-ink-muted">
            {list.length === 0
              ? 'No backups yet.'
              : `${list.length} backup${list.length === 1 ? '' : 's'}.`}{' '}
            Archives are stored on this panel&apos;s host as plain{' '}
            <code className="text-ink">.tar.gz</code> files. Download is optional if you want a
            copy on the computer you&apos;re using.
          </p>
        </div>
        {canManage && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => setCreating(true)}
            disabled={inFlight}
            title={inFlight ? 'A backup is already running' : undefined}
          >
            <Plus className="h-4 w-4" aria-hidden />
            New backup
          </Button>
        )}
      </div>

      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={Archive}
            title="No backups yet"
            description="A backup captures the world, configuration and mods onto this host. It runs in the background, so players can keep playing while it works."
            action={
              canManage ? (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  Create your first backup
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {list.map((backup) => {
              const style = STATE_LABELS[backup.state];
              const busy = backup.state === 'pending' || backup.state === 'running';

              return (
                <li key={backup.uid} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-ink">
                        {backup.name}
                      </span>
                      <Badge tone={style.tone}>
                        {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                        {style.label}
                      </Badge>
                      {backup.scheduleId && <Badge>Scheduled</Badge>}
                    </div>
                    <p className="mt-0.5 text-[11.5px] text-ink-subtle">
                      {timeAgo(backup.createdAt)}
                      {backup.state === 'completed' && ` · ${formatBytes(backup.sizeBytes)}`}
                    </p>
                    {backup.error && (
                      <p className="mt-1 text-[12px] text-danger">{backup.error}</p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {backup.state === 'completed' && (
                      <>
                        <a
                          href={api.url(`/api/servers/${uid}/backups/${backup.uid}/download`)}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted hover:bg-line hover:text-ink"
                          title="Download"
                          aria-label={`Download ${backup.name}`}
                        >
                          <Download className="h-3.5 w-3.5" />
                        </a>
                        {canManage && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Restore"
                            aria-label={`Restore ${backup.name}`}
                            onClick={() => setRestoring(backup)}
                          >
                            <History className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </>
                    )}
                    {canManage && !busy && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Delete"
                        aria-label={`Delete ${backup.name}`}
                        onClick={() => setDeleting(backup)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* ── Create ─────────────────────────────────────────────────────── */}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New backup"
        description="Runs in the background — the server keeps running."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
              Start backup
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label="Name"
            help="Optional. Something like “before installing mods” is easier to find later than a date."
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Before installing mods"
              maxLength={64}
              data-autofocus
            />
          </Field>
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            Logs, caches and downloaded server binaries are skipped — they are rebuilt on install
            and would multiply the size for nothing.
          </p>
        </div>
      </Modal>

      {/* ── Restore ────────────────────────────────────────────────────── */}
      <Modal
        open={restoring !== null}
        onClose={() => setRestoring(null)}
        title={`Restore "${restoring?.name}"?`}
        description="This replaces the current files with the ones in the backup."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRestoring(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={restore.isPending}
              onClick={() => restoring && restore.mutate(restoring.uid)}
            >
              Restore
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="flex items-start gap-2.5 rounded-lg border border-warn/30 bg-warn/10 px-4 py-3">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
            <div className="text-[12.5px] leading-relaxed text-ink-muted">
              <p>
                The current world is kept until the restore succeeds, so a failed restore changes
                nothing. Once it succeeds, the current files are gone.
              </p>
              {isLive && (
                <p className="mt-1.5 font-medium text-ink">
                  The server will be stopped first — everyone playing is disconnected.
                </p>
              )}
              <p className="mt-1.5">
                It stays offline afterwards so you can check the world before letting people back
                in.
              </p>
            </div>
          </div>
          <p className="text-[12.5px] text-ink-subtle">
            Made {restoring && timeAgo(restoring.createdAt)}
            {restoring?.state === 'completed' && ` · ${formatBytes(restoring.sizeBytes)}`}
          </p>
        </div>
      </Modal>

      {/* ── Delete ─────────────────────────────────────────────────────── */}
      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete "${deleting?.name}"?`}
        description="The archive is removed from disk. This cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.uid)}
            >
              Delete backup
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Download it first if you might want it later — there is no way to get it back afterwards.
        </p>
      </Modal>
    </div>
  );
}
