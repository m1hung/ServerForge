import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { openPromise } from 'yauzl';
import { safeExtractTarget } from '@serverforge/core';
import { serverFile } from './server-files.js';
import { requireFreeSpace } from './storage-space.js';

export async function extractZip(archive: string, root: string, strip = 0): Promise<void> {
  if (!Number.isInteger(strip) || strip < 0) throw new Error('Invalid ZIP strip count.');
  const zip = await openPromise(archive, { lazyEntries: true });
  let expanded = 0;
  let count = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      // Validate before stripping so a malicious prefix cannot disappear.
      safeExtractTarget(root, entry.fileName);
      const mode = entry.externalFileAttributes >>> 16;
      const kind = mode & 0o170000;
      if (kind && kind !== 0o100000 && kind !== 0o040000) {
        throw new Error('ZIP archives cannot contain links or special files.');
      }
      expanded += entry.uncompressedSize;
      if (++count > 50000 || expanded > 8 * 1024 ** 3) {
        throw new Error('ZIP exceeds the 8 GiB or 50,000 file extraction limit.');
      }
      const relative = entry.fileName.split('/').slice(strip).join('/');
      if (!relative) continue;
      const target = await serverFile(root, relative);
      if (entry.fileName.endsWith('/')) {
        await fs.mkdir(target, { recursive: true });
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await requireFreeSpace(root, entry.uncompressedSize);
      const input = await zip.openReadStreamPromise(entry);
      // Preserve executable bits for Linux server packs, never setuid/setgid.
      await pipeline(input, createWriteStream(target, { mode: mode & 0o111 ? 0o755 : 0o644 }));
      await fs.chmod(target, mode & 0o111 ? 0o755 : 0o644);
    }
  } finally {
    zip.close();
  }
}
