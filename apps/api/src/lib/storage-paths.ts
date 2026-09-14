import path from 'node:path';
import { config } from './config.js';

function remap(fromRoot: string, toRoot: string, value: string): string {
  const from = path.resolve(fromRoot);
  const to = path.resolve(toRoot);
  const target = path.resolve(value);
  if (target === from) return to;
  if (target.startsWith(from + path.sep)) {
    return path.join(to, path.relative(from, target));
  }
  return target;
}

export function localDataPath(hostOrLocalPath: string): string {
  if (!config.hostDataRoot) return path.resolve(hostOrLocalPath);
  return remap(config.hostDataRoot, config.dataRoot, hostOrLocalPath);
}

export function hostDataPath(localPath: string): string {
  if (!config.hostDataRoot) return path.resolve(localPath);
  return remap(config.dataRoot, config.hostDataRoot, localPath);
}

export function localBackupPath(hostOrLocalPath: string): string {
  if (!config.hostBackupRoot) return path.resolve(hostOrLocalPath);
  return remap(config.hostBackupRoot, config.backupRoot, hostOrLocalPath);
}

export function hostBackupPath(localPath: string): string {
  if (!config.hostBackupRoot) return path.resolve(localPath);
  return remap(config.backupRoot, config.hostBackupRoot, localPath);
}

export function describeMountMismatch(
  mounts: { source: string; destination: string }[],
  options: { containerRoot: string; hostRoot: string; localKey: string; hostKey: string },
): string | null {
  const wantedDest = path.resolve(options.containerRoot);
  const wantedHost = path.resolve(options.hostRoot);
  const match = mounts.find(
    (mount) => path.resolve(mount.destination) === wantedDest,
  );
  if (!match) {
    return `${options.localKey} is not bind-mounted at ${options.containerRoot}.`;
  }
  if (path.resolve(match.source) !== wantedHost) {
    return (
      `The directory mounted at ${options.containerRoot} is ${path.resolve(match.source)}, ` +
      `but ${options.hostKey} is ${wantedHost}. Set ${options.hostKey} to ${path.resolve(match.source)}.`
    );
  }
  return null;
}
