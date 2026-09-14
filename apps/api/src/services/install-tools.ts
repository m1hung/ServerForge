import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { downloadResponse } from '../lib/download.js';
import { extractZip } from '../lib/extract-zip.js';
import { serverFile } from '../lib/server-files.js';
import { DockerRuntime } from '../runtime/docker.js';
import { PathEscapeError, relativeTo } from '@serverforge/core';
import type { InstallTools } from '@serverforge/adapters';
import { localDataPath } from '../lib/storage-paths.js';

export function installToolsFor(dataPath: string): InstallTools {
  const root = localDataPath(dataPath);

  return {
    async download(url, destRelative, options) {
      const dest = await serverFile(root, destRelative);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const temporary = `${dest}.${randomUUID()}.download`;
      const hashes = (['sha1', 'sha256', 'sha512'] as const)
        .filter((algorithm) => options?.[algorithm])
        .map((algorithm) => ({ hash: createHash(algorithm), expected: options![algorithm]! }));
      let size = 0;
      try {
        const response = await downloadResponse(url, options?.headers);
        await pipeline(
          response,
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              size += chunk.length;
              if (size > 2 * 1024 ** 3) return callback(new Error('Download exceeds 2 GiB.'));
              for (const { hash } of hashes) hash.update(chunk);
              callback(null, chunk);
            },
          }),
          createWriteStream(temporary, { flags: 'wx' }),
        );
        if (hashes.some(({ hash, expected }) => hash.digest('hex') !== expected.toLowerCase())) {
          throw new Error('Downloaded file checksum does not match the publisher.');
        }
        await fs.rename(temporary, dest);
        return size;
      } finally {
        await fs.rm(temporary, { force: true });
      }
    },
    async unzip(archiveRelative, destRelative, options) {
      const archive = await serverFile(root, archiveRelative);
      const dest = await serverFile(root, destRelative);
      await fs.mkdir(dest, { recursive: true });
      if ((await fs.lstat(archive)).isDirectory()) {
        await fs.cp(archive, dest, {
          recursive: true,
          filter: async (source, target) => {
            await serverFile(root, path.relative(root, source));
            await serverFile(root, path.relative(root, target));
            if (path.relative(root, target).split(path.sep)[0] === '.serverforge')
              throw new Error('Server packs cannot overwrite the panel’s .serverforge folder.');
            const stat = await fs.lstat(source);
            if (!stat.isFile() && !stat.isDirectory())
              throw new Error('Server packs cannot contain links or special files.');
            return true;
          },
        });
        return;
      }
      await extractZip(archive, dest, options?.strip);
    },
    async writeFile(relative, contents) {
      const dest = await serverFile(root, relative);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, contents);
    },
    async readFile(relative) {
      try {
        return await fs.readFile(await serverFile(root, relative), 'utf8');
      } catch {
        return null;
      }
    },
    async exists(relative) {
      try {
        await fs.access(await serverFile(root, relative));
        return true;
      } catch {
        return false;
      }
    },
    async mkdir(relative) {
      await fs.mkdir(await serverFile(root, relative), { recursive: true });
    },
    async remove(relative) {
      await fs.rm(await serverFile(root, relative), { recursive: true, force: true });
    },
    async rename(fromRelative, toRelative) {
      await fs.rename(await serverFile(root, fromRelative), await serverFile(root, toRelative));
    },
    async listDir(relative) {
      try {
        return await fs.readdir(await serverFile(root, relative));
      } catch {
        return [];
      }
    },
    async runInContainer(options) {
      const runtime = new DockerRuntime();
      const [installed] = await Promise.allSettled([runtime.runOnce({ ...options, dataPath })]);
      // Root in the throwaway container must not leave files the host API
      // cannot edit. chown runs inside the mount, including on failed jobs.
      const owner = `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`;
      const ownership = await runtime.runOnce({
        image: options.image,
        entrypoint: ['/bin/chown'],
        command: ['-R', owner, '/home/container'],
        dataPath,
        timeoutMs: 60000,
      });
      if (installed.status === 'rejected') throw installed.reason;
      if (ownership.exitCode !== 0) throw new Error('Could not set install file ownership.');
      return installed.value;
    },
  };
}

export { PathEscapeError, relativeTo };
