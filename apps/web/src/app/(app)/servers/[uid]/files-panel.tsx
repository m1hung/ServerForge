'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  Download,
  File as FileIcon,
  FilePenLine,
  FolderPlus,
  Folder,
  HardDriveDownload,
  Link2,
  Loader2,
  Package,
  Pencil,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { cn, formatBytes, timeAgo } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Skeleton,
  Textarea,
  useToast,
} from '@/components/ui';

/**
 * The file manager.
 *
 * Deliberately plain: a list, a breadcrumb, and a text editor. The jobs
 * people actually come here for are "drop a mod in", "fix one line in a
 * config", and "get my world off this box" — none of which need a tree view
 * or a syntax highlighter, and all of which need to be obvious.
 */

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: number;
  editable: boolean;
}

export function FilesPanel({ uid, permissions }: { uid: string; permissions: string[] }) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [path, setPath] = useState('/');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ path: string; contents: string } | null>(null);
  const [renaming, setRenaming] = useState<FileEntry | null>(null);
  const [renameTo, setRenameTo] = useState('');
  const [newFolder, setNewFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  const canWrite = permissions.includes('server.files');

  const listing = useQuery({
    queryKey: ['files', uid, path],
    queryFn: () =>
      api.get<{ path: string; entries: FileEntry[] }>(
        `/api/servers/${uid}/files?path=${encodeURIComponent(path)}`,
      ),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['files', uid] });
    setSelected(new Set());
  };

  const onError = (error: unknown) => {
    if (error instanceof ApiError) {
      toast.push({ tone: 'danger', message: error.body.message, hint: error.body.hint });
    }
  };

  const openFile = useMutation({
    mutationFn: (target: string) =>
      api.get<{ path: string; contents: string }>(
        `/api/servers/${uid}/files/contents?path=${encodeURIComponent(target)}`,
      ),
    onSuccess: (data) => setEditing({ path: data.path, contents: data.contents }),
    onError,
  });

  const saveFile = useMutation({
    mutationFn: (input: { path: string; content: string }) =>
      api.put(`/api/servers/${uid}/files/contents`, input),
    onSuccess: () => {
      toast.push({
        tone: 'ok',
        message: 'Saved',
        hint: 'Restart the server for config changes to take effect.',
      });
      setEditing(null);
      refresh();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (paths: string[]) => api.post(`/api/servers/${uid}/files/delete`, { paths }),
    onSuccess: (result: unknown) => {
      const deleted = (result as { deleted: number }).deleted;
      toast.push({ tone: 'ok', message: `Deleted ${deleted} item${deleted === 1 ? '' : 's'}.` });
      setConfirmDelete(false);
      refresh();
    },
    onError,
  });

  const rename = useMutation({
    mutationFn: (input: { from: string; to: string }) =>
      api.post(`/api/servers/${uid}/files/rename`, input),
    onSuccess: () => {
      setRenaming(null);
      refresh();
    },
    onError,
  });

  const createFolder = useMutation({
    mutationFn: (name: string) => api.post(`/api/servers/${uid}/files/folder`, { path, name }),
    onSuccess: () => {
      setNewFolder(false);
      setFolderName('');
      refresh();
    },
    onError,
  });

  const unpack = useMutation({
    mutationFn: (target: string) => api.post(`/api/servers/${uid}/files/unpack`, { path: target }),
    onSuccess: () => {
      toast.push({ tone: 'ok', message: 'Unpacked.' });
      refresh();
    },
    onError,
  });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      setUploadPercent(0);
      return api.upload(
        `/api/servers/${uid}/files/upload?path=${encodeURIComponent(path)}`,
        files,
        setUploadPercent,
      );
    },
    onSuccess: (result: unknown) => {
      const uploaded = (result as { uploaded: string[] }).uploaded;
      toast.push({
        tone: 'ok',
        message: `Uploaded ${uploaded.length} file${uploaded.length === 1 ? '' : 's'}.`,
        hint: uploaded.some((f) => f.endsWith('.zip'))
          ? 'Use "Unpack" on a .zip to extract it here.'
          : undefined,
      });
      refresh();
    },
    onError,
    onSettled: () => setUploadPercent(null),
  });

  const entries = listing.data?.entries ?? [];
  const segments = path.split('/').filter(Boolean);

  const toggle = (entryPath: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(entryPath)) next.delete(entryPath);
      else next.add(entryPath);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      {/* ── Breadcrumb + actions ───────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {/* A path is a path: mono, so segments align and long names truncate
            predictably rather than shifting the whole row. */}
        <nav
          className="flex min-w-0 flex-1 items-center gap-0.5 font-mono text-[12.5px]"
          aria-label="Breadcrumb"
        >
          <button
            type="button"
            onClick={() => {
              setPath('/');
              setSelected(new Set());
            }}
            className="rounded px-1.5 py-1 text-ink-muted hover:bg-surface-raised hover:text-ink"
          >
            server
          </button>
          {segments.map((segment, index) => {
            const target = '/' + segments.slice(0, index + 1).join('/');
            const isLast = index === segments.length - 1;
            return (
              <span key={target} className="flex min-w-0 items-center gap-1">
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-subtle" aria-hidden />
                <button
                  type="button"
                  onClick={() => {
                    setPath(target);
                    setSelected(new Set());
                  }}
                  aria-current={isLast ? 'page' : undefined}
                  className={cn(
                    'truncate rounded px-1.5 py-1 hover:bg-surface-raised',
                    isLast ? 'font-medium text-ink' : 'text-ink-muted hover:text-ink',
                  )}
                >
                  {segment}
                </button>
              </span>
            );
          })}
        </nav>

        {canWrite && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setNewFolder(true)}>
              <FolderPlus className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">New folder</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fileInput.current?.click()}
              loading={uploadPercent !== null}
              loadingText={`${Math.round(uploadPercent ?? 0)}%`}
            >
              <Upload className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">Upload</span>
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="sr-only"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) upload.mutate(files);
                e.target.value = '';
              }}
            />
          </div>
        )}
      </div>

      {/* ── Selection bar ──────────────────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/10 px-4 py-2.5">
          <p className="text-[13px] text-ink">
            {selected.size} item{selected.size === 1 ? '' : 's'} selected
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              Delete
            </Button>
          </div>
        </div>
      )}

      {/* ── Listing ────────────────────────────────────────────────────── */}
      <Card
        className={cn('overflow-hidden', dragging && 'border-accent bg-accent/5')}
        onDragOver={(e) => {
          if (!canWrite) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!canWrite) return;
          e.preventDefault();
          setDragging(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length > 0) upload.mutate(files);
        }}
      >
        {listing.isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={Folder}
            title="This folder is empty"
            description={
              canWrite
                ? 'Drag files here to upload them, or use the Upload button.'
                : 'Nothing here yet.'
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {path !== '/' && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setPath('/' + segments.slice(0, -1).join('/'));
                    setSelected(new Set());
                  }}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px] text-ink-muted hover:bg-surface-raised"
                >
                  <Folder className="h-4 w-4 shrink-0" aria-hidden />
                  ..
                </button>
              </li>
            )}

            {entries.map((entry) => (
              <li
                key={entry.path}
                className={cn(
                  'group flex items-center gap-3 px-4 py-2.5 hover:bg-surface-raised',
                  selected.has(entry.path) && 'bg-accent/10',
                )}
              >
                {canWrite && (
                  <input
                    type="checkbox"
                    checked={selected.has(entry.path)}
                    onChange={() => toggle(entry.path)}
                    aria-label={`Select ${entry.name}`}
                    className="h-4 w-4 shrink-0 accent-[hsl(var(--accent))]"
                  />
                )}

                <button
                  type="button"
                  disabled={!entry.isDirectory && !entry.editable}
                  onClick={() => {
                    if (entry.isDirectory) {
                      setPath(entry.path);
                      setSelected(new Set());
                    } else if (entry.editable) {
                      openFile.mutate(entry.path);
                    }
                  }}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
                >
                  {entry.isSymlink ? (
                    <Link2 className="h-4 w-4 shrink-0 text-ink-subtle" aria-hidden />
                  ) : entry.isDirectory ? (
                    <Folder className="h-4 w-4 shrink-0 text-accent" aria-hidden />
                  ) : entry.editable ? (
                    <FilePenLine className="h-4 w-4 shrink-0 text-ink-subtle" aria-hidden />
                  ) : (
                    <FileIcon className="h-4 w-4 shrink-0 text-ink-subtle" aria-hidden />
                  )}

                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12.5px] text-ink">
                      {entry.name}
                    </span>
                    <span className="block font-mono text-[11px] tabular-nums text-ink-subtle">
                      {entry.isDirectory ? 'Folder' : formatBytes(entry.size)}
                      {entry.modifiedAt > 0 && ` · ${timeAgo(entry.modifiedAt)}`}
                    </span>
                  </span>
                </button>

                {entry.isSymlink && <Badge>Link</Badge>}

                {/* Row actions stay visible on touch, where hover does not exist. */}
                <div className="flex shrink-0 items-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                  {!entry.isDirectory && entry.name.toLowerCase().endsWith('.zip') && canWrite && (
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Unpack here"
                      aria-label={`Unpack ${entry.name}`}
                      loading={unpack.isPending && unpack.variables === entry.path}
                      onClick={() => unpack.mutate(entry.path)}
                    >
                      <Package className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {!entry.isDirectory && (
                    <a
                      href={api.url(
                        `/api/servers/${uid}/files/download?path=${encodeURIComponent(entry.path)}`,
                      )}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted hover:bg-line hover:text-ink"
                      title="Download"
                      aria-label={`Download ${entry.name}`}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  )}
                  {canWrite && (
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Rename"
                      aria-label={`Rename ${entry.name}`}
                      onClick={() => {
                        setRenaming(entry);
                        setRenameTo(entry.name);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canWrite && (
        <p className="text-[12px] text-ink-subtle">
          Tip: drop files anywhere on the list to upload them here. Uploaded .zip files can be
          unpacked in place.
        </p>
      )}

      {/* ── Editor ─────────────────────────────────────────────────────── */}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.path ?? ''}
        description="Changes take effect the next time the server starts."
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={saveFile.isPending}
              loadingText="Saving…"
              onClick={() =>
                editing && saveFile.mutate({ path: editing.path, content: editing.contents })
              }
            >
              Save file
            </Button>
          </>
        }
      >
        {editing && (
          <Textarea
            value={editing.contents}
            onChange={(e) => setEditing({ ...editing, contents: e.target.value })}
            spellCheck={false}
            className="min-h-[50vh] font-mono text-[12.5px] leading-relaxed"
            aria-label={`Contents of ${editing.path}`}
          />
        )}
      </Modal>

      {openFile.isPending && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[hsl(var(--canvas))]/70">
          <Loader2 className="h-5 w-5 animate-spin text-accent" />
          <span className="sr-only">Opening file</span>
        </div>
      )}

      {/* ── Rename ─────────────────────────────────────────────────────── */}
      <Modal
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={rename.isPending}
              disabled={renameTo.trim() === '' || renameTo === renaming?.name}
              onClick={() => {
                if (!renaming) return;
                const parent = path === '/' ? '' : path;
                rename.mutate({ from: renaming.path, to: `${parent}/${renameTo.trim()}` });
              }}
            >
              Rename
            </Button>
          </>
        }
      >
        <Field label="New name" help="Slashes and control characters are not allowed.">
          <Input value={renameTo} onChange={(e) => setRenameTo(e.target.value)} data-autofocus />
        </Field>
      </Modal>

      {/* ── New folder ─────────────────────────────────────────────────── */}
      <Modal
        open={newFolder}
        onClose={() => setNewFolder(false)}
        title="New folder"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewFolder(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={createFolder.isPending}
              disabled={folderName.trim() === ''}
              onClick={() => createFolder.mutate(folderName.trim())}
            >
              Create
            </Button>
          </>
        }
      >
        <Field label="Folder name" help={`It will be created in ${path}`}>
          <Input value={folderName} onChange={(e) => setFolderName(e.target.value)} data-autofocus />
        </Field>
      </Modal>

      {/* ── Delete confirmation ────────────────────────────────────────── */}
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${selected.size} item${selected.size === 1 ? '' : 's'}?`}
        description="Folders are deleted along with everything inside them."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => remove.mutate([...selected])}
            >
              Delete
            </Button>
          </>
        }
      >
        <ul className="space-y-1 text-[12.5px] text-ink-muted">
          {[...selected].slice(0, 10).map((p) => (
            <li key={p} className="truncate font-mono">
              {p}
            </li>
          ))}
          {selected.size > 10 && <li>…and {selected.size - 10} more</li>}
        </ul>
      </Modal>

      {/* ── Upload progress ────────────────────────────────────────────── */}
      {uploadPercent !== null && (
        <div className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom,0px))] left-1/2 z-40 w-[min(18rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border border-line bg-surface-raised p-3 shadow-xl md:bottom-4">
          <div className="mb-2 flex items-center justify-between text-[12.5px]">
            <span className="flex items-center gap-2 text-ink">
              <HardDriveDownload className="h-3.5 w-3.5" aria-hidden />
              Uploading
            </span>
            <span className="font-mono text-ink-muted">{Math.round(uploadPercent)}%</span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-sm bg-line"
            role="progressbar"
            aria-valuenow={Math.round(uploadPercent)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${uploadPercent}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export { X };
