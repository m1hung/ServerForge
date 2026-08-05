'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Blocks,
  Download,
  ExternalLink,
  Link2,
  Package,
  Search,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { formatBytes, timeAgo } from '@/lib/utils';
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
  Toggle,
  useToast,
} from '@/components/ui';
import type { ServerState } from '@/components/server-status';

/**
 * Mods and plugins.
 *
 * The list is built from what is actually in the mods folder, not from what
 * we remember installing — someone dropping a jar in through the file manager
 * has to show up here, or the list is a lie. Disabling renames the file to
 * `.disabled` rather than deleting it, so "turn it off and see" is a safe
 * thing to suggest to someone debugging a crash.
 */

interface InstalledMod {
  fileName: string;
  name: string;
  sizeBytes: number;
  enabled: boolean;
  source: string;
  versionName: string | null;
  installedAt: string | null;
}

interface ModsResponse {
  supported: boolean;
  directory: string | null;
  loader: string | null;
  sources: { modrinth: boolean; curseforge: boolean; upload: boolean };
  mods: InstalledMod[];
}

interface SearchHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  downloads: number;
  icon_url: string | null;
  categories: string[];
}

interface ModVersion {
  id: string;
  name: string;
  version_number: string;
  version_type: string;
  game_versions: string[];
  date_published: string;
}

const SOURCE_LABELS: Record<string, string> = {
  modrinth: 'Modrinth',
  curseforge: 'CurseForge',
  url: 'Link',
  upload: 'Uploaded',
};

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export function ModsPanel({
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

  const [browsing, setBrowsing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState('');
  const [removing, setRemoving] = useState<InstalledMod | null>(null);

  const canManage = permissions.includes('server.mods');
  const isLive = ['running', 'starting'].includes(state);

  const mods = useQuery({
    queryKey: ['mods', uid],
    queryFn: () => api.get<ModsResponse>(`/api/servers/${uid}/mods`),
  });

  const onError = (error: unknown) => {
    if (error instanceof ApiError) {
      toast.push({ tone: 'danger', message: error.body.message, hint: error.body.hint });
    }
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['mods', uid] });

  /** Every install path lands here, so the restart advice is written once. */
  const announceInstalled = (result: { message: string; needsRestart: boolean }) => {
    toast.push({
      tone: 'ok',
      message: result.message,
      hint: result.needsRestart ? 'Restart the server for it to take effect.' : undefined,
    });
    refresh();
  };

  const toggle = useMutation({
    mutationFn: (mod: InstalledMod) =>
      api.patch<{ needsRestart: boolean }>(
        `/api/servers/${uid}/mods/${encodeURIComponent(mod.fileName)}`,
        { enabled: !mod.enabled },
      ),
    onSuccess: (result, mod) => {
      toast.push({
        tone: 'ok',
        message: `${mod.name} ${mod.enabled ? 'disabled' : 'enabled'}.`,
        hint: result.needsRestart ? 'Restart the server for it to take effect.' : undefined,
      });
      refresh();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (mod: InstalledMod) =>
      api.delete<{ needsRestart: boolean }>(
        `/api/servers/${uid}/mods/${encodeURIComponent(mod.fileName)}`,
      ),
    onSuccess: (result) => {
      toast.push({
        tone: 'ok',
        message: 'Removed.',
        hint: result.needsRestart ? 'Restart the server for it to take effect.' : undefined,
      });
      setRemoving(null);
      refresh();
    },
    onError,
  });

  const installFromUrl = useMutation({
    mutationFn: () =>
      api.post<{ message: string; needsRestart: boolean }>(`/api/servers/${uid}/mods`, {
        source: 'url',
        url: url.trim(),
        kind: 'mod',
      }),
    onSuccess: (result) => {
      announceInstalled(result);
      setLinking(false);
      setUrl('');
    },
    onError,
  });

  if (mods.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  const data = mods.data;

  // A vanilla server has nowhere to put a mod. Saying so plainly beats showing
  // an empty list that looks like something failed to load.
  if (!data?.supported) {
    return (
      <Card>
        <EmptyState
          icon={Blocks}
          title="This server type does not take mods"
          description="Vanilla Minecraft and unmodded Palworld have no mod folder. Switch to Paper or Fabric when you deploy if you want plugins or mods."
        />
      </Card>
    );
  }

  const list = data.mods;
  const enabledCount = list.filter((m) => m.enabled).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-[13px] text-ink-muted">
          {list.length === 0
            ? 'Nothing installed yet.'
            : `${list.length} file${list.length === 1 ? '' : 's'} in ${data.directory}, ${enabledCount} on.`}{' '}
          {data.loader && (
            <>
              This server runs <span className="text-ink">{data.loader}</span> — only mods built for
              it will load.
            </>
          )}
        </p>
        {canManage && (
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" size="sm" onClick={() => setLinking(true)}>
              <Link2 className="h-4 w-4" aria-hidden />
              From a link
            </Button>
            {data.sources.modrinth && (
              <Button variant="primary" size="sm" onClick={() => setBrowsing(true)}>
                <Search className="h-4 w-4" aria-hidden />
                Browse mods
              </Button>
            )}
          </div>
        )}
      </div>

      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={Package}
            title="No mods installed"
            description={
              data.sources.modrinth
                ? 'Browse Modrinth to install something, paste a direct download link, or upload a jar in the Files tab. Anything already in the mods folder shows up here on its own.'
                : 'Upload a mod file in the Files tab and it will appear here.'
            }
            action={
              canManage && data.sources.modrinth ? (
                <Button variant="primary" onClick={() => setBrowsing(true)}>
                  Browse mods
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {list.map((mod) => (
              <li key={mod.fileName} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-ink">{mod.name}</span>
                    {!mod.enabled && <Badge tone="neutral">Off</Badge>}
                    <Badge>{SOURCE_LABELS[mod.source] ?? mod.source}</Badge>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11.5px] text-ink-subtle">
                    {mod.fileName}
                    {mod.versionName && ` · ${mod.versionName}`}
                    {mod.sizeBytes > 0 && ` · ${formatBytes(mod.sizeBytes)}`}
                    {mod.installedAt && ` · added ${timeAgo(mod.installedAt)}`}
                  </p>
                </div>

                {canManage && (
                  <div className="flex shrink-0 items-center gap-2">
                    <Toggle
                      checked={mod.enabled}
                      onChange={() => toggle.mutate(mod)}
                      label={`${mod.enabled ? 'Disable' : 'Enable'} ${mod.name}`}
                      disabled={toggle.isPending}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Remove"
                      aria-label={`Remove ${mod.name}`}
                      onClick={() => setRemoving(mod)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {isLive && list.length > 0 && (
        <p className="text-[12.5px] text-ink-subtle">
          Changes to mods only take effect when the server restarts.
        </p>
      )}

      {data.sources.upload && canManage && (
        <p className="text-[12.5px] text-ink-subtle">
          Got a jar from CurseForge or somewhere else? Upload it into{' '}
          <code className="text-ink-muted">{data.directory}</code> in the Files tab — it works
          exactly the same once it is there.
        </p>
      )}

      {/* ── Browse ─────────────────────────────────────────────────────── */}
      <BrowseModal
        uid={uid}
        open={browsing}
        onClose={() => setBrowsing(false)}
        onInstalled={(result) => {
          announceInstalled(result);
          setBrowsing(false);
        }}
        onError={onError}
      />

      {/* ── Install from a link ────────────────────────────────────────── */}
      <Modal
        open={linking}
        onClose={() => setLinking(false)}
        title="Install from a link"
        description="A direct https link to a .jar, .zip or .pak file."
        footer={
          <>
            <Button variant="ghost" onClick={() => setLinking(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={installFromUrl.isPending}
              disabled={!url.trim()}
              onClick={() => installFromUrl.mutate()}
            >
              Install
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label="Download link"
            help="Must be the file itself, not the page it sits on. Right-click the download button and copy the link."
          >
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/some-mod-1.2.3.jar"
              data-autofocus
            />
          </Field>
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            Nothing checks that this mod matches your server&apos;s version or loader — if it does
            not, the server will say so in the console when it next starts.
          </p>
        </div>
      </Modal>

      {/* ── Remove ─────────────────────────────────────────────────────── */}
      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove "${removing?.name}"?`}
        description="The file is deleted from the mods folder."
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
              Remove
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink-muted">
          If you only want to test whether this mod is causing a problem, turn it off instead — that
          keeps the file so you can turn it back on.
          {removing?.source === 'upload' &&
            ' This one was uploaded, so you would need the original file to put it back.'}
        </p>
      </Modal>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── browse ──

/**
 * Search, then pick a version.
 *
 * Two steps rather than one "install latest" button: the newest release of a
 * mod is regularly not the one that matches the server's Minecraft version,
 * and finding that out from a crash log is a bad afternoon.
 */
function BrowseModal({
  uid,
  open,
  onClose,
  onInstalled,
  onError,
}: {
  uid: string;
  open: boolean;
  onClose: () => void;
  onInstalled: (result: { message: string; needsRestart: boolean }) => void;
  onError: (error: unknown) => void;
}) {
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SearchHit | null>(null);
  const [versionId, setVersionId] = useState('');

  // Debounced so typing a mod name is not one request per keystroke against
  // a public API we do not own.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(term.trim()), 350);
    return () => clearTimeout(timer);
  }, [term]);

  useEffect(() => {
    if (!open) {
      setTerm('');
      setQuery('');
      setSelected(null);
      setVersionId('');
    }
  }, [open]);

  const results = useQuery({
    queryKey: ['mod-search', uid, query],
    queryFn: () =>
      api.get<{ hits: SearchHit[]; total: number }>(
        `/api/servers/${uid}/mods/search?q=${encodeURIComponent(query)}`,
      ),
    enabled: open && query.length >= 2,
  });

  const versions = useQuery({
    queryKey: ['mod-versions', uid, selected?.project_id],
    queryFn: () =>
      api.get<{ versions: ModVersion[] }>(
        `/api/servers/${uid}/mods/${encodeURIComponent(selected!.project_id)}/versions`,
      ),
    enabled: open && selected !== null,
  });

  const install = useMutation({
    mutationFn: () =>
      api.post<{ message: string; needsRestart: boolean }>(`/api/servers/${uid}/mods`, {
        source: 'modrinth',
        projectId: selected!.project_id,
        versionId: versionId || undefined,
        kind: 'mod',
      }),
    onSuccess: onInstalled,
    onError,
  });

  const versionList = versions.data?.versions ?? [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={selected ? selected.title : 'Browse mods'}
      description={
        selected
          ? 'Pick a version. The list only contains releases that match this server.'
          : 'Search Modrinth. Results are filtered to what works with this server.'
      }
      footer={
        selected ? (
          <>
            <Button variant="ghost" onClick={() => setSelected(null)}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back
            </Button>
            <Button
              variant="primary"
              loading={install.isPending}
              disabled={versionList.length === 0}
              onClick={() => install.mutate()}
            >
              Install
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      {selected ? (
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-ink-muted">{selected.description}</p>

          {versions.isLoading ? (
            <Skeleton className="h-9 w-full" />
          ) : versionList.length === 0 ? (
            <div className="rounded-lg border border-warn/30 bg-warn/10 px-4 py-3 text-[12.5px] leading-relaxed text-ink-muted">
              No version of this mod matches your Minecraft version and loader. Either the mod has
              not been updated yet, or it is built for a different loader.
            </div>
          ) : (
            <Field
              label="Version"
              help="Newest first. Release versions are safer than beta or alpha ones."
            >
              <Select value={versionId} onChange={(e) => setVersionId(e.target.value)}>
                {versionList.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.version_number}
                    {version.version_type !== 'release' ? ` (${version.version_type})` : ''} ·{' '}
                    {version.game_versions.join(', ')}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <a
            href={`https://modrinth.com/mod/${selected.slug}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-muted hover:text-accent"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            Read about this mod on Modrinth
          </a>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="Search">
            <Input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Sodium, WorldEdit, Create…"
              data-autofocus
            />
          </Field>

          {query.length >= 2 && results.isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          )}

          {results.data && results.data.hits.length === 0 && (
            <p className="py-6 text-center text-[13px] text-ink-muted">
              Nothing matched “{query}” for this server&apos;s version and loader.
            </p>
          )}

          <ul className="max-h-80 divide-y divide-line overflow-y-auto scrollbar-thin">
            {(results.data?.hits ?? []).map((hit) => (
              <li key={hit.project_id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(hit);
                    setVersionId('');
                  }}
                  className="flex w-full items-start gap-3 px-1 py-3 text-left hover:bg-surface-raised/60"
                >
                  {/* Modrinth icons are arbitrary remote images, so this stays a
                      plain img rather than next/image — no loader config, and a
                      broken icon must not break the row. */}
                  {hit.icon_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={hit.icon_url}
                      alt=""
                      className="h-9 w-9 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <div className="inset-well flex h-9 w-9 shrink-0 items-center justify-center rounded-md">
                      <Package className="h-4 w-4 text-ink-subtle" aria-hidden />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-ink">{hit.title}</span>
                      <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-ink-subtle">
                        <Download className="h-3 w-3" aria-hidden />
                        {compactNumber(hit.downloads)}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-ink-muted">
                      {hit.description}
                    </p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
