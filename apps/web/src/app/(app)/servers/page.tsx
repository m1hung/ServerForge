"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Copy,
  Cpu,
  Gamepad2,
  HardDrive,
  MemoryStick,
  Rocket,
  Search,
  Server,
  TriangleAlert,
  Users,
  Wifi,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, streamUrl } from "@/lib/api";
import { cn, copyToClipboard, formatMib } from "@/lib/utils";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Skeleton,
  useToast,
} from "@/components/ui";
import { StatusBadge, type ServerState } from "@/components/server-status";

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
  players: number;
  isOwner: boolean;
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

  const servers = useQuery({
    queryKey: ["servers"],
    queryFn: () => api.get<{ servers: FleetServer[] }>("/api/servers"),
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
                    onCopy={async (address) => {
                      const ok = await copyToClipboard(address);
                      toast.push({
                        tone: ok ? "ok" : "danger",
                        message: ok ? "Address copied" : "Could not copy",
                        hint: ok ? "Ready to share." : undefined,
                      });
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
          className="inset-well h-8 w-full border border-transparent pl-8 pr-3 font-mono text-[12.5px] text-ink outline-none transition-colors placeholder:font-sans placeholder:text-ink-subtle focus:border-accent/60"
        />
      </label>

      {/* A segmented filter: the selected one is the only filled segment. */}
      <div
        className="flex shrink-0 gap-0.5 rounded-md bg-surface-raised p-0.5"
        aria-label="Filter servers"
      >
        {(["all", "online", "attention", "offline"] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            aria-pressed={filter === entry}
            onClick={() => onFilter(entry)}
            className={cn(
              "shrink-0 rounded-[5px] px-2.5 py-1.5 text-[12px] capitalize transition-colors",
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
}: {
  server: FleetServer;
  onCopy: (address: string) => void;
}) {
  const isLive = server.state === "running";

  return (
    /*
     * One server, one card, read top to bottom: who it is, what it is doing
     * right now, what it is allowed to use, and how to reach it.
     */
    <Card className="group flex flex-col px-4 py-4 transition-colors duration-150 hover:border-line-strong">
      {/* Identity strip */}
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/servers/${server.uid}`}
          className="flex min-w-0 items-center gap-2.5 rounded-md focus-visible:ring-inset"
        >
          <div className="inset-well flex h-8 w-8 shrink-0 items-center justify-center text-ink-subtle transition-colors group-hover:text-accent">
            <Gamepad2 className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0">
            <h2 className="engraved truncate text-[13.5px] leading-tight">
              {server.name}
            </h2>
            <p className="datum mt-1 truncate text-ink-subtle">
              {server.variantId} · {server.version}
            </p>
          </div>
        </Link>
        <StatusBadge state={server.state} className="mt-0.5 shrink-0" />
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

      {/* Footer: the address, and the way in */}
      <div className="mt-3.5 flex items-center gap-2">
        {server.address ? (
          <div className="readout flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5">
            <code className="min-w-0 flex-1 truncate text-[11px]">
              {server.address}
            </code>
            <button
              type="button"
              onClick={() => onCopy(server.address!)}
              className="shrink-0 rounded p-0.5 text-ink-subtle transition-colors hover:text-accent"
              aria-label={`Copy the address for ${server.name}`}
            >
              <Copy className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <span className="inset-well min-w-0 flex-1 truncate px-2 py-1.5 font-mono text-[11px] text-ink-subtle">
            no address assigned
          </span>
        )}
        <Link
          href={`/servers/${server.uid}`}
          className="inline-flex h-[30px] shrink-0 items-center gap-0.5 rounded-md border border-line px-2.5 text-[12px] text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
        >
          Open
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </Card>
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
