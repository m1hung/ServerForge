import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { badRequest, conflict, notFound, relativeTo } from '@serverforge/core';
import { serverFile, openServerFile } from '../lib/server-files.js';
import { extractZip } from '../lib/extract-zip.js';

export const TEXT_LIMIT = 2 * 1024 ** 2;
export const FILE_LIMIT = 2 * 1024 ** 3;
export const digest = (content: Buffer | string) =>
  createHash('sha256').update(content).digest('hex');
export async function managedFile(root: string, relative: string) {
  const target = await serverFile(root, relative);
  if (path.relative(root, target).split(path.sep)[0] === '.serverforge')
    throw badRequest('This folder is managed by ServerForge.');
  return target;
}
export async function listFiles(root: string, relative: string) {
  const target = await managedFile(root, relative);
  const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => {
    throw notFound('That folder');
  });
  if (entries.length > 10000) throw badRequest('This folder has too many entries to display.');
  return {
    path: relativeTo(root, target),
    entries: await Promise.all(
      entries
        .filter((e) => !e.isSymbolicLink() && e.name !== '.serverforge')
        .map(async (e) => {
          const stat = await fs.lstat(path.join(target, e.name));
          return {
            name: e.name,
            directory: e.isDirectory(),
            size: stat.size,
            modified: stat.mtime.toISOString(),
          };
        }),
    ),
  };
}
export async function readTextFile(root: string, relative: string) {
  await managedFile(root, relative);
  const file = await openServerFile(root, relative);
  let content: Buffer;
  try {
    if ((await file.stat()).size > TEXT_LIMIT)
      throw badRequest('The editor supports text files up to 2 MiB. Download larger files instead.');
    const buffer = Buffer.alloc(TEXT_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > TEXT_LIMIT) throw badRequest('The file grew beyond the 2 MiB editor limit. Download it instead.');
    content = buffer.subarray(0, length);
  } finally { await file.close(); }
  if (content.includes(0)) throw badRequest('This is a binary file. Download it instead.');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw badRequest('This file is not UTF-8 text. Download it instead.');
  }
  return { content: content.toString('utf8'), revision: digest(content) };
}
export async function writeTextFile(
  root: string,
  relative: string,
  content: string,
  revision: string,
) {
  if (Buffer.byteLength(content) > TEXT_LIMIT) throw badRequest('Text files are limited to 2 MiB.');
  const target = await managedFile(root, relative);
  const current = await readTextFile(root, relative);
  if (current.revision !== revision)
    throw conflict('This file changed since you opened it. Reload it before saving.');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, {
      flag: 'wx',
      mode: (await fs.stat(target)).mode & 0o777,
    });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return { revision: digest(content) };
}
export async function uploadFile(
  root: string,
  relative: string,
  input: Readable & { truncated?: boolean },
) {
  const target = await managedFile(root, relative);
  const temporary = `${target}.${randomUUID()}.upload`;
  try {
    await pipeline(input, createWriteStream(temporary, { flags: 'wx', mode: 0o644 }));
    if (input.truncated || (await fs.stat(temporary)).size > FILE_LIMIT)
      throw badRequest('Files are limited to 2 GiB.');
    await fs.link(temporary, target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST')
        throw conflict('A file with that name already exists. Rename it first.');
      throw error;
    });
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
export async function unpackFile(root: string, relative: string, destination: string) {
  const archive = await managedFile(root, relative);
  if (!archive.toLowerCase().endsWith('.zip')) throw badRequest('Choose a ZIP archive.');
  const target = await managedFile(root, destination);
  if (await fs.lstat(target).catch(() => null))
    throw conflict('Extract into a new folder to avoid overwriting files.');
  const temporary = `${target}.${randomUUID()}.extract`;
  await fs.mkdir(temporary);
  try {
    await extractZip(archive, temporary);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
export async function fileChecksum(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
