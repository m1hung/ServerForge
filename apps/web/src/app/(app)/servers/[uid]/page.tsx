"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  Clock3,
  Copy,
  Cpu,
  Gamepad2,
  HardDrive,
  MemoryStick,
  Play,
  RotateCw,
  Square,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, ApiError } from "@/lib/api";
import {
  copyToClipboard,
  cn,
  formatBytes,
  formatDuration,
  formatMib,
} from "@/lib/utils";
import {
  Badge,
  Button,
  Card,
  CardBody,
  Modal,
  Skeleton,
  useToast,
} from "@/components/ui";
import {
  STATE_STYLES,
  StatusBadge,
  type ServerState,
} from "@/components/server-status";
import { Console, type ConsoleGlossary } from "@/components/console";
import { useServerStream, type Stats } from "@/hooks/use-server-stream";
import { SettingsPanel } from "./settings-panel";
import { GeneralPanel } from "./general-panel";
import { FilesPanel } from "./files-panel";
import { BackupsPanel } from "./backups-panel";
import { ModsPanel } from "./mods-panel";
import { SchedulesPanel } from "./schedules-panel";
import { SubusersPanel } from "./subusers-panel";

interface ServerDetail {
  server: {
    uid: string;
    name: string;
    description: string | null;
    state: ServerState;
    gameId: string;
    game: { name: string; icon: string };
    variantId: string;
    variant: { name: string; supportsMods: boolean } | null;
    version: string;
    limits: { memoryMib: number; cpuCores: number; diskMib: number };
    address: string | null;
    installedAt: string | null;
    crashCount: number;
    isOwner: boolean;
    modDirectory: string | null;
    consoleGlossary: ConsoleGlossary | null;
    permissions: string[];
  };
}

const ALL_TABS = [
  "Overview",
  "Console",
  "Files",
  "Backups",
  "Schedules",
  "Mods",
  "Settings",
  "Access",
  "General",
] as const;
type Tab = (typeof ALL_TABS)[number];

/** Which tab each section needs; Overview and General are open to anyone. */
const TAB_PERMISSION: Partial<Record<Tab, string>> = {
  Console: "server.console",
  Files: "server.files",
  Backups: "server.backups",
  Schedules: "server.schedules",
  Mods: "server.mods",
  Settings: "server.settings",
  Access: "server.subusers",
};

/**
 * The tabs this person can actually open.
 *
 * Every section behind a permission answers 403 without it, so a tab that is
 * only ever an error message is worse than no tab — the same reasoning the
 * sidebar uses. Mods is hidden on server types with no mod folder, which is
 * most of them.
 */
function visibleTabs(server: {
  permissions: string[];
  modDirectory: string | null;
}): Tab[] {
  const held = server.permissions ?? [];
  return ALL_TABS.filter((tab) => {
    if (tab === "Mods" && !server.modDirectory) return false;
    const needed = TAB_PERMISSION[tab];
    return !needed || held.includes(needed);
  });
}

export default function ServerPage() {
  const params = useParams<{ uid: string }>();
  const uid = params.uid;
  const toast = useToast();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<Tab>("Overview");
  const [confirmStop, setConfirmStop] = useState(false);

  const detail = useQuery({
    queryKey: ["server", uid],
    queryFn: () => api.get<ServerDetail>(`/api/servers/${uid}`),
  });

  const stream = useServerStream(uid);
  // The socket is the fresher source once it has spoken; the query result
  // covers the gap before the first message arrives.
  const state = stream.state ?? detail.data?.server.state ?? "offline";

  const power = useMutation({
    mutationFn: (action: "start" | "stop" | "restart" | "kill") =>
      api.post(`/api/servers/${uid}/power`, { action }),
    onError: (error) => {
      if (error instanceof ApiError) {
        toast.push({
          tone: "danger",
          message: error.body.message,
          hint: error.body.hint,
        });
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["server", uid] }),
  });

  const sendCommand = useMutation({
    mutationFn: (command: string) =>
      api.post(`/api/servers/${uid}/command`, { command }),
    onError: (error) => {
      if (error instanceof ApiError)
        toast.push({ tone: "danger", message: error.body.message });
    },
  });

  if (detail.isLoading) {
    return (
      <div className="page-shell space-y-5">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-32 w-full rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  if (!detail.data) return null;
  const server = detail.data.server;
  const tabs = visibleTabs(server);

  const isLive = ["running", "starting", "stopping"].includes(state);
  const isBusy = [
    "installing",
    "creating",
    "updating",
    "restoring",
    "deleting",
  ].includes(state);
  const explain = STATE_STYLES[state]?.explain;

  return (
    <div className="page-shell space-y-6">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div>
        <Link
          href="/servers"
          className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] text-ink-muted transition-colors hover:text-accent"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          All servers
        </Link>

        <Card className="relative overflow-hidden">
          <div className="relative flex flex-col gap-5 p-5 sm:p-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-start gap-4">
              <div className="inset-well flex h-11 w-11 shrink-0 items-center justify-center text-accent">
                <Gamepad2 className="h-5 w-5" aria-hidden />
              </div>
              <div className="min-w-0">
                <StatusBadge state={state} className="mb-2" />
                <h1 className="engraved truncate text-xl tracking-[-0.02em]">
                  {server.name}
                </h1>
                <p className="datum mt-1.5">
                  {server.game.name} ·{" "}
                  {server.variant?.name ?? server.variantId} · {server.version}
                </p>
                {server.address && (
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await copyToClipboard(server.address!);
                      toast.push({
                        tone: ok ? "ok" : "danger",
                        message: ok ? "Address copied" : "Could not copy",
                      });
                    }}
                    className="readout mt-3 inline-flex max-w-full items-center gap-2 px-2.5 py-1.5 text-[11.5px] transition-colors hover:border-line-strong"
                    aria-label={`Copy ${server.address}`}
                  >
                    <span className="truncate">{server.address}</span>
                    <Copy
                      className="h-3.5 w-3.5 shrink-0 text-ink-subtle"
                      aria-hidden
                    />
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {!isLive ? (
                <Button
                  variant="primary"
                  loading={power.isPending && power.variables === "start"}
                  disabled={isBusy}
                  onClick={() => power.mutate("start")}
                >
                  <Play className="h-4 w-4" aria-hidden />
                  Start server
                </Button>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    loading={power.isPending && power.variables === "restart"}
                    onClick={() => power.mutate("restart")}
                  >
                    <RotateCw className="h-4 w-4" aria-hidden />
                    Restart
                  </Button>
                  <Button variant="danger" onClick={() => setConfirmStop(true)}>
                    <Square className="h-4 w-4" aria-hidden />
                    Stop
                  </Button>
                </>
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* ── Install progress ───────────────────────────────────────── */}
      {stream.install && stream.install.phase !== "done" && (
        <Card className="border-l-2 border-l-info bg-info/[0.04]">
          <CardBody className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <p className="font-mono text-[12.5px] font-medium text-ink">
                {stream.install.error
                  ? "Installation failed"
                  : "Setting up your server"}
              </p>
              {stream.install.percent >= 0 && !stream.install.error && (
                <span className="font-mono text-[12px] tabular-nums text-ink-muted">
                  {Math.round(stream.install.percent)}%
                </span>
              )}
            </div>

            {!stream.install.error && stream.install.percent >= 0 && (
              <div
                className="meter h-1.5"
                role="progressbar"
                aria-valuenow={Math.round(stream.install.percent)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Installation progress"
              >
                <div
                  className="h-full bg-info transition-all duration-500"
                  style={{ width: `${Math.max(2, stream.install.percent)}%` }}
                />
              </div>
            )}

            <p
              className={cn(
                "text-[12.5px]",
                stream.install.error ? "text-danger" : "text-ink-muted",
              )}
            >
              {stream.install.error ?? stream.install.message}
            </p>
          </CardBody>
        </Card>
      )}

      {/* ── State explainer ────────────────────────────────────────── */}
      {explain && state !== "running" && !stream.install && (
        <div className="flex items-start gap-2.5 rounded-md border border-line border-l-2 border-l-line-strong bg-surface px-3.5 py-2.5">
          <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            {explain}
          </p>
        </div>
      )}

      {/* ── Live stats ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          icon={Cpu}
          label="CPU"
          value={
            stream.stats
              ? `${cpuUtilizationPercent(stream.stats.cpuPercent, server.limits.cpuCores).toFixed(1)}%`
              : "—"
          }
          sub={`of ${server.limits.cpuCores} cores`}
          percent={
            stream.stats
              ? cpuUtilizationPercent(stream.stats.cpuPercent, server.limits.cpuCores)
              : undefined
          }
        />
        <Stat
          icon={MemoryStick}
          label="Memory"
          value={stream.stats ? formatBytes(stream.stats.memoryBytes) : "—"}
          sub={`of ${formatMib(server.limits.memoryMib)}`}
          percent={
            stream.stats && server.limits.memoryMib > 0
              ? (stream.stats.memoryBytes /
                  (server.limits.memoryMib * 1024 * 1024)) *
                100
              : undefined
          }
        />
        <Stat
          icon={HardDrive}
          label="Disk"
          value={
            stream.stats?.diskBytes ? formatBytes(stream.stats.diskBytes) : "—"
          }
          sub={`of ${formatMib(server.limits.diskMib)}`}
          percent={
            stream.stats?.diskBytes && server.limits.diskMib > 0
              ? (stream.stats.diskBytes /
                  (server.limits.diskMib * 1024 * 1024)) *
                100
              : undefined
          }
        />
        <Stat
          icon={Clock3}
          label="Uptime"
          value={
            state === "running"
              ? formatDuration(stream.stats?.uptimeSeconds ?? 0)
              : "—"
          }
          sub={
            state === "running"
              ? `${stream.stats?.players?.online ?? 0} players online`
              : "Server is offline"
          }
        />
      </div>

      <ResourceChart
        history={stream.statsHistory}
        cpuCores={server.limits.cpuCores}
        memoryLimitBytes={server.limits.memoryMib * 1024 * 1024}
        connected={stream.connected}
      />

      {/* ── Tabs ───────────────────────────────────────────────────── */}
      {/* A single rule under the row, with the selected tab sitting on it —
          the least furniture that still says "these are the sections". */}
      <div className="overflow-x-auto border-b border-line scrollbar-thin">
        <div
          className="flex min-w-max gap-1"
          role="tablist"
          aria-label="Server sections"
        >
          {tabs.map((entry) => (
            <button
              key={entry}
              id={`tab-${entry.toLowerCase()}`}
              role="tab"
              aria-selected={tab === entry}
              aria-controls={`panel-${entry.toLowerCase()}`}
              tabIndex={tab === entry ? 0 : -1}
              onClick={() => setTab(entry)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2.5 text-[13px] transition-colors",
                tab === entry
                  ? "border-b-accent font-medium text-ink"
                  : "border-b-transparent text-ink-muted hover:text-ink",
              )}
            >
              {entry}
            </button>
          ))}
        </div>
      </div>

      <div
        id={`panel-${tab.toLowerCase()}`}
        role="tabpanel"
        aria-labelledby={`tab-${tab.toLowerCase()}`}
        tabIndex={0}
      >
        {tab === "Overview" && <Overview server={server} state={state} />}

        {tab === "Console" && (
          <div className="h-[560px]">
            <Console
              lines={stream.lines}
              connected={stream.connected}
              canSend={state === "running"}
              onSend={(command) => sendCommand.mutate(command)}
              glossary={server.consoleGlossary}
              disabledReason={
                state === "starting"
                  ? "Wait for the server to finish starting"
                  : undefined
              }
            />
          </div>
        )}

        {tab === "Files" && (
          <FilesPanel uid={uid} permissions={server.permissions ?? []} />
        )}

        {tab === "Backups" && (
          <BackupsPanel
            uid={uid}
            state={state}
            permissions={server.permissions ?? []}
          />
        )}

        {tab === "Schedules" && (
          <SchedulesPanel uid={uid} permissions={server.permissions ?? []} />
        )}

        {tab === "Mods" && (
          <ModsPanel
            uid={uid}
            state={state}
            permissions={server.permissions ?? []}
          />
        )}

        {tab === "Settings" && <SettingsPanel uid={uid} state={state} />}

        {tab === "Access" && (
          <SubusersPanel uid={uid} permissions={server.permissions ?? []} />
        )}

        {tab === "General" && (
          <GeneralPanel
            server={{
              uid: server.uid,
              name: server.name,
              description: server.description,
              state,
              version: server.version,
              gameName: server.game?.name ?? server.gameId,
              limits: server.limits,
              permissions: server.permissions ?? [],
            }}
          />
        )}
      </div>

      <Modal
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        title="Stop the server?"
        description="Everyone playing will be disconnected."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmStop(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                power.mutate("stop");
                setConfirmStop(false);
              }}
            >
              Stop server
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink-muted">
          The world is saved first, so nothing is lost. Starting it again takes
          about as long as it did the first time.
        </p>
      </Modal>
    </div>
  );
}

/**
 * Docker reports CPU as percent of one core (100% = one full core), so a busy
 * multi-core container routinely exceeds 100%. Scale to the server's allocated
 * cores so the chart shares a 0–100% axis with memory.
 */
function cpuUtilizationPercent(cpuPercent: number, cpuCores: number): number {
  return cpuPercent / Math.max(cpuCores, 0.01);
}

/** Keep the axis readable when a spike briefly runs past 100%. */
function utilizationAxisMax(dataMax: number): number {
  const peak = Number.isFinite(dataMax) ? dataMax : 100;
  return Math.max(100, Math.ceil(peak / 25) * 25);
}

function ResourceChart({
  history,
  cpuCores,
  memoryLimitBytes,
  connected,
}: {
  history: Stats[];
  cpuCores: number;
  memoryLimitBytes: number;
  connected: boolean;
}) {
  const data = history.map((sample) => ({
    time: new Date(sample.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    CPU: Number(cpuUtilizationPercent(sample.cpuPercent, cpuCores).toFixed(1)),
    Memory: Number(
      (
        (sample.memoryBytes /
          Math.max(1, sample.memoryLimitBytes || memoryLimitBytes)) *
        100
      ).toFixed(1),
    ),
  }));

  return (
    <Card>
      <CardBody className="pb-4">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Activity className="h-3.5 w-3.5 text-accent" aria-hidden />
              <h2 className="engraved text-[13px]">Resource activity</h2>
            </div>
            <p className="datum mt-1 text-ink-subtle">
              Live usage from the last few minutes
            </p>
          </div>
          {/* Series keys, then whether the feed is actually arriving. */}
          <div className="flex items-center gap-3.5">
            <span className="legend inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-accent" aria-hidden />
              CPU
            </span>
            <span className="legend inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-info" aria-hidden />
              Memory
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 text-[11px] font-medium leading-none",
                connected ? "text-ok" : "text-ink-subtle",
              )}
            >
              <span
                className={cn(
                  "h-[6px] w-[6px]",
                  connected ? "lamp animate-blink" : "lamp-off",
                )}
                aria-hidden
              />
              {connected ? "Live" : "Connecting"}
            </span>
          </div>
        </div>

        {data.length > 1 ? (
          <div
            className="h-52 w-full"
            aria-label="CPU and memory utilization chart"
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={data}
                margin={{ top: 4, right: 4, left: -26, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="cpu-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="hsl(var(--accent))"
                      stopOpacity={0.3}
                    />
                    <stop
                      offset="100%"
                      stopColor="hsl(var(--accent))"
                      stopOpacity={0}
                    />
                  </linearGradient>
                  <linearGradient id="memory-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="hsl(var(--info))"
                      stopOpacity={0.2}
                    />
                    <stop
                      offset="100%"
                      stopColor="hsl(var(--info))"
                      stopOpacity={0}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  stroke="hsl(var(--line))"
                  strokeDasharray="2 4"
                  vertical={false}
                />
                <XAxis
                  dataKey="time"
                  stroke="hsl(var(--ink-subtle))"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={32}
                  tick={{ fontSize: 10 }}
                />
                <YAxis
                  domain={[0, utilizationAxisMax]}
                  allowDataOverflow={false}
                  stroke="hsl(var(--ink-subtle))"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 10 }}
                  tickFormatter={(value) => `${value}%`}
                />
                <ChartTooltip
                  contentStyle={{
                    background: "hsl(var(--surface-raised))",
                    border: "1px solid hsl(var(--line-strong))",
                    borderRadius: 6,
                    color: "hsl(var(--ink))",
                    fontSize: 12,
                    fontFamily: "var(--font-mono), ui-monospace, monospace",
                  }}
                  formatter={(value: number) => [`${value}%`]}
                />
                <Area
                  type="monotone"
                  dataKey="CPU"
                  stroke="hsl(var(--accent))"
                  strokeWidth={2}
                  fill="url(#cpu-fill)"
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="Memory"
                  stroke="hsl(var(--info))"
                  strokeWidth={2}
                  fill="url(#memory-fill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          // The chart frame is there; nothing is arriving to draw in it.
          <div className="inset-well flex h-36 items-center justify-center">
            <div className="text-center">
              <Activity
                className="mx-auto h-4 w-4 text-ink-subtle"
                aria-hidden
              />
              <p className="legend mt-2.5">No data yet</p>
              <p className="mt-2 text-[11.5px] text-ink-subtle">
                The graph appears once the server reports usage.
              </p>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  percent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub: string;
  percent?: number;
}) {
  // Colour shifts as a resource fills, so a problem is visible at a glance
  // from across the room.
  const tone =
    percent === undefined
      ? "bg-accent"
      : percent > 90
        ? "bg-danger"
        : percent > 75
          ? "bg-warn"
          : "bg-ok";

  return (
    <Card className="p-3.5 sm:p-4">
      <div className="flex items-center gap-1.5 text-ink-subtle">
        <Icon className="h-3 w-3 shrink-0" aria-hidden />
        <span className="legend">{label}</span>
      </div>

      {/* The reading itself — the largest thing on the tile, unadorned. */}
      <p className="mt-3 font-mono text-[22px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-ink">
        {value}
      </p>
      <p className="datum mt-2 text-ink-subtle">{sub}</p>

      {percent !== undefined && (
        /*
         * The bar's colour is the warning, not a printed scale: green up to
         * 75%, amber to 90%, red past it. That is one signal instead of two,
         * and it is the one people actually read.
         */
        <div
          className="meter mt-3 h-1"
          role="meter"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label} utilisation`}
        >
          <div
            className={cn("h-full transition-all", tone)}
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </div>
      )}
    </Card>
  );
}

function Overview({
  server,
  state,
}: {
  server: ServerDetail["server"];
  state: ServerState;
}) {
  const activity = useQuery({
    queryKey: ["activity", server.uid],
    queryFn: () =>
      api.get<{
        entries: { id: string; action: string; message: string; at: string }[];
      }>(`/api/servers/${server.uid}/activity`),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardBody className="space-y-3">
          <h2 className="eyebrow">
            Details
          </h2>
          <Row
            label="Edition"
            value={server.variant?.name ?? server.variantId}
          />
          <Row label="Version" value={server.version} />
          <Row label="Memory" value={formatMib(server.limits.memoryMib)} />
          <Row
            label="Installed"
            value={server.installedAt ? "Yes" : "Not yet"}
          />
          {server.crashCount > 0 && (
            // Badges are tags now, so the qualifier lives in the label —
            // a full sentence set in uppercase tracking reads as shouting.
            <Row
              label="Crashes since install"
              value={<Badge tone="warn">{server.crashCount}</Badge>}
            />
          )}
          {server.modDirectory && (
            <Row label="Mods folder" value={server.modDirectory} />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <h2 className="eyebrow">
            Recent activity
          </h2>
          {activity.data?.entries.length === 0 && (
            <p className="text-[13px] text-ink-subtle">
              Nothing has happened yet.
            </p>
          )}
          {/* Reads like a log tail: fixed-width timestamp column, message
              after it, so the eye scans one gutter instead of two. */}
          <ul className="space-y-2">
            {activity.data?.entries.slice(0, 8).map((entry) => (
              <li key={entry.id} className="flex gap-3 text-[12.5px]">
                <time
                  dateTime={entry.at}
                  className="shrink-0 font-mono text-[11.5px] tabular-nums text-ink-subtle"
                  title={new Date(entry.at).toLocaleString()}
                >
                  {new Date(entry.at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                <span className="text-ink-muted">{entry.message}</span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * A key/value line: label left, value hard right in mono. No leader between
 * them — with this few rows the alignment alone does the pairing, and the
 * dots were the loudest thing in a card of quiet text.
 */
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-[12.5px]">
      <span className="shrink-0 text-ink-subtle">{label}</span>
      <span className="min-w-0 text-right font-mono text-[12px] text-ink">
        {value}
      </span>
    </div>
  );
}
