import type { InstallTools } from '../types.js';

/** Shared image for SteamCMD install containers and Steam-based game runtimes. */
export const STEAMCMD_IMAGE = 'steamcmd/steamcmd:ubuntu-24';

/**
 * Downloads or updates a Steam dedicated server into `/home/container`.
 *
 * Used by Palworld, Valheim and any future SteamCMD game — the command shape
 * is identical; only the app id changes.
 */
export async function steamAppUpdate(
  tools: InstallTools,
  options: {
    appId: string;
    report?: (msg: string) => Promise<void>;
    validate?: boolean;
    timeoutMs?: number;
  },
): Promise<void> {
  const command = [
    '+force_install_dir',
    '/home/container',
    '+login',
    'anonymous',
    '+app_update',
    options.appId,
    ...(options.validate !== false ? ['validate'] : []),
    '+quit',
  ];

  await options.report?.('Connecting to Steam…');

  const result = await tools.runInContainer({
    image: STEAMCMD_IMAGE,
    command,
    timeoutMs: options.timeoutMs ?? 60 * 60 * 1000,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `SteamCMD failed (exit ${result.exitCode}). This is usually a temporary Steam outage — try installing again.\n${result.output.slice(-4000)}`,
    );
  }
}
