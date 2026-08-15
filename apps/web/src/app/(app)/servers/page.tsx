"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Cpu,
  FileText,
  Gamepad2,
  Globe,
  HardDrive,
  House,
  MemoryStick,
  MoreVertical,
  Play,
  Rocket,
  RotateCw,
  Search,
  Server,
  Settings,
  Square,
  Terminal,
  TriangleAlert,
  Users,
  Wifi,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { api, ApiError, streamUrl } from "@/lib/api";
import { cn, copyToClipboard, formatMib } from "@/lib/utils";
import { useLongPress } from "@/lib/use-long-press";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Modal,
  Skeleton,
  useToast,
} from "@/components/ui";
import { StatusBadge, type ServerState } from "@/components/server-status";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/context-menu";

interface FleetServer {
  uid: string;
  name: string;
  description: string | null;
  state: ServerState;
  gameId: string;
  variantId: string;
  version: string;
  memoryMib: number;
  cpuCores: number;
  diskMib: number;
  address: string | null;
  lanAddress: string | null;
  players: number;
  isOwner: boolean;
  permissions: string[];
  node: { name: string; publicHost: string };
}

type FleetFilter = "all" | "online" | "attention" | "offline";

/**
 * The fleet.
 *
 * The dashboard is laid out to fit a single screen: a compact title row with
 * the key counts inline, one clean toolbar, and a dense grid of cards. The
 * shell (in the app layout) already pins the header and sidebar, so only the
 * grid below scrolls when there are more servers than fit.
 */
export default function ServersPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FleetFilter>("all");
  const [menu, setMenu] = useState<{
    server: FleetServer;
    x: number;
    y: number;
  } | null>(null);
  const [stopping, setStopping] = useState<FleetServer | null>(null);

  const servers = useQuery({
    queryKey: ["servers"],
    queryFn: () => api.get<{ servers: FleetServer[] }>("/api/servers"),
  });

  const power = useMutation({
    mutationFn: ({
      uid,
      action,
    }: {
      uid: string;
      action: "start" | "stop" | "restart";
    }) => api.post(`/api/servers/${uid}/power`, { action }),
    onError: (error) => {
      if (error instanceof ApiError) {
        toast.push({
          tone: "danger",
          message: error.body.message,
          hint: error.body.hint,
        });
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["servers"] }),
  });

  // A single fleet-wide socket keeps every card's status current without
  // polling — the alternative is N sockets or a 5-second refetch loop.
  useEffect(() => {
    const socket = new WebSocket(streamUrl("/api/stream"));
    socket.onmessage = () => {
      queryClient.invalidateQueries({ queryKey: ["servers"] });
    };
    return () => socket.close();
  }, [queryClient]);

  if (servers.isLoading) {
    return (
      <div className="flex h-full flex-col gap-4">
        <HeaderSkeleton />
        <ToolbarSkeleton />
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-32 w-full rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const list = servers.data?.servers ?? [];
  const onlineCount = list.filter(
    (server) => server.state === "running",
  ).length;
  const attentionCount = list.filter((server) =>
    ["crashed", "install_failed", "suspended"].includes(server.state),
  ).length;
  const playerCount = list.reduce(
    (total, server) =>
      total + (server.state === "running" ? server.players : 0),
    0,
  );
  const filtered = (() => {
    const term = search.trim().toLowerCase();
    return list.filter((server) => {
      const matchesSearch =
        term === "" ||
        server.name.toLowerCase().includes(term) ||
        server.gameId.toLowerCase().includes(term) ||
        server.node.name.toLowerCase().includes(term);
      const matchesFilter =
        filter === "all" ||
        (filter === "online" && server.state === "running") ||
        (filter === "attention" &&
          ["crashed", "install_failed", "suspended"].includes(server.state)) ||
        (filter === "offline" && server.state === "offline");
      return matchesSearch && matchesFilter;
    });
  })();

  return (
    <div className="flex h-full flex-col gap-4">
      <Header
        count={list.length}
        onlineCount={onlineCount}
        totalCount={list.length}
        playerCount={playerCount}
        attentionCount={attentionCount}
      />

      {list.length === 0 ? (
        <Card className="flex min-h-0 flex-1 items-center">
          <EmptyState
            icon={Rocket}
            title="No servers yet"
            description="Pick a game, give it a name, and we handle the rest — downloads, ports, configuration and startup. Most servers are ready to play in under five minutes."
            action={
              <Link href="/servers/new">
                <Button variant="primary" size="lg">
                  Create your first server
                </Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <Toolbar
            search={search}
            onSearch={setSearch}
            filter={filter}
            onFilter={setFilter}
          />

          {/* The grid owns the remaining height and scrolls on its own, so the
              header and toolbar stay pinned above it. */}
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin pr-0.5">
            {filtered.length > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {filtered.map((server) => (
                  <ServerCard
                    key={server.uid}
                    server={server}
                    onCopy={async (address, kind) => {
                      const ok = await copyToClipboard(address);
                      toast.push({
                        tone: ok ? "ok" : "danger",
                        message: ok
                          ? kind === "local"
                            ? "Local address copied"
                            : "Address copied"
                          : "Could not copy",
                        hint: ok
                          ? kind === "local"
                            ? "Use this on the same network."
                            : "Ready to share."
                          : undefined,
                      });
                    }}
                    onOpenMenu={(x, y) => {
                      setMenu({ server, x, y });
                    }}
                  />
                ))}
              </div>
            ) : (
              <Card>
                <EmptyState
                  icon={Search}
                  title="No matching servers"
                  description="Try another search or clear the current status filter."
                  action={
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setSearch("");
                        setFilter("all");
                      }}
                    >
                      Clear filters
                    </Button>
                  }
                />
              </Card>
            )}
          </div>
        </>
      )}

      <ServerContextMenu
        menu={menu}
        busy={power.isPending}
        onClose={() => setMenu(null)}
        onCopy={async (address, kind) => {
          const ok = await copyToClipboard(address);
          toast.push({
            tone: ok ? "ok" : "danger",
            message: ok
              ? kind === "local"
                ? "Local address copied"
                : "Address copied"
              : "Could not copy",
          });
        }}
        onStart={(server) => power.mutate({ uid: server.uid, action: "start" })}
        onRestart={(server) =>
          power.mutate({ uid: server.uid, action: "restart" })
        }
        onStop={(server) => setStopping(server)}
      />

      <Modal
        open={Boolean(stopping)}
        onClose={() => setStopping(null)}
        title={stopping ? `Stop ${stopping.name}?` : "Stop the server?"}
        description="Everyone playing will be disconnected."
        footer={
          <>
            <Button variant="ghost" onClick={() => setStopping(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!stopping) return;
                power.mutate({ uid: stopping.uid, action: "stop" });
                setStopping(null);
              }}
            >
              Stop server
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink-muted">
          The world is saved first, so nothing is lost.
        </p>
      </Modal>
    </div>
  );
}

/**
 * One tight title row. The three counts used to be big cards of their own; now
 * they are inline chips beside the heading, which buys back a whole row of
 * vertical space and keeps the dashboard on one screen.
 */
function Header({
  count,
  onlineCount,
  totalCount,
  playerCount,
  attentionCount,
}: {
  count: number;
  onlineCount: number;
  totalCount: number;
  playerCount: number;
  attentionCount: number;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="legend mb-2">Local node</p>
        <h1 className="engraved text-lg sm:text-xl">Your servers</h1>
        <p className="mt-1.5 truncate text-[12.5px] text-ink-muted">
          {count === 0
            ? "Deploy your first game server and start playing in minutes."
            : "Monitor availability, resources, and players from one place."}
        </p>
      </div>

      {/* Fleet totals, hairline-separated inside a single card. */}
      <div className="panel flex items-stretch divide-x divide-line overflow-hidden">
        <StatChip
          icon={Wifi}
          value={`${onlineCount}/${totalCount}`}
          label="online"
          tone="ok"
        />
        <StatChip
          icon={Users}
          value={String(playerCount)}
          label="players"
          tone="accent"
        />
        <StatChip
          icon={TriangleAlert}
          value={String(attentionCount)}
          label="attention"
          tone={attentionCount > 0 ? "danger" : "muted"}
        />
      </div>
    </div>
  );
}

function StatChip({
  icon: Icon,
  value,
  label,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  label: string;
  tone: "ok" | "accent" | "danger" | "muted";
}) {
  const tones = {
    ok: "text-ok",
    accent: "text-accent",
    danger: "text-danger",
    muted: "text-ink-subtle",
  };

  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5">
      <Icon className={cn("h-3.5 w-3.5 shrink-0", tones[tone])} aria-hidden />
      <div className="min-w-0">
        <span className="block font-mono text-[14px] font-semibold leading-tight tabular-nums text-ink">
          {value}
        </span>
        <span className="legend mt-1.5 block">{label}</span>
      </div>
    </div>
  );
}

function Toolbar({
  search,
  onSearch,
  filter,
  onFilter,
}: {
  search: string;
  onSearch: (next: string) => void;
  filter: FleetFilter;
  onFilter: (next: FleetFilter) => void;
}) {
  return (
    <div className="panel flex shrink-0 flex-col gap-2 p-2 sm:flex-row sm:items-center">
      <label className="relative min-w-0 flex-1">
        <span className="sr-only">Search servers</span>
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle"
          aria-hidden
        />
        <input
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search by server, game, or machine…"
          className="inset-well h-11 w-full border border-transparent pl-9 pr-3 font-mono text-[13px] text-ink outline-none transition-colors placeholder:font-sans placeholder:text-ink-subtle focus:border-accent/60 md:h-9 md:pl-8 md:text-[12.5px]"
        />
      </label>

      {/* A segmented filter: the selected one is the only filled segment. */}
      <div
        className="flex shrink-0 gap-0.5 overflow-x-auto rounded-md bg-surface-raised p-0.5 scrollbar-thin"
        aria-label="Filter servers"
      >
        {(["all", "online", "attention", "offline"] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            aria-pressed={filter === entry}
            onClick={() => onFilter(entry)}
            className={cn(
              "min-h-10 shrink-0 rounded-[5px] px-3 py-2 text-[12.5px] capitalize transition-colors md:min-h-0 md:px-2.5 md:py-1.5 md:text-[12px]",
              filter === entry
                ? "bg-surface font-medium text-ink shadow-sm"
                : "text-ink-subtle hover:text-ink",
            )}
          >
            {entry}
          </button>
        ))}
      </div>
    </div>
  );
}

function ServerCard({
  server,
  onCopy,
  onOpenMenu,
}: {
  server: FleetServer;
  onCopy: (address: string, kind: "internet" | "local") => void;
  onOpenMenu: (x: number, y: number) => void;
}) {
  const isLive = server.state === "running";
  const openAt = useCallback(
    (x: number, y: number) => onOpenMenu(x, y),
    [onOpenMenu],
  );
  const longPress = useLongPress(openAt);

  return (
    /*
     * One server, one card, read top to bottom: who it is, what it is doing
     * right now, what it is allowed to use, and how to reach it.
     */
    <Card
      className="group relative flex cursor-pointer flex-col px-4 py-4 transition-colors duration-150 hover:border-line-strong touch-manipulation"
      onContextMenu={(event: MouseEvent) => {
        event.preventDefault();
        onOpenMenu(event.clientX, event.clientY);
      }}
      onPointerDown={longPress.onPointerDown}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
    >
      <Link
        href={`/servers/${server.uid}`}
        className="absolute inset-0 z-[1] rounded-[inherit] focus-visible:ring-inset"
        aria-label={`Open ${server.name}`}
        onClick={(event) => {
          if (longPress.didFire()) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      />
      {/* Identity strip */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="inset-well flex h-9 w-9 shrink-0 items-center justify-center text-ink-subtle transition-colors group-hover:text-accent md:h-8 md:w-8">
            <Gamepad2 className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0">
            <h2 className="engraved truncate text-[14px] leading-tight md:text-[13.5px]">
              {server.name}
            </h2>
            <p className="datum mt-1 truncate text-ink-subtle">
              {server.variantId} · {server.version}
            </p>
          </div>
        </div>
        <div className="relative z-[2] flex shrink-0 items-start gap-1">
          <StatusBadge state={server.state} className="mt-0.5" />
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-raised hover:text-ink md:h-8 md:w-8"
            aria-label={`Actions for ${server.name}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              onOpenMenu(rect.right - 8, rect.bottom + 4);
            }}
          >
            <MoreVertical className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      {/* Live signal or node */}
      <div className="mt-3.5 flex items-center gap-1.5 text-[12px]">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 text-[12px]",
            isLive ? "text-ok" : "text-ink-subtle",
          )}
        >
          {isLive ? (
            <Users className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <Server className="h-3.5 w-3.5" aria-hidden />
          )}
          {isLive
            ? `${server.players} player${server.players === 1 ? "" : "s"} online`
            : server.node.name}
        </span>
        {!server.isOwner && (
          <Badge tone="info" className="ml-auto">
            Shared
          </Badge>
        )}
      </div>

      {/* Allocated resources */}
      <div className="mt-3.5 grid grid-cols-3 gap-2 border-t border-line pt-3">
        <Spec icon={MemoryStick} label="mem" value={formatMib(server.memoryMib)} />
        <Spec icon={Cpu} label="cpu" value={`${server.cpuCores}c`} />
        <Spec icon={HardDrive} label="disk" value={formatMib(server.diskMib)} />
      </div>

      {/* Footer: internet and local join addresses */}
      <div className="mt-3.5 flex min-w-0 flex-col gap-1.5">
        {server.address ? (
          <AddressChip
            icon={Globe}
            label="Internet"
            value={server.address}
            onCopy={() => onCopy(server.address!, "internet")}
          />
        ) : (
          <span className="inset-well min-w-0 truncate px-2 py-1.5 font-mono text-[11px] text-ink-subtle">
            no address assigned
          </span>
        )}
        {server.lanAddress && (
          <AddressChip
            icon={House}
            label="Local"
            value={server.lanAddress}
            onCopy={() => onCopy(server.lanAddress!, "local")}
          />
        )}
      </div>
    </Card>
  );
}

function AddressChip({
  icon: Icon,
  label,
  value,
  onCopy,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  onCopy: () => void;
}) {
  return (
    <div className="readout flex min-w-0 items-center gap-1.5 px-2 py-1.5">
      <Icon className="h-3.5 w-3.5 shrink-0 text-ink-subtle" aria-hidden />
      <code className="min-w-0 flex-1 truncate text-[11px]" title={`${label}: ${value}`}>
        {value}
      </code>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCopy();
        }}
        className="relative z-[2] flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-raised hover:text-accent md:h-7 md:w-7"
        aria-label={`Copy the ${label.toLowerCase()} address`}
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ServerContextMenu({
  menu,
  busy,
  onClose,
  onCopy,
  onStart,
  onRestart,
  onStop,
}: {
  menu: { server: FleetServer; x: number; y: number } | null;
  busy: boolean;
  onClose: () => void;
  onCopy: (address: string, kind: "internet" | "local") => void;
  onStart: (server: FleetServer) => void;
  onRestart: (server: FleetServer) => void;
  onStop: (server: FleetServer) => void;
}) {
  const server = menu?.server;
  const can = (permission: string) =>
    Boolean(server?.permissions?.includes(permission));
  const running = server?.state === "running";
  const starting = server?.state === "starting";
  const live = running || starting || server?.state === "stopping";
  const busyState = [
    "installing",
    "creating",
    "updating",
    "restoring",
    "deleting",
  ].includes(server?.state ?? "");

  return (
    <ContextMenu
      open={Boolean(menu)}
      x={menu?.x ?? 0}
      y={menu?.y ?? 0}
      label={server ? `Actions for ${server.name}` : "Server actions"}
      onClose={onClose}
    >
      {server && (
        <>
          <ContextMenuItem href={`/servers/${server.uid}`} onSelect={onClose}>
            Open
          </ContextMenuItem>
          {can("server.power") && (
            <>
              <ContextMenuSeparator />
              {!live ? (
                <ContextMenuItem
                  icon={Play}
                  disabled={busy || busyState}
                  onSelect={() => {
                    onStart(server);
                    onClose();
                  }}
                >
                  Start
                </ContextMenuItem>
              ) : (
                <>
                  <ContextMenuItem
                    icon={RotateCw}
                    disabled={busy || !running}
                    onSelect={() => {
                      onRestart(server);
                      onClose();
                    }}
                  >
                    Restart
                  </ContextMenuItem>
                  <ContextMenuItem
                    icon={Square}
                    danger
                    disabled={busy}
                    onSelect={() => {
                      onStop(server);
                      onClose();
                    }}
                  >
                    Stop
                  </ContextMenuItem>
                </>
              )}
            </>
          )}
          {(can("server.console") ||
            can("server.files") ||
            can("server.settings")) && (
            <>
              <ContextMenuSeparator />
              {can("server.console") && (
                <ContextMenuItem
                  icon={Terminal}
                  href={`/servers/${server.uid}?tab=Console`}
                  onSelect={onClose}
                >
                  Console
                </ContextMenuItem>
              )}
              {can("server.files") && (
                <ContextMenuItem
                  icon={FileText}
                  href={`/servers/${server.uid}?tab=Files`}
                  onSelect={onClose}
                >
                  Files
                </ContextMenuItem>
              )}
              {can("server.settings") && (
                <ContextMenuItem
                  icon={Settings}
                  href={`/servers/${server.uid}?tab=Settings`}
                  onSelect={onClose}
                >
                  Settings
                </ContextMenuItem>
              )}
            </>
          )}
          {(server.address || server.lanAddress) && (
            <>
              <ContextMenuSeparator />
              {server.address && (
                <ContextMenuItem
                  icon={Globe}
                  onSelect={() => {
                    onCopy(server.address!, "internet");
                    onClose();
                  }}
                >
                  Copy internet address
                </ContextMenuItem>
              )}
              {server.lanAddress && (
                <ContextMenuItem
                  icon={House}
                  onSelect={() => {
                    onCopy(server.lanAddress!, "local");
                    onClose();
                  }}
                >
                  Copy local address
                </ContextMenuItem>
              )}
            </>
          )}
        </>
      )}
    </ContextMenu>
  );
}

/** One allocation, label above value. */
function Spec({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <span className="legend flex items-center gap-1">
        <Icon className="h-2.5 w-2.5 shrink-0" aria-hidden />
        {label}
      </span>
      <span className="datum mt-1.5 block truncate text-ink">{value}</span>
    </div>
  );
}

function HeaderSkeleton() {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="space-y-2">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-3.5 w-52" />
      </div>
      <div className="flex gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-8 w-20 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

function ToolbarSkeleton() {
  return (
    <div className="flex gap-2 rounded-xl border border-line/60 bg-surface/50 p-2">
      <Skeleton className="h-9 flex-1 rounded-lg" />
      <Skeleton className="h-9 w-44 rounded-lg" />
    </div>
  );
}
