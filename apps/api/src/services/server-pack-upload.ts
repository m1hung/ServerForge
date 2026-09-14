import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import { openPromise } from 'yauzl';
import { badRequest } from '@serverforge/core';

export const SERVER_PACK_UPLOAD_LIMIT = 2 * 1024 ** 3;

/** Stream straight into the new server folder; never buffer a pack in memory. */
export async function saveServerPack(root: string, upload: MultipartFile) {
  if (upload.fieldname !== 'pack' || !/\.zip$/i.test(upload.filename))
    throw badRequest('Choose a server pack .zip file.');
  const directory = path.join(root, '.serverforge');
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, 'pack.zip');
  await pipeline(upload.file, createWriteStream(target, { flags: 'wx' }));
  const size = (await fs.stat(target)).size;
  if (upload.file.truncated || size > SERVER_PACK_UPLOAD_LIMIT)
    throw badRequest('Server pack uploads are limited to 2 GiB.');
  if (!size) throw badRequest('That ZIP file is empty.');
  const zip = await openPromise(target, { lazyEntries: true }).catch(() => {
    throw badRequest('That file is not a valid ZIP archive. Download the server pack again.');
  });
  zip.close();
  if (!zip.entryCount) throw badRequest('That ZIP archive contains no files.');
}
