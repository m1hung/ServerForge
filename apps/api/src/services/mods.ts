import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { badRequest, conflict, isSafeFileName, notFound } from '@serverforge/core';
import { getAdapter } from '@serverforge/adapters';
import { serverFile } from '../lib/server-files.js';

export const MOD_UPLOAD_LIMIT = 256 * 1024 ** 2;

export function modSupport(gameId: string, variantId: string) {
  const adapter = getAdapter(gameId);
  const variant = adapter.variants.find((item) => item.id === variantId);
  const directory = variant?.supportsMods ? (adapter.modDirectory?.(variantId) ?? null) : null;
  const extensions =
    gameId === 'minecraft-java'
      ? ['.jar']
      : gameId === 'valheim'
        ? ['.dll']
        : gameId === 'palworld'
          ? ['.pak']
          : ['.jar', '.dll', '.pak'];
  return { directory, extensions, description: variant?.detail ?? variant?.summary ?? '' };
}

export function requireStopped(state: string): void {
  if (!['offline', 'crashed'].includes(state))
    throw conflict('Stop the server before changing mods.');
}

function checkModName(name: string, extensions: string[], nested = false): void {
  const parts = nested ? name.split('/') : [name];
  const enabledName = name.replace(/\.disabled$/, '');
  if (
    !parts.every(isSafeFileName) ||
    !extensions.includes(path.extname(enabledName).toLowerCase())
  ) {
    throw badRequest(`Choose a ${extensions.join(' or ')} file with a valid filename.`);
  }
}

export async function listMods(root: string, directory: string, extensions: string[]) {
  const base = await serverFile(root, directory);
  const files: { name: string; enabled: boolean; size: number }[] = [];
  let visited = 0;
  async function visit(relative: string) {
    if (++visited > 5000) throw badRequest('The mods folder contains too many entries to display.');
    const target = await serverFile(base, relative);
    const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(target, { withFileTypes: true })) {
        if (!entry.isSymbolicLink())
          await visit(relative ? `${relative}/${entry.name}` : entry.name);
      }
    } else if (
      stat.isFile() &&
      extensions.includes(path.extname(relative.replace(/\.disabled$/, '')).toLowerCase())
    ) {
      files.push({ name: relative, enabled: !relative.endsWith('.disabled'), size: stat.size });
    }
  }
  await visit('');
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

export async function uploadMod(
  root: string,
  directory: string,
  extensions: string[],
  name: string,
  input: Readable & { truncated?: boolean },
) {
  checkModName(name, extensions);
  if (name.endsWith('.disabled'))
    throw badRequest('Upload the original mod file, without .disabled.');
  const base = await serverFile(root, directory);
  await fs.mkdir(base, { recursive: true });
  const dest = await serverFile(base, name);
  const disabled = await serverFile(base, `${name}.disabled`);
  if (await fs.lstat(disabled).catch(() => null))
    throw conflict('A disabled copy of that mod already exists.');
  const staging = await serverFile(root, '.serverforge/uploads');
  await fs.mkdir(staging, { recursive: true });
  const temporary = path.join(staging, randomUUID());
  try {
    await pipeline(input, createWriteStream(temporary, { flags: 'wx' }));
    const size = (await fs.stat(temporary)).size;
    if (input.truncated || size > MOD_UPLOAD_LIMIT)
      throw badRequest('Mods are limited to 256 MiB per file.');
    if (!size) throw badRequest('That file is empty.');
    // An atomic, no-overwrite move on the server volume.
    await fs.link(temporary, dest).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw conflict('A mod with that filename already exists.');
      throw error;
    });
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function setModEnabled(
  root: string,
  directory: string,
  extensions: string[],
  name: string,
  enabled: boolean,
) {
  checkModName(name, extensions, true);
  const base = await serverFile(root, directory);
  const source = await serverFile(base, name);
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat?.isFile()) throw notFound('That mod');
  if (enabled === !name.endsWith('.disabled')) return;
  const target = await serverFile(base, enabled ? name.slice(0, -9) : `${name}.disabled`);
  await fs.link(source, target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw conflict('A mod with that filename already exists.');
    throw error;
  });
  await fs.unlink(source);
}
