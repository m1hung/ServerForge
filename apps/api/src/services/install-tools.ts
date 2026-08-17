import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetchWithRetry, resolveWithin, safeExtractTarget } from '@serverforge/core';
import type { InstallTools } from '@serverforge/adapters';
import type { RuntimeDriver } from '../runtime/types.js';
import { logger } from '../lib/logger.js';

/**
 * Filesystem-backed `InstallTools`.
 *
 * Every path an adapter passes in is untrusted — a modpack index is remote
 * data — so all of them go through `resolveWithin` against the server's own
 * directory. An adapter physically cannot write outside its server.
 */
export function createInstallTools(options: {
  dataPath: string;
  runtime: RuntimeDriver;
  onLine?: (line: string) => void;
}): InstallTools {
  const { dataPath, runtime } = options;

  const resolve = (relative: string) => resolveWithin(dataPath, relative);

  return {
    async download(url, destRelative, opts = {}) {
      const dest = resolve(destRelative);
      await fs.mkdir(path.dirname(dest), { recursive: true });

      const response = await fetchWithRetry(url, {
        headers: opts.headers ?? {},
        timeoutMs: 60_000,
        retries: 3,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Download failed (${response.status}) for ${url}`);
      }

      // Hash while streaming: a 2 GB modpack must never be buffered in memory
      // just to verify it.
      const sha1 = opts.sha1 ? createHash('sha1') : null;
      const sha256 = opts.sha256 ? createHash('sha256') : null;
      const sha512 = opts.sha512 ? createHash('sha512') : null;
      let bytes = 0;

      const source = Readable.fromWeb(response.body as never);
      source.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        sha1?.update(chunk);
        sha256?.update(chunk);
        sha512?.update(chunk);
      });

      const tempPath = `${dest}.partial`;
      await pipeline(source, createWriteStream(tempPath));

      if (sha1 && opts.sha1 && sha1.digest('hex') !== opts.sha1.toLowerCase()) {
        await fs.rm(tempPath, { force: true });
        throw new Error(`Downloaded file did not match its checksum: ${path.basename(dest)}`);
      }
      if (sha256 && opts.sha256 && sha256.digest('hex') !== opts.sha256.toLowerCase()) {
        await fs.rm(tempPath, { force: true });
        throw new Error(`Downloaded file did not match its checksum: ${path.basename(dest)}`);
      }
      if (sha512 && opts.sha512 && sha512.digest('hex') !== opts.sha512.toLowerCase()) {
        await fs.rm(tempPath, { force: true });
        throw new Error(`Downloaded file did not match its checksum: ${path.basename(dest)}`);
      }

      // Rename last, so an interrupted install never leaves a half-written
      // jar that looks complete on the next attempt.
      await fs.rename(tempPath, dest);
      return bytes;
    },

    async unzip(archiveRelative, destRelative, opts = {}) {
      const archivePath = resolve(archiveRelative);
      const destPath = resolve(destRelative);
      const strip = opts.strip ?? 0;

      // A directory source means "copy this tree", which is how modpack
      // overrides are applied.
      const stat = await fs.stat(archivePath).catch(() => null);
      if (stat?.isDirectory()) {
        await fs.cp(archivePath, destPath, { recursive: true, force: true });
        return;
      }

      const zip = new AdmZip(archivePath);
      for (const entry of zip.getEntries()) {
        const name = strip > 0 ? entry.entryName.split('/').slice(strip).join('/') : entry.entryName;
        if (name === '') continue;

        const target = safeExtractTarget(destPath, name);

        if (entry.isDirectory) {
          await fs.mkdir(target, { recursive: true });
          continue;
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, entry.getData());
      }
    },

    async writeFile(relative, contents) {
      const target = resolve(relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents, 'utf8');
    },

    async readFile(relative) {
      try {
        return await fs.readFile(resolve(relative), 'utf8');
      } catch {
        return null;
      }
    },

    async exists(relative) {
      try {
        await fs.access(resolve(relative));
        return true;
      } catch {
        return false;
      }
    },

    async mkdir(relative) {
      await fs.mkdir(resolve(relative), { recursive: true });
    },

    async remove(relative) {
      await fs.rm(resolve(relative), { recursive: true, force: true });
    },

    async rename(fromRelative, toRelative) {
      // Both ends resolved against the server directory, like everything else
      // here: a loader jar's name comes from an upstream installer, so it is
      // no more trustworthy than any other outside input.
      await fs.rename(resolve(fromRelative), resolve(toRelative));
    },

    async listDir(relative) {
      try {
        return await fs.readdir(resolve(relative));
      } catch {
        return [];
      }
    },

    async runInContainer(spec) {
      logger.info({ image: spec.image, dataPath }, 'running install container');
      return runtime.runOnce({
        image: spec.image,
        command: spec.command,
        dataPath,
        env: spec.env ?? {},
        timeoutMs: spec.timeoutMs ?? 30 * 60 * 1000,
        onLine: options.onLine ?? (() => undefined),
      });
    },
  };
}

/** Recursively sums a directory's size. Used for disk quota enforcement. */
export async function directorySize(root: string): Promise<number> {
  let total = 0;
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      // Symlinks are not followed: a link into /proc would otherwise make the
      // walk hang or the total meaningless.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      const stat = await fs.stat(full).catch(() => null);
      if (stat) total += stat.size;
    }
  }

  return total;
}
