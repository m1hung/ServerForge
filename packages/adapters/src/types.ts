import type { SettingsSchema, SettingValues } from '@serverforge/core';

/**
 * The game adapter contract.
 *
 * Adding a game means writing one file that exports a `GameAdapter` and
 * registering it. Nothing in the API, the worker, or the dashboard needs to
 * know the game exists — the registry drives the deploy wizard, the settings
 * page, the install pipeline, the startup command and the log parsing.
 */

export interface GameVariant {
  /** Stable id, unique within the game. e.g. "paper", "fabric". */
  id: string;
  name: string;
  /** One sentence a beginner can choose on. No jargon. */
  summary: string;
  /**
   * Longer explanation shown in the "which one should I pick?" disclosure.
   * Markdown-lite: paragraphs only.
   */
  detail?: string;
  /** Sorts the variant cards; lower is earlier. */
  order: number;
  /** Surfaces a "Recommended" badge on exactly one variant per game. */
  recommended?: boolean;
  /** Shows a "Community favourite" style tag. */
  tags?: string[];
  /** Supports server-side mods/plugins, enabling the Mods tab. */
  supportsMods: boolean;
  /** Which mod ecosystems apply, driving the Mods tab's browse sources. */
  modLoader?: 'paper' | 'fabric' | 'forge' | 'neoforge' | 'none';
}

export interface VersionInfo {
  /** Version string persisted on the server row. */
  id: string;
  /** Display label, e.g. "1.21.4 (build 219)". */
  label: string;
  /** Loader build/stability metadata where relevant. */
  build?: string;
  stable: boolean;
  releasedAt?: string;
}

/** Everything an install or startup step is allowed to know about a server. */
export interface ServerContext {
  serverUid: string;
  name: string;
  /** Absolute path to the server directory on the node. */
  dataPath: string;
  version: string;
  build?: string | null;
  /**
   * Runtime major version resolved at install time from publisher metadata
   * (e.g. Java 25). Null when unknown, in which case the adapter falls back
   * to its own heuristic.
   */
  runtimeMajor?: number | null;
  variantId: string;
  settings: SettingValues;
  memoryMib: number;
  cpuCores: number;
  allocations: { ip: string; port: number; purpose: string; primary: boolean }[];
  /** Env from the server row, merged over adapter defaults. */
  environment: Record<string, string>;
  javaFlagsPreset: string;
  customJavaFlags?: string | null;
}

export interface InstallReporter {
  phase(
    phase: 'preparing' | 'resolving_version' | 'downloading' | 'extracting' | 'configuring' | 'finalizing',
    message: string,
    percent?: number,
  ): Promise<void>;
  log(message: string): Promise<void>;
}

/** Filesystem + download primitives handed to adapters by the worker. */
export interface InstallTools {
  /** Downloads to `destRelative`, streaming with progress. Returns bytes. */
  download(
    url: string,
    destRelative: string,
    options?: { headers?: Record<string, string>; sha1?: string; sha256?: string; sha512?: string },
  ): Promise<number>;
  /** Extracts a zip inside the server dir, zip-slip guarded. */
  unzip(archiveRelative: string, destRelative: string, options?: { strip?: number }): Promise<void>;
  writeFile(relative: string, contents: string): Promise<void>;
  readFile(relative: string): Promise<string | null>;
  exists(relative: string): Promise<boolean>;
  mkdir(relative: string): Promise<void>;
  remove(relative: string): Promise<void>;
  listDir(relative: string): Promise<string[]>;
  /**
   * Runs a throwaway container for install work that needs a real runtime
   * (SteamCMD, a Forge installer jar). Returns combined output.
   */
  runInContainer(options: {
    image: string;
    command: string[];
    /** Extra env for the install container. */
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{ exitCode: number; output: string }>;
}

export interface StartupPlan {
  /** Container image to run. */
  image: string;
  /** argv. Never a shell string — no shell injection surface. */
  command: string[];
  /** Working directory inside the container. */
  workingDir: string;
  env: Record<string, string>;
  /**
   * Ports to publish, matched to allocations by `purpose`.
   *
   * By default the container port *equals the allocated host port*, because
   * `applySettings` configures the game to listen on the allocated port —
   * mapping host 25500 to a fixed container 25565 would publish a port
   * nothing is listening on, and the server would look online while refusing
   * every connection.
   *
   * `containerPort` is therefore only the documented default for the game.
   * Set `fixed: true` for a game whose listening port genuinely cannot be
   * configured, and the mapping becomes hostPort -> containerPort instead.
   */
  ports: {
    containerPort: number;
    purpose: string;
    protocol: 'tcp' | 'udp';
    fixed?: boolean;
  }[];
  /** Written to stdin to request a graceful shutdown, e.g. "stop\n". */
  stopCommand?: string;
  /** Seconds to wait after `stopCommand` before SIGKILL. */
  stopTimeoutSeconds: number;
  /**
   * A line matching this marks the server as fully "running" rather than
   * merely "starting". Serialised RegExp source.
   */
  readyPattern?: string;
}

export interface LogInsight {
  /** Elevates a line in the console UI. */
  level: 'info' | 'warn' | 'error' | 'success';
  /** Plain-language explanation shown as an inline hint under the line. */
  hint?: string;
  /** Marks the server as ready. */
  ready?: boolean;
  /** Player join/leave detected, used for the live player counter. */
  playerEvent?: { type: 'join' | 'leave'; name: string };
}

export interface EulaRequirement {
  /** Shown as a checkbox in the deploy wizard. */
  key: string;
  label: string;
  url: string;
  /** File written on accept, e.g. "eula.txt" -> "eula=true". */
  file: string;
  contents: string;
}

export interface GameAdapter {
  id: string;
  name: string;
  /** Short marketing-free description for the game picker. */
  summary: string;
  /** Lucide icon name rendered in the picker. */
  icon: string;
  variants: GameVariant[];

  /** Sensible starting resources per variant, used to prefill the wizard. */
  defaultLimits(variantId: string): { memoryMib: number; cpuCores: number; diskMib: number };

  /** Ports the adapter needs. The allocator reserves one per entry. */
  requiredPorts(variantId: string): { purpose: string; protocol: 'tcp' | 'udp'; offset?: number }[];

  /** Settings schema for a variant. Drives UI, validation and materialising. */
  settingsSchema(variantId: string): SettingsSchema;

  /** Legal acceptance gate, e.g. the Minecraft EULA. */
  eula?(variantId: string): EulaRequirement | null;

  /** Lists installable versions, newest first. Network-bound; cached upstream. */
  listVersions(variantId: string): Promise<VersionInfo[]>;

  /** Turns "latest" into a concrete version + build. */
  resolveVersion(variantId: string, version: string): Promise<VersionInfo>;

  /**
   * Resolves the runtime major version the game requires (e.g. Java 25).
   *
   * Called once during install, where network access is fine, and the result
   * is persisted — `startup()` is synchronous and must not guess. Return null
   * when the publisher does not say.
   */
  detectRuntime?(variantId: string, version: string): Promise<number | null>;

  /** Downloads and lays out the server files. */
  install(ctx: ServerContext, tools: InstallTools, report: InstallReporter): Promise<void>;

  /**
   * Writes settings into the game's own config files. Called after install
   * and on every settings change, before the next start.
   */
  applySettings(ctx: ServerContext, tools: InstallTools): Promise<void>;

  /** Builds the container spec. Pure — no I/O, so it is trivially testable. */
  startup(ctx: ServerContext): StartupPlan;

  /** Classifies a console line. Pure and fast: runs on every line. */
  inspectLog?(line: string): LogInsight | null;

  /** Where mods/plugins are dropped, relative to the server dir. */
  modDirectory?(variantId: string): string | null;
}
