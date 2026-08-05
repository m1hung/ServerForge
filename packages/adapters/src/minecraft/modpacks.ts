import { fetchJson } from '@serverforge/core';
import type { InstallReporter, InstallTools, ServerContext } from '../types.js';
import {
  resolveFabricDownload,
  resolveForgeDownload,
  resolveNeoForgeDownload,
  resolveVanillaDownload,
} from './versions.js';

/**
 * Modrinth modpack installation.
 *
 * A `.mrpack` is a zip containing `modrinth.index.json`, which lists every
 * file with its download URLs and hashes, plus `overrides/` (config for both
 * sides) and `server-overrides/` (server-only config).
 *
 * The whole point of this variant is that the user does not need to know
 * which loader the pack uses — the index tells us, and we install it.
 */

const MODRINTH_API = 'https://api.modrinth.com/v2';

interface ModrinthVersion {
  id: string;
  name: string;
  version_number: string;
  version_type: 'release' | 'beta' | 'alpha';
  game_versions: string[];
  loaders: string[];
  date_published: string;
  files: { url: string; filename: string; primary: boolean; hashes: { sha1?: string; sha512?: string } }[];
}

interface MrpackIndex {
  formatVersion: number;
  name: string;
  versionId: string;
  files: {
    path: string;
    hashes: { sha1?: string; sha512?: string };
    env?: { client: 'required' | 'optional' | 'unsupported'; server: 'required' | 'optional' | 'unsupported' };
    downloads: string[];
    fileSize?: number;
  }[];
  dependencies: Record<string, string>;
}

function userAgent(): string {
  return process.env.MODRINTH_USER_AGENT ?? 'serverforge/0.1.0 (self-hosted)';
}

/** Accepts a full Modrinth URL, a slug, or a project id. */
export function normalizeModrinthProject(input: string): string {
  return parseModrinthRef(input).project;
}

/**
 * Pulls the project slug and optional version id out of a Modrinth link.
 *
 * Users almost always paste the address-bar URL, often including
 * `/version/<id>`. Treating that whole string as the project slug made the
 * lookup fail; empty project fields made install fail earlier still.
 */
export function parseModrinthRef(input: string): { project: string; versionId?: string } {
  const trimmed = input.trim();
  const match =
    /modrinth\.com\/(?:modpack|mod|plugin|datapack)\/([^/?#]+)(?:\/version\/([^/?#]+))?/i.exec(
      trimmed,
    );
  if (!match?.[1]) return { project: trimmed };
  return {
    project: match[1],
    ...(match[2] ? { versionId: match[2] } : {}),
  };
}

export async function listModrinthPackVersions(project: string): Promise<ModrinthVersion[]> {
  const slug = normalizeModrinthProject(project);
  return fetchJson<ModrinthVersion[]>(`${MODRINTH_API}/project/${encodeURIComponent(slug)}/version`, {
    service: 'Modrinth',
    headers: { 'User-Agent': userAgent() },
  });
}

export async function installModrinthPack(
  ctx: ServerContext,
  tools: InstallTools,
  report: InstallReporter,
): Promise<void> {
  const projectInput = String(ctx.settings.modpack_project ?? '').trim();
  if (projectInput === '') {
    throw new Error(
      'No modpack was selected. Open Settings, paste a Modrinth modpack link, then reinstall.',
    );
  }

  const parsed = parseModrinthRef(projectInput);
  const requestedVersion =
    String(ctx.settings.modpack_version ?? '').trim() || parsed.versionId || '';

  await report.phase('resolving_version', 'Looking up the modpack on Modrinth…', 10);
  const versions = await listModrinthPackVersions(parsed.project);
  if (versions.length === 0) {
    throw new Error(`Modrinth has no downloadable versions for "${parsed.project}".`);
  }

  const version =
    requestedVersion === '' || requestedVersion === 'latest'
      ? (versions.find((v) => v.version_type === 'release') ?? versions[0]!)
      : versions.find(
          (v) => v.id === requestedVersion || v.version_number === requestedVersion,
        );

  if (!version) throw new Error(`Version "${requestedVersion}" was not found for this modpack.`);

  const packFile = version.files.find((f) => f.primary) ?? version.files[0];
  if (!packFile) throw new Error('That modpack version has no downloadable file.');

  await report.log(`Installing ${version.name} (${version.version_number})`);

  await report.phase('downloading', `Downloading ${packFile.filename}…`, 20);
  await tools.download(packFile.url, '.serverforge/pack.mrpack', {
    headers: { 'User-Agent': userAgent() },
    ...(packFile.hashes.sha512 ? { sha512: packFile.hashes.sha512 } : {}),
  });

  await report.phase('extracting', 'Unpacking the modpack…', 35);
  await tools.unzip('.serverforge/pack.mrpack', '.serverforge/pack');

  const indexRaw = await tools.readFile('.serverforge/pack/modrinth.index.json');
  if (!indexRaw) throw new Error('This modpack is missing its index file and cannot be installed.');
  const index = JSON.parse(indexRaw) as MrpackIndex;

  // ── 1. Install the loader the pack asks for ─────────────────────────────
  const minecraft = index.dependencies.minecraft;
  if (!minecraft) throw new Error('The modpack did not state which Minecraft version it needs.');

  await report.phase('downloading', `Installing Minecraft ${minecraft} and the mod loader…`, 45);
  await installLoaderForPack(ctx, tools, index.dependencies, minecraft);

  // ── 2. Download every server-side file ──────────────────────────────────
  const wanted = index.files.filter((file) => file.env?.server !== 'unsupported');
  let done = 0;

  for (const file of wanted) {
    const url = file.downloads[0];
    if (!url) continue;
    await tools.download(url, file.path, {
      headers: { 'User-Agent': userAgent() },
      ...(file.hashes.sha512 ? { sha512: file.hashes.sha512 } : {}),
      ...(file.hashes.sha1 ? { sha1: file.hashes.sha1 } : {}),
    });
    done++;
    if (done % 5 === 0 || done === wanted.length) {
      const percent = 45 + Math.round((done / wanted.length) * 35);
      await report.phase('downloading', `Downloaded ${done} of ${wanted.length} mods…`, percent);
    }
  }

  // ── 3. Apply overrides (server-specific last, so it wins) ───────────────
  await report.phase('configuring', 'Applying the pack configuration…', 85);
  for (const dir of ['overrides', 'server-overrides']) {
    if (await tools.exists(`.serverforge/pack/${dir}`)) {
      await tools.unzip(`.serverforge/pack/${dir}`, '.', { strip: 0 });
    }
  }

  await tools.remove('.serverforge/pack.mrpack');
  await report.log(`Installed ${wanted.length} server-side files from ${index.name}.`);
}

/**
 * CurseForge-style (and similar) server packs: a zip that already contains
 * the loader, mods and configs. The wizard stages the zip or provides a URL
 * before the server is created.
 */
export async function installCustomPack(
  ctx: ServerContext,
  tools: InstallTools,
  report: InstallReporter,
): Promise<void> {
  const stagedRelative = '.serverforge/pack.zip';
  const zipUrl = String(ctx.settings.modpack_zip_url ?? '').trim();
  const hasStaged = await tools.exists(stagedRelative);

  if (!hasStaged && !zipUrl) {
    throw new Error(
      'No modpack was provided. Go back to the wizard, upload the server pack .zip (or paste a download link), then create the server.',
    );
  }

  if (!hasStaged && zipUrl) {
    await report.phase('downloading', 'Downloading your server pack…', 20);
    await tools.download(zipUrl, stagedRelative);
  } else {
    await report.phase('downloading', 'Using the server pack you uploaded…', 20);
  }

  await report.phase('extracting', 'Unpacking the server pack…', 40);
  await tools.unzip(stagedRelative, '.serverforge/extracted');
  await flattenExtractedPack(tools, '.serverforge/extracted', '.');
  await tools.remove(stagedRelative);
  await tools.remove('.serverforge/extracted');

  // Many Forge/NeoForge server packs still ship the installer jar; run it when
  // present so startup can use a normal server.jar entry point.
  const installer = (await tools.listDir('.')).find((name) =>
    /^(forge|neoforge)-.*-installer\.jar$/i.test(name),
  );
  if (installer) {
    await report.phase('configuring', 'Running the mod loader installer…', 70);
    await runInstaller(ctx, tools, installer);
  }

  const hasServerJar =
    (await tools.exists('server.jar')) ||
    (await tools.listDir('.')).some((name) => /^(fabric|minecraft)?server.*\.jar$/i.test(name));

  if (!hasServerJar && !installer) {
    // Still useful: some packs use run.sh / start scripts. Leave the files
    // in place and let the operator adjust startup if needed.
    await report.log(
      'Pack unpacked. No server.jar was found — if Start fails, open Files and check the pack layout.',
    );
  }

  await report.phase('finalizing', 'Server pack ready.', 95);
}

/** If the zip wrapped everything in one folder, lift that folder's contents up. */
async function flattenExtractedPack(
  tools: InstallTools,
  extractedRelative: string,
  destRelative: string,
): Promise<void> {
  const top = await tools.listDir(extractedRelative);
  const meaningful = top.filter((name) => name !== '__MACOSX' && name !== '.DS_Store');

  let source = extractedRelative;
  if (meaningful.length === 1) {
    const only = meaningful[0]!;
    // Heuristic: a single directory that is not a jar/zip is a wrapper folder.
    if (!/\.(jar|zip|mrpack)$/i.test(only)) {
      source = `${extractedRelative}/${only}`;
    }
  }

  // tools.unzip also copies directories when the "archive" path is a folder.
  await tools.unzip(source, destRelative);
}

async function installLoaderForPack(
  ctx: ServerContext,
  tools: InstallTools,
  dependencies: Record<string, string>,
  minecraft: string,
): Promise<void> {
  if (dependencies['fabric-loader']) {
    const download = await resolveFabricDownload(minecraft, dependencies['fabric-loader']);
    await tools.download(download.url, download.fileName);
    return;
  }

  if (dependencies['neoforge']) {
    const download = await resolveNeoForgeDownload(minecraft, dependencies['neoforge']);
    await tools.download(download.url, download.fileName);
    await runInstaller(ctx, tools, download.fileName);
    return;
  }

  if (dependencies['forge']) {
    const download = await resolveForgeDownload(minecraft, dependencies['forge']);
    await tools.download(download.url, download.fileName);
    await runInstaller(ctx, tools, download.fileName);
    return;
  }

  if (dependencies['quilt-loader']) {
    throw new Error(
      'This pack uses the Quilt loader, which is not supported yet. Ask for a Fabric or NeoForge version of the pack.',
    );
  }

  // A pack with no loader is a vanilla-plus-datapacks pack.
  const download = await resolveVanillaDownload(minecraft);
  await tools.download(download.url, download.fileName, { ...(download.sha1 ? { sha1: download.sha1 } : {}) });
}

async function runInstaller(
  ctx: ServerContext,
  tools: InstallTools,
  installerJar: string,
): Promise<void> {
  const result = await tools.runInContainer({
    image: 'eclipse-temurin:21-jre-jammy',
    command: ['java', '-jar', installerJar, '--installServer'],
    timeoutMs: 10 * 60 * 1000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`The mod loader installer failed.\n${result.output.slice(-4000)}`);
  }
  await tools.remove(installerJar);
}
