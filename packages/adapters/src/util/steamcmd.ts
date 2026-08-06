import type { SettingsSchema, SettingValues } from '@serverforge/core';
import type { InstallTools } from '../types.js';

/** Shared image for SteamCMD install containers and Steam-based game runtimes. */
export const STEAMCMD_IMAGE = 'steamcmd/steamcmd:ubuntu-24';

/**
 * The branch name Steam uses for the ordinary, released build.
 *
 * SteamCMD wants `-beta public` for it — but passing no `-beta` at all means
 * the same thing, so this is treated as "no branch" everywhere below.
 */
export const DEFAULT_STEAM_BRANCH = 'public';

/**
 * Steam branch names, as SteamCMD will accept them.
 *
 * Deliberately strict. The value reaches SteamCMD as its own argv entry, so
 * there is no shell to inject into — but a branch called `-validate` would be
 * read as a *flag* rather than a name, which is a different and quieter way to
 * change what the install does. Real branch names are lowercase slugs.
 */
const BRANCH_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function isValidSteamBranch(branch: string): boolean {
  return BRANCH_PATTERN.test(branch) && branch.length <= 64;
}

/**
 * Normalises a branch setting into the argv fragment SteamCMD wants.
 *
 * Exported for the tests: getting this wrong installs the wrong build of the
 * game, which looks like "the server is broken" rather than like a mistake in
 * a config field.
 */
export function steamBranchArgs(options: {
  branch?: string | null;
  branchPassword?: string | null;
}): string[] {
  const branch = (options.branch ?? '').trim();
  if (branch === '' || branch === DEFAULT_STEAM_BRANCH) return [];

  if (!isValidSteamBranch(branch)) {
    throw new Error(
      `"${branch}" is not a valid Steam branch name. Branch names are lowercase letters, numbers, dots, dashes and underscores — check the name on the game's Steam betas tab.`,
    );
  }

  const password = (options.branchPassword ?? '').trim();

  // Password only after a branch: `-betapassword` alone is meaningless and
  // older SteamCMD builds treat the stray value as the app id.
  return password === ''
    ? ['-beta', branch]
    : ['-beta', branch, '-betapassword', password];
}

/** Setting keys the schema below defines, so adapters do not retype them. */
export const STEAM_BRANCH_KEY = 'SteamBranch';
export const STEAM_BRANCH_PASSWORD_KEY = 'SteamBranchPassword';

/**
 * The branch fields, identical for every SteamCMD game.
 *
 * Spread into an adapter's schema rather than copied, so a fix to the wording
 * or the validation reaches all of them. `expert` tier because picking the
 * wrong branch quietly installs a different game build — someone who needs it
 * knows to go looking, and nobody else should trip over it.
 */
export function steamBranchSettings(): SettingsSchema {
  const internal = { kind: 'internal' as const };

  return [
    {
      key: STEAM_BRANCH_KEY,
      type: 'string',
      label: 'Steam branch',
      help: 'Leave empty for the normal released build. Set it to a branch from the game\'s Steam betas tab to run a public test build, or to pin an older one while your mods catch up. Takes effect the next time the server is updated or reinstalled.',
      tier: 'expert',
      group: 'Updates',
      default: '',
      maxLength: 64,
      pattern: '^$|^[a-z0-9][a-z0-9._-]*$',
      placeholder: 'public',
      restartRequired: true,
      target: internal,
    },
    {
      key: STEAM_BRANCH_PASSWORD_KEY,
      type: 'string',
      label: 'Branch password',
      help: 'Only for branches the publisher has locked. Most branches need nothing here.',
      tier: 'expert',
      group: 'Updates',
      default: '',
      secret: true,
      maxLength: 128,
      restartRequired: true,
      // No `showWhen` gating this on a non-empty branch: the DSL matches
      // against a list of exact values, and "any value except empty" is not
      // one. Both fields sit together at expert tier instead, which reads
      // fine — the help text says when it is needed.
      target: internal,
    },
  ];
}

/** Reads the branch fields out of a server's settings, for `steamAppUpdate`. */
export function steamBranchFrom(settings: SettingValues): {
  branch: string;
  branchPassword: string;
} {
  return {
    branch: String(settings[STEAM_BRANCH_KEY] ?? ''),
    branchPassword: String(settings[STEAM_BRANCH_PASSWORD_KEY] ?? ''),
  };
}

/**
 * Downloads or updates a Steam dedicated server into `/home/container`.
 *
 * Used by Palworld, Valheim and any future SteamCMD game — the command shape
 * is identical; only the app id changes.
 *
 * `branch` selects a non-default build: the public test branch a game puts up
 * before a patch, or a pinned older build for a server whose mods have not
 * caught up yet. Some branches need a password, which the game's publisher
 * hands out; most do not.
 */
export async function steamAppUpdate(
  tools: InstallTools,
  options: {
    appId: string;
    report?: (msg: string) => Promise<void>;
    validate?: boolean;
    /** Steam branch, e.g. "public-test". Empty or "public" means the default. */
    branch?: string | null;
    branchPassword?: string | null;
    timeoutMs?: number;
  },
): Promise<void> {
  const branchArgs = steamBranchArgs(options);

  const command = [
    '+force_install_dir',
    '/home/container',
    '+login',
    'anonymous',
    '+app_update',
    options.appId,
    // Order matters: SteamCMD reads these as modifiers of the app_update it
    // follows, and `validate` has to come last of the three.
    ...branchArgs,
    ...(options.validate !== false ? ['validate'] : []),
    '+quit',
  ];

  await options.report?.(
    branchArgs.length > 0
      ? `Connecting to Steam (branch: ${options.branch})…`
      : 'Connecting to Steam…',
  );

  const result = await tools.runInContainer({
    image: STEAMCMD_IMAGE,
    command,
    timeoutMs: options.timeoutMs ?? 60 * 60 * 1000,
  });

  if (result.exitCode !== 0) {
    // A wrong branch name fails the same way a Steam outage does, so say so
    // rather than sending someone to wait out an outage that is not happening.
    const branchHint =
      branchArgs.length > 0
        ? ` Check that the branch "${options.branch}" still exists on the game's Steam betas tab${options.branchPassword ? ' and that its password is right' : ''}.`
        : '';

    throw new Error(
      `SteamCMD failed (exit ${result.exitCode}). This is usually a temporary Steam outage — try installing again.${branchHint}\n${result.output.slice(-4000)}`,
    );
  }
}
