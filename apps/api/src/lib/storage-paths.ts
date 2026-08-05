import path from 'node:path';
import { config } from '../config.js';

/**
 * Host ↔ container path bridge.
 *
 * The database stores *host* paths so Docker can bind-mount game directories
 * onto sibling containers. The API process often runs *inside* a container
 * where those same directories are mounted at DATA_ROOT / BACKUP_ROOT.
 *
 * Without rewriting, backups and file I/O write into a look-alike path on the
 * container filesystem that is not the host bind mount — archives never land
 * on the host, and restores read an empty tree.
 */

function rewritePrefix(input: string, fromRoot: string, toRoot: string): string | null {
  const resolved = path.resolve(input);
  const from = path.resolve(fromRoot);
  const to = path.resolve(toRoot);

  if (from === to) return resolved;
  if (resolved === from) return to;
  if (resolved.startsWith(from + path.sep)) {
    return path.join(to, resolved.slice(from.length + 1));
  }
  return null;
}

/** Filesystem path the API process can read/write for server data. */
export function localDataPath(stored: string): string {
  return (
    rewritePrefix(stored, config.HOST_DATA_ROOT, config.dataRoot) ??
    rewritePrefix(stored, config.dataRoot, config.dataRoot) ??
    path.resolve(stored)
  );
}

/** Host path Docker should bind-mount for a server data directory. */
export function hostDataPath(stored: string): string {
  return (
    rewritePrefix(stored, config.dataRoot, config.HOST_DATA_ROOT) ??
    rewritePrefix(stored, config.HOST_DATA_ROOT, config.HOST_DATA_ROOT) ??
    path.resolve(stored)
  );
}

/** Filesystem path the API process can read/write for backup archives. */
export function localBackupPath(stored: string): string {
  return (
    rewritePrefix(stored, config.HOST_BACKUP_ROOT, config.backupRoot) ??
    rewritePrefix(stored, config.backupRoot, config.backupRoot) ??
    path.resolve(stored)
  );
}

/** One entry of a container's mount table, as reported by the runtime. */
export interface RuntimeMount {
  source: string;
  destination: string;
}

/**
 * Checks a HOST_* root against the mount table of the container the API runs
 * in — the only authority on where a container path really comes from.
 *
 * A wrong value cannot be noticed locally: everything the API itself writes
 * goes to the container path and works. It surfaces only once Docker binds the
 * bad host path onto a game container, creates it empty because it does not
 * exist, and the server dies on a missing jar — far from the cause.
 *
 * Returns an operator-facing description of the problem, or null when the pair
 * agrees.
 */
export function describeMountMismatch(
  mounts: RuntimeMount[],
  options: { containerRoot: string; hostRoot: string; localKey: string; hostKey: string },
): string | null {
  const { containerRoot, hostRoot, localKey, hostKey } = options;
  const mount = mounts.find((m) => path.resolve(m.destination) === path.resolve(containerRoot));

  if (!mount) {
    return (
      `${localKey} (${containerRoot}) is not bind-mounted from the host, but ${hostKey} ` +
      `claims it is at ${hostRoot}.\n` +
      `    Nothing outside this container can see those files, so game containers would ` +
      `start against an empty directory.\n` +
      `    Add the bind mount to docker/docker-compose.yml, or unset ${hostKey}.`
    );
  }

  if (path.resolve(mount.source) !== path.resolve(hostRoot)) {
    return (
      `${hostKey} (${hostRoot}) is not where ${localKey} actually comes from — the host ` +
      `side of ${containerRoot} is ${mount.source}.\n` +
      `    Docker would create ${hostRoot} empty for every game container, and servers ` +
      `would fail with "Unable to access jarfile server.jar".\n` +
      `    Set ${hostKey}="${mount.source}" in .env, or re-run npm run bootstrap, then ` +
      `recreate the stack.`
    );
  }

  return null;
}

/** Host path of a backup archive (for ops/docs; Docker does not bind these). */
export function hostBackupPath(stored: string): string {
  return (
    rewritePrefix(stored, config.backupRoot, config.HOST_BACKUP_ROOT) ??
    rewritePrefix(stored, config.HOST_BACKUP_ROOT, config.HOST_BACKUP_ROOT) ??
    path.resolve(stored)
  );
}
