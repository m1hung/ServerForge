import { fetchJson, fetchText, upstreamFailure } from '@serverforge/core';
import type { VersionInfo } from '../types.js';

/**
 * Version resolution for the Minecraft Java family.
 *
 * Every loader publishes its own metadata endpoint with its own shape. This
 * module normalises them into `VersionInfo` and — crucially — returns the
 * exact download URL, so `install()` never has to guess a URL pattern.
 *
 * Results are memoised for a few minutes: a deploy wizard that lists
 * versions on every keystroke should not hammer PaperMC.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Test seam: lets unit tests run without touching the network cache. */
export function clearVersionCache(): void {
  cache.clear();
}

export interface ResolvedDownload {
  url: string;
  fileName: string;
  sha1?: string;
  sha256?: string;
  sha512?: string;
  /** Jar needs running as an installer rather than as the server itself. */
  installer?: boolean;
}

// ───────────────────────────────────────────────────────────────── vanilla ──

interface MojangManifest {
  latest: { release: string; snapshot: string };
  versions: { id: string; type: string; url: string; releaseTime: string }[];
}

interface MojangVersionMeta {
  downloads: { server?: { url: string; sha1: string; size: number } };
  javaVersion?: { majorVersion: number };
}

const MOJANG_MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

export async function listVanillaVersions(includeSnapshots = false): Promise<VersionInfo[]> {
  const manifest = await cached('mojang:manifest', () =>
    fetchJson<MojangManifest>(MOJANG_MANIFEST, { service: 'Mojang' }),
  );

  return manifest.versions
    .filter((v) => (includeSnapshots ? true : v.type === 'release'))
    .map((v) => ({
      id: v.id,
      label: v.type === 'release' ? v.id : `${v.id} (${v.type})`,
      stable: v.type === 'release',
      releasedAt: v.releaseTime,
    }));
}

export async function resolveVanillaDownload(version: string): Promise<ResolvedDownload> {
  const manifest = await cached('mojang:manifest', () =>
    fetchJson<MojangManifest>(MOJANG_MANIFEST, { service: 'Mojang' }),
  );
  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) throw upstreamFailure('Mojang', new Error(`Unknown Minecraft version ${version}`));

  const meta = await cached(`mojang:meta:${version}`, () =>
    fetchJson<MojangVersionMeta>(entry.url, { service: 'Mojang' }),
  );
  const server = meta.downloads.server;
  if (!server) {
    throw upstreamFailure('Mojang', new Error(`${version} has no downloadable server jar`));
  }
  return { url: server.url, fileName: 'server.jar', sha1: server.sha1 };
}

export async function latestVanilla(): Promise<string> {
  const manifest = await cached('mojang:manifest', () =>
    fetchJson<MojangManifest>(MOJANG_MANIFEST, { service: 'Mojang' }),
  );
  return manifest.latest.release;
}

/** Minimum JRE the vanilla jar requires, used to pick the runtime image. */
export async function requiredJavaMajor(version: string): Promise<number> {
  const manifest = await cached('mojang:manifest', () =>
    fetchJson<MojangManifest>(MOJANG_MANIFEST, { service: 'Mojang' }),
  );
  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) return 21;
  const meta = await cached(`mojang:meta:${version}`, () =>
    fetchJson<MojangVersionMeta>(entry.url, { service: 'Mojang' }),
  );
  return meta.javaVersion?.majorVersion ?? 21;
}

// ──────────────────────────────────────────────────────────── paper/purpur ──

/**
 * PaperMC "Fill" v3.
 *
 * The old `api.papermc.io/v2` endpoints were sunset and now answer 410 for
 * every request, so v2 is not a fallback worth keeping — it is a guaranteed
 * failure. v3 groups versions by minor family and returns a fully-qualified
 * download URL with a SHA-256, which is a better contract: we no longer have
 * to construct download URLs by hand.
 */
const PAPER_API = 'https://fill.papermc.io/v3/projects';

interface PaperProjectResponse {
  project: { id: string; name: string };
  /** e.g. { "1.21": ["1.21.11", "1.21.10", …], "26.2": [...] } — newest first. */
  versions: Record<string, string[]>;
}

interface PaperBuild {
  id: number;
  time: string;
  /** "STABLE" | "ALPHA" | "BETA" | "RECOMMENDED" */
  channel: string;
  downloads: Record<
    string,
    { name: string; url: string; size: number; checksums: { sha256?: string } }
  >;
}

/** v3 keys downloads by purpose; the server jar is the one we want. */
function paperServerDownload(build: PaperBuild) {
  return build.downloads['server:default'] ?? Object.values(build.downloads)[0];
}

export async function listPaperVersions(project: 'paper' | 'velocity' = 'paper'): Promise<VersionInfo[]> {
  const data = await cached(`paper:${project}:versions`, () =>
    fetchJson<PaperProjectResponse>(`${PAPER_API}/${project}`, { service: 'PaperMC' }),
  );

  // Families arrive newest-first, and so do the versions inside each family.
  // Flattening preserves that, which is exactly the order the wizard wants.
  const flat: VersionInfo[] = [];
  for (const versions of Object.values(data.versions)) {
    for (const id of versions) {
      // Release candidates and pre-releases are offered, but not as "stable",
      // so "latest" never silently picks a pre-release.
      const stable = !/-(rc|pre|beta|alpha)/i.test(id);
      flat.push({ id, label: stable ? id : `${id} (pre-release)`, stable });
    }
  }
  return flat;
}

export async function resolvePaperDownload(
  version: string,
  build?: string,
  project: 'paper' | 'velocity' = 'paper',
): Promise<ResolvedDownload & { build: string }> {
  // Asking for a specific build costs a full list; the common case (newest)
  // has a dedicated endpoint that returns exactly one object.
  if (!build) {
    const latest = await cached(`paper:${project}:latest:${version}`, () =>
      fetchJson<PaperBuild>(`${PAPER_API}/${project}/versions/${version}/builds/latest`, {
        service: 'PaperMC',
      }),
    );
    const download = paperServerDownload(latest);
    if (!download) {
      throw upstreamFailure('PaperMC', new Error(`Build ${latest.id} has no server jar`));
    }
    return {
      url: download.url,
      fileName: 'server.jar',
      build: String(latest.id),
      ...(download.checksums.sha256 ? { sha256: download.checksums.sha256 } : {}),
    };
  }

  const builds = await cached(`paper:${project}:builds:${version}`, () =>
    fetchJson<PaperBuild[]>(`${PAPER_API}/${project}/versions/${version}/builds`, {
      service: 'PaperMC',
    }),
  );

  const chosen = builds.find((b) => String(b.id) === String(build));
  if (!chosen) {
    throw upstreamFailure('PaperMC', new Error(`No ${project} build ${build} for ${version}`));
  }

  const download = paperServerDownload(chosen);
  if (!download) {
    throw upstreamFailure('PaperMC', new Error(`Build ${chosen.id} has no server jar`));
  }

  return {
    url: download.url,
    fileName: 'server.jar',
    build: String(chosen.id),
    ...(download.checksums.sha256 ? { sha256: download.checksums.sha256 } : {}),
  };
}

interface PurpurVersionsResponse {
  versions: string[];
}
interface PurpurBuildsResponse {
  builds: { latest: string; all: string[] };
}

const PURPUR_API = 'https://api.purpurmc.org/v2/purpur';

export async function listPurpurVersions(): Promise<VersionInfo[]> {
  const data = await cached('purpur:versions', () =>
    fetchJson<PurpurVersionsResponse>(PURPUR_API, { service: 'Purpur' }),
  );
  return [...data.versions].reverse().map((id) => ({ id, label: id, stable: true }));
}

export async function resolvePurpurDownload(
  version: string,
  build?: string,
): Promise<ResolvedDownload & { build: string }> {
  const data = await cached(`purpur:builds:${version}`, () =>
    fetchJson<{ builds: PurpurBuildsResponse['builds'] }>(`${PURPUR_API}/${version}`, {
      service: 'Purpur',
    }),
  );
  const chosen = build ?? data.builds.latest;
  return {
    url: `${PURPUR_API}/${version}/${chosen}/download`,
    fileName: 'server.jar',
    build: chosen,
  };
}

// ────────────────────────────────────────────────────────────────── fabric ──

interface FabricGameVersion {
  version: string;
  stable: boolean;
}
interface FabricLoaderVersion {
  version: string;
  stable: boolean;
}

const FABRIC_META = 'https://meta.fabricmc.net/v2';

export async function listFabricVersions(): Promise<VersionInfo[]> {
  const games = await cached('fabric:game', () =>
    fetchJson<FabricGameVersion[]>(`${FABRIC_META}/versions/game`, { service: 'Fabric' }),
  );
  return games.filter((g) => g.stable).map((g) => ({ id: g.version, label: g.version, stable: true }));
}

export async function resolveFabricDownload(
  version: string,
  loaderVersion?: string,
): Promise<ResolvedDownload & { build: string }> {
  const loaders = await cached('fabric:loader', () =>
    fetchJson<FabricLoaderVersion[]>(`${FABRIC_META}/versions/loader`, { service: 'Fabric' }),
  );
  const loader = loaderVersion ?? loaders.find((l) => l.stable)?.version ?? loaders[0]?.version;
  if (!loader) throw upstreamFailure('Fabric', new Error('No Fabric loader versions available'));

  const installers = await cached('fabric:installer', () =>
    fetchJson<{ version: string; stable: boolean }[]>(`${FABRIC_META}/versions/installer`, {
      service: 'Fabric',
    }),
  );
  const installer = installers.find((i) => i.stable)?.version ?? installers[0]?.version;
  if (!installer) throw upstreamFailure('Fabric', new Error('No Fabric installer available'));

  // Fabric publishes a ready-to-run launcher jar — no installer step needed.
  return {
    url: `${FABRIC_META}/versions/loader/${version}/${loader}/${installer}/server/jar`,
    fileName: 'server.jar',
    build: loader,
  };
}

// ───────────────────────────────────────────────────────────────── neoforge ──

const NEOFORGE_MAVEN =
  'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';

export async function listNeoForgeVersions(): Promise<VersionInfo[]> {
  const data = await cached('neoforge:versions', () =>
    fetchJson<{ versions: string[] }>(NEOFORGE_MAVEN, { service: 'NeoForge' }),
  );
  // NeoForge versions look like "21.4.30-beta" and map to Minecraft 1.21.4.
  const byGame = new Map<string, string[]>();
  for (const raw of data.versions) {
    const game = neoForgeToMinecraft(raw);
    if (!game) continue;
    const bucket = byGame.get(game) ?? [];
    bucket.push(raw);
    byGame.set(game, bucket);
  }
  return [...byGame.entries()]
    .sort((a, b) => compareMinecraftVersions(b[0], a[0]))
    .map(([game, builds]) => ({
      id: game,
      label: game,
      build: builds[builds.length - 1],
      stable: builds.some((b) => !b.includes('beta')),
    }));
}

export function neoForgeToMinecraft(neoVersion: string): string | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(neoVersion);
  if (!match) return null;
  const [, major, minor, patch] = match;
  return patch === '0' ? `1.${major}.${minor}` : `1.${major}.${minor}`;
}

export async function resolveNeoForgeDownload(
  version: string,
  build?: string,
): Promise<ResolvedDownload & { build: string }> {
  const data = await cached('neoforge:versions', () =>
    fetchJson<{ versions: string[] }>(NEOFORGE_MAVEN, { service: 'NeoForge' }),
  );
  const matching = data.versions.filter((v) => neoForgeToMinecraft(v) === version);
  const chosen =
    build ?? matching.filter((v) => !v.includes('beta')).pop() ?? matching[matching.length - 1];
  if (!chosen) {
    throw upstreamFailure('NeoForge', new Error(`No NeoForge build for Minecraft ${version}`));
  }
  return {
    url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${chosen}/neoforge-${chosen}-installer.jar`,
    fileName: 'neoforge-installer.jar',
    installer: true,
    build: chosen,
  };
}

// ─────────────────────────────────────────────────────────────────── forge ──

const FORGE_PROMOTIONS =
  'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';

interface ForgePromotions {
  promos: Record<string, string>;
}

export async function listForgeVersions(): Promise<VersionInfo[]> {
  const data = await cached('forge:promotions', () =>
    fetchJson<ForgePromotions>(FORGE_PROMOTIONS, { service: 'Forge' }),
  );

  const byGame = new Map<string, { recommended?: string; latest?: string }>();
  for (const [key, forgeVersion] of Object.entries(data.promos)) {
    const [game, channel] = key.split('-');
    if (!game || !channel) continue;
    const entry = byGame.get(game) ?? {};
    if (channel === 'recommended') entry.recommended = forgeVersion;
    if (channel === 'latest') entry.latest = forgeVersion;
    byGame.set(game, entry);
  }

  return [...byGame.entries()]
    .sort((a, b) => compareMinecraftVersions(b[0], a[0]))
    .map(([game, entry]) => ({
      id: game,
      label: game,
      build: entry.recommended ?? entry.latest,
      stable: Boolean(entry.recommended),
    }));
}

export async function resolveForgeDownload(
  version: string,
  build?: string,
): Promise<ResolvedDownload & { build: string }> {
  const data = await cached('forge:promotions', () =>
    fetchJson<ForgePromotions>(FORGE_PROMOTIONS, { service: 'Forge' }),
  );
  const chosen =
    build ?? data.promos[`${version}-recommended`] ?? data.promos[`${version}-latest`];
  if (!chosen) {
    throw upstreamFailure('Forge', new Error(`No Forge build for Minecraft ${version}`));
  }
  // Forge's maven path repeats the Minecraft version, and some old builds
  // append the branch — those are rare enough to surface as a clear error.
  const full = `${version}-${chosen}`;
  return {
    url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`,
    fileName: 'forge-installer.jar',
    installer: true,
    build: chosen,
  };
}

// ────────────────────────────────────────────────────────────────── helpers ──

/** Semantic-ish comparison for "1.21.4" style strings. Snapshots sort low. */
export function compareMinecraftVersions(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Fetches a plain-text upstream file (used by modpack manifests). */
export async function fetchUpstreamText(url: string, service: string): Promise<string> {
  return fetchText(url, { service });
}
