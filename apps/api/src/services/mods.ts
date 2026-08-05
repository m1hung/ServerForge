import fs from 'node:fs/promises';
import path from 'node:path';
import { badRequest, conflict, fetchJson, resolveWithin, type ModInstallInput } from '@serverforge/core';
import { getAdapter } from '@serverforge/adapters';
import { prisma } from '@serverforge/db';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { localDataPath } from '../lib/storage-paths.js';
import { getRuntime } from '../runtime/index.js';
import { createInstallTools } from './install-tools.js';

/**
 * Mod and plugin management.
 *
 * Modrinth is a first-class browse-and-install source because its API is open
 * and its licensing permits it. CurseForge requires the operator's own API key
 * under their terms, so it is opt-in and degrades to a clear explanation plus
 * a manual upload path rather than pretending to be broken.
 */

const MODRINTH_API = 'https://api.modrinth.com/v2';
const CURSEFORGE_API = 'https://api.curseforge.com/v1';
/** CurseForge's game id for Minecraft. */
const CF_MINECRAFT = 432;

const DISABLED_SUFFIX = '.disabled';

interface ModrinthSearchHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  downloads: number;
  icon_url: string | null;
  categories: string[];
  versions: string[];
}

interface ModrinthVersionFile {
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  hashes: { sha1?: string; sha512?: string };
}

interface ModrinthVersion {
  id: string;
  name: string;
  version_number: string;
  version_type: string;
  game_versions: string[];
  loaders: string[];
  date_published: string;
  files: ModrinthVersionFile[];
}

function modrinthHeaders(): Record<string, string> {
  return { 'User-Agent': config.MODRINTH_USER_AGENT };
}

/** Maps our variant ids to the loader facet each registry expects. */
export function loaderFacet(variantId: string): string | null {
  switch (variantId) {
    case 'paper':
    case 'purpur':
      return 'paper';
    case 'fabric':
    case 'modrinth-modpack':
      return 'fabric';
    case 'forge':
    case 'custom-modpack':
      return 'forge';
    case 'neoforge':
      return 'neoforge';
    default:
      return null;
  }
}

export async function searchModrinth(input: {
  query: string;
  variantId: string;
  gameVersion?: string;
  offset?: number;
}): Promise<{ hits: ModrinthSearchHit[]; total: number }> {
  const loader = loaderFacet(input.variantId);
  const projectType = loader === 'paper' ? 'plugin' : 'mod';

  const facets: string[][] = [[`project_type:${projectType}`]];
  if (loader) facets.push([`categories:${loader}`]);
  if (input.gameVersion) facets.push([`versions:${input.gameVersion}`]);

  const url = new URL(`${MODRINTH_API}/search`);
  url.searchParams.set('query', input.query);
  url.searchParams.set('limit', '20');
  url.searchParams.set('offset', String(input.offset ?? 0));
  url.searchParams.set('index', 'relevance');
  url.searchParams.set('facets', JSON.stringify(facets));

  const result = await fetchJson<{ hits: ModrinthSearchHit[]; total_hits: number }>(url.toString(), {
    service: 'Modrinth',
    headers: modrinthHeaders(),
  });

  return { hits: result.hits, total: result.total_hits };
}

export async function modrinthVersions(
  projectId: string,
  input: { variantId: string; gameVersion?: string },
): Promise<ModrinthVersion[]> {
  const loader = loaderFacet(input.variantId);
  const url = new URL(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version`);
  if (loader) url.searchParams.set('loaders', JSON.stringify([loader]));
  if (input.gameVersion) url.searchParams.set('game_versions', JSON.stringify([input.gameVersion]));

  return fetchJson<ModrinthVersion[]>(url.toString(), {
    service: 'Modrinth',
    headers: modrinthHeaders(),
  });
}

export async function searchCurseForge(input: {
  query: string;
  variantId: string;
  gameVersion?: string;
}) {
  if (!config.CURSEFORGE_API_KEY) {
    throw conflict(
      'CurseForge browsing is not set up on this panel.',
      'CurseForge requires each host to use their own API key. An administrator can add one in Settings, or you can download the mod from curseforge.com and upload the .jar in the Files tab.',
    );
  }

  const loader = loaderFacet(input.variantId);
  const url = new URL(`${CURSEFORGE_API}/mods/search`);
  url.searchParams.set('gameId', String(CF_MINECRAFT));
  url.searchParams.set('searchFilter', input.query);
  url.searchParams.set('pageSize', '20');
  if (input.gameVersion) url.searchParams.set('gameVersion', input.gameVersion);
  if (loader) url.searchParams.set('modLoaderType', String(curseForgeLoaderId(loader)));

  return fetchJson<{ data: unknown[] }>(url.toString(), {
    service: 'CurseForge',
    headers: { 'x-api-key': config.CURSEFORGE_API_KEY, Accept: 'application/json' },
  });
}

function curseForgeLoaderId(loader: string): number {
  // CurseForge's numeric loader enum.
  switch (loader) {
    case 'forge':
      return 1;
    case 'fabric':
      return 4;
    case 'neoforge':
      return 6;
    default:
      return 0;
  }
}

// ────────────────────────────────────────────────────────── installed mods ──

export interface InstalledModEntry {
  fileName: string;
  name: string;
  sizeBytes: number;
  enabled: boolean;
  source: string;
  projectId: string | null;
  versionId: string | null;
  versionName: string | null;
  updateAvailable: boolean;
  installedAt: Date | null;
}

/**
 * Lists what is actually on disk, joined with what we know about it.
 *
 * Disk is the source of truth on purpose: people drop jars in through SFTP
 * and the file manager, and a mod list that disagrees with the mods folder
 * is worse than no mod list at all.
 */
export async function listInstalledMods(server: {
  id: string;
  dataPath: string;
  gameId: string;
  variantId: string;
}): Promise<InstalledModEntry[]> {
  const adapter = getAdapter(server.gameId);
  const modDir = adapter.modDirectory?.(server.variantId);
  if (!modDir) return [];

  const absolute = resolveWithin(localDataPath(server.dataPath), modDir);
  const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => []);
  const known = await prisma.installedMod.findMany({ where: { serverId: server.id } });

  const results: InstalledModEntry[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const isDisabled = entry.name.endsWith(DISABLED_SUFFIX);
    const baseName = isDisabled ? entry.name.slice(0, -DISABLED_SUFFIX.length) : entry.name;
    if (!/\.(jar|pak|zip)$/i.test(baseName)) continue;

    const stat = await fs.stat(path.join(absolute, entry.name)).catch(() => null);
    const record = known.find((k) => k.fileName === baseName);

    results.push({
      fileName: baseName,
      name: record?.name ?? prettyModName(baseName),
      sizeBytes: stat?.size ?? 0,
      enabled: !isDisabled,
      source: record?.source ?? 'upload',
      projectId: record?.projectId ?? null,
      versionId: record?.versionId ?? null,
      versionName: record?.versionName ?? null,
      updateAvailable: record?.updateAvailable ?? false,
      installedAt: record?.installedAt ?? null,
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export async function installMod(
  server: { id: string; dataPath: string; gameId: string; variantId: string; node: { id: string; transport: string; agentUrl: string | null } },
  input: ModInstallInput,
): Promise<{ fileName: string }> {
  const adapter = getAdapter(server.gameId);
  const modDir = adapter.modDirectory?.(server.variantId);
  if (!modDir) throw conflict('This kind of server does not support mods or plugins.');

  const tools = createInstallTools({
    dataPath: localDataPath(server.dataPath),
    runtime: getRuntime(server.node),
  });

  let fileName: string;
  let downloadUrl: string;
  let displayName: string;
  let versionName: string | null = null;
  let headers: Record<string, string> = {};
  let sha1: string | undefined;

  switch (input.source) {
    case 'modrinth': {
      if (!input.projectId) throw badRequest('Choose a mod to install.');
      const versions = await modrinthVersions(input.projectId, { variantId: server.variantId });
      const version = input.versionId
        ? versions.find((v) => v.id === input.versionId)
        : versions[0];
      if (!version) {
        throw conflict(
          'That mod has no version compatible with this server.',
          'Check that the mod supports your Minecraft version and mod loader.',
        );
      }
      const file = version.files.find((f) => f.primary) ?? version.files[0];
      if (!file) throw conflict('That mod version has no downloadable file.');

      fileName = file.filename;
      downloadUrl = file.url;
      displayName = version.name;
      versionName = version.version_number;
      headers = modrinthHeaders();
      if (file.hashes.sha1) sha1 = file.hashes.sha1;
      break;
    }

    case 'url': {
      if (!input.url) throw badRequest('Enter a download link.');
      const parsed = new URL(input.url);
      if (parsed.protocol !== 'https:') throw badRequest('Only https links are allowed.');
      fileName = path.basename(parsed.pathname) || 'mod.jar';
      downloadUrl = input.url;
      displayName = prettyModName(fileName);
      break;
    }

    case 'curseforge':
      throw conflict(
        'Installing directly from CurseForge is not available on this panel.',
        'Download the file from curseforge.com and upload it in the Files tab — it works exactly the same once it is in the mods folder.',
      );

    case 'upload':
    default:
      throw badRequest('Upload the file through the Files tab instead.');
  }

  if (!/\.(jar|zip|pak)$/i.test(fileName)) {
    throw badRequest('That link does not point at a mod file.');
  }

  const relativePath = path.posix.join(modDir, path.basename(fileName));
  const bytes = await tools.download(downloadUrl, relativePath, {
    headers,
    ...(sha1 ? { sha1 } : {}),
  });

  await prisma.installedMod.upsert({
    where: { serverId_fileName: { serverId: server.id, fileName: path.basename(fileName) } },
    create: {
      serverId: server.id,
      source: input.source,
      projectId: input.projectId ?? null,
      versionId: input.versionId ?? null,
      name: displayName,
      fileName: path.basename(fileName),
      kind: input.kind,
      sizeBytes: BigInt(bytes),
      versionName,
    },
    update: {
      versionId: input.versionId ?? null,
      name: displayName,
      sizeBytes: BigInt(bytes),
      versionName,
      updateAvailable: false,
      installedAt: new Date(),
    },
  });

  logger.info({ serverId: server.id, fileName }, 'installed mod');
  return { fileName: path.basename(fileName) };
}

/**
 * Enable/disable by renaming rather than deleting.
 *
 * Every mod loader ignores files ending in `.disabled`, so this is the
 * standard trick — and it means "turn this off to test something" does not
 * cost the user their config or their download.
 */
export async function setModEnabled(
  server: { dataPath: string; gameId: string; variantId: string },
  fileName: string,
  enabled: boolean,
): Promise<void> {
  const adapter = getAdapter(server.gameId);
  const modDir = adapter.modDirectory?.(server.variantId);
  if (!modDir) throw conflict('This kind of server does not support mods.');

  const base = path.basename(fileName);
  const enabledPath = resolveWithin(localDataPath(server.dataPath), path.posix.join(modDir, base));
  const disabledPath = `${enabledPath}${DISABLED_SUFFIX}`;

  const from = enabled ? disabledPath : enabledPath;
  const to = enabled ? enabledPath : disabledPath;

  await fs.rename(from, to).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw conflict(`${base} is already ${enabled ? 'enabled' : 'disabled'}.`);
    }
    throw error;
  });
}

export async function removeMod(
  server: { id: string; dataPath: string; gameId: string; variantId: string },
  fileName: string,
): Promise<void> {
  const adapter = getAdapter(server.gameId);
  const modDir = adapter.modDirectory?.(server.variantId);
  if (!modDir) throw conflict('This kind of server does not support mods.');

  const base = path.basename(fileName);
  const target = resolveWithin(localDataPath(server.dataPath), path.posix.join(modDir, base));

  await fs.rm(target, { force: true });
  await fs.rm(`${target}${DISABLED_SUFFIX}`, { force: true });
  await prisma.installedMod.deleteMany({ where: { serverId: server.id, fileName: base } });
}

/**
 * Compares installed Modrinth mods against the latest compatible release.
 * Returns how many were flagged as having an update.
 */
export async function checkModUpdates(server: {
  id: string;
  variantId: string;
  version: string;
}): Promise<{ checked: number; updates: number }> {
  const known = await prisma.installedMod.findMany({
    where: { serverId: server.id, source: 'modrinth', projectId: { not: null } },
  });

  let updates = 0;
  for (const mod of known) {
    if (!mod.projectId) continue;
    try {
      const versions = await modrinthVersions(mod.projectId, {
        variantId: server.variantId,
        gameVersion: server.version,
      });
      const latest = versions[0];
      if (!latest) {
        await prisma.installedMod.update({
          where: { id: mod.id },
          data: { updateAvailable: false },
        });
        continue;
      }
      const available = Boolean(mod.versionId && latest.id !== mod.versionId);
      if (available) updates += 1;
      await prisma.installedMod.update({
        where: { id: mod.id },
        data: { updateAvailable: available },
      });
    } catch (error) {
      logger.warn({ error, projectId: mod.projectId }, 'mod update check failed');
    }
  }

  return { checked: known.length, updates };
}

/** Reinstalls a Modrinth mod at the newest compatible version. */
export async function updateMod(
  server: {
    id: string;
    dataPath: string;
    gameId: string;
    variantId: string;
    version: string;
    node: { id: string; transport: string; agentUrl: string | null };
  },
  fileName: string,
): Promise<{ fileName: string }> {
  const base = path.basename(fileName);
  const record = await prisma.installedMod.findUnique({
    where: { serverId_fileName: { serverId: server.id, fileName: base } },
  });
  if (!record?.projectId || record.source !== 'modrinth') {
    throw conflict('Only Modrinth mods can be updated from the panel.');
  }

  // Remove the old file first so a renamed upstream jar does not leave two copies.
  await removeMod(server, base);

  return installMod(server, {
    source: 'modrinth',
    projectId: record.projectId,
    kind: (record.kind as ModInstallInput['kind']) ?? 'mod',
  });
}

/** Turns "sodium-fabric-0.6.5.jar" into "Sodium Fabric". */
function prettyModName(fileName: string): string {
  return (
    fileName
      .replace(/\.(jar|zip|pak)$/i, '')
      .replace(/[-_]?(mc)?\d+(\.\d+)*.*$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase()) || fileName
  );
}
