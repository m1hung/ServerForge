import type { SettingsSchema } from '@serverforge/core';
import type { ConsoleGlossary, EulaRequirement, GameVariant } from '../types.js';

/**
 * A game described as data rather than code.
 *
 * The hand-written `GameAdapter` interface remains the contract everything
 * downstream consumes — a manifest is compiled into one. That is deliberate:
 * it means adding a manifest game changes nothing in the API, the workers, the
 * wizard or the dashboard, and a game that outgrows the format can be
 * rewritten as a coded adapter without anything else noticing.
 *
 * The format targets the common case: a dedicated server that installs from
 * Steam, reads its settings from a config file or its command line, and says
 * something recognisable in its log when it is ready. Games that need real
 * logic — Minecraft's version resolution and modpack handling, for one — stay
 * as code, and should.
 */

export const MANIFEST_VERSION = 1;

/** A value reference usable in templates: `setting.X`, `port.X`, `memoryMib`. */
export type TemplateRef = string;

/**
 * A guard on an argument group or install step.
 *
 * `isSet` is the common one — "include this flag only if the user filled the
 * field in" — because an empty `-password ""` is not the same as omitting it,
 * and several games treat it as a password of zero length.
 */
export interface ManifestCondition {
  /** What to look at, e.g. "setting.Password". */
  ref: TemplateRef;
  /** True: include when the value is non-empty and not false. */
  isSet?: boolean;
  /** Include when the value matches one of these (compared as strings). */
  equals?: (string | number | boolean)[];
}

/** One entry in a templated argv: a literal/templated string, or a group. */
export type ManifestArg = string | { when: ManifestCondition; args: string[] };

/** How the server's files get onto disk. */
export type ManifestInstall =
  | {
      kind: 'steam';
      /** Steam application id of the *dedicated server*, not the game. */
      appId: string;
      /** Adds the shared Steam branch/password settings to every variant. */
      branchSettings?: boolean;
      /** Shown while SteamCMD runs; downloads are long and silence worries people. */
      message?: string;
    }
  | {
      kind: 'download';
      /** Templated URL. Must be https. */
      url: string;
      /** Where to unpack, relative to the server directory. */
      dest?: string;
      /** Strip this many leading path components from the archive. */
      strip?: number;
      message?: string;
    };

/** A step run after the files are in place, e.g. creating a mods folder. */
export interface ManifestInstallStep {
  /** Restricts the step to these variant ids. Absent means every variant. */
  variants?: string[];
  mkdir?: string;
  writeFile?: { path: string; contents: string };
  /** Progress line shown while it runs. */
  message?: string;
}

/** How the game is launched. */
export interface ManifestRuntime {
  /** Container image. Steam games usually want the SteamCMD image. */
  image: string;
  workingDir: string;
  /** argv. Never a shell string — there is no shell to inject into. */
  command: ManifestArg[];
  /** Extra environment, templated. Merged under the server's own env. */
  env?: Record<string, string>;
  /**
   * Container-side ports, matched to allocations by purpose. See
   * `StartupPlan.ports` for why `fixed` is almost never what you want.
   */
  ports: { containerPort: number; purpose: string; protocol: 'tcp' | 'udp'; fixed?: boolean }[];
  /** Written to stdin for a graceful stop, e.g. "stop\n". */
  stopCommand?: string;
  stopTimeoutSeconds: number;
  /** A line matching this promotes the server from "starting" to "running". */
  readyPattern?: string;
}

/**
 * One log-classification rule. Evaluated in order; the first match wins, which
 * is what lets a specific rule sit above a general "anything with ERROR" one.
 */
export interface ManifestLogRule {
  /** Serialised RegExp source, always matched case-insensitively. */
  pattern: string;
  level: 'info' | 'warn' | 'error' | 'success';
  /** Plain-language explanation shown under the line. */
  hint?: string;
  ready?: boolean;
  /**
   * Marks this rule as a player join/leave, taking the name from the given
   * capture group. The compiler checks the group exists — a rule that claims
   * to report players and captures nothing would show an empty player list.
   */
  playerEvent?: { type: 'join' | 'leave'; nameGroup: number };
}

export interface ManifestVariant extends GameVariant {
  /** Overrides the game-level defaults for this variant. */
  limits?: { memoryMib: number; cpuCores: number; diskMib: number };
  /** Where mods go for this variant, relative to the server directory. */
  modDirectory?: string;
}

export interface GameManifest {
  /** Guards against a future format change silently misreading old files. */
  manifestVersion: number;

  id: string;
  name: string;
  /** One sentence for the game picker. No marketing. */
  summary: string;
  /** Lucide icon name. */
  icon: string;

  variants: ManifestVariant[];
  /** Applies to any variant without its own `limits`. */
  limits: { memoryMib: number; cpuCores: number; diskMib: number };

  /** One allocation is reserved per entry. */
  ports: { purpose: string; protocol: 'tcp' | 'udp' }[];

  /** Drives the wizard, validation, and config materialisation. */
  settings: SettingsSchema;

  install: ManifestInstall;
  postInstall?: ManifestInstallStep[];
  runtime: ManifestRuntime;

  logRules?: ManifestLogRule[];
  console?: ConsoleGlossary;
  eula?: EulaRequirement;

  /**
   * Label for the single version these games have. Steam servers are always
   * "whatever Steam has today", and pretending otherwise would put a version
   * dropdown in the wizard that does nothing.
   */
  versionLabel?: string;
}
