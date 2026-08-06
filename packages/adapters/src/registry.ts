import { notFound } from '@serverforge/core';
import type { GameAdapter, GameVariant } from './types.js';
import { compileManifest } from './manifest/compile.js';
import { palworldManifest } from './manifest/games/palworld.js';
import { valheimManifest } from './manifest/games/valheim.js';
import { minecraftAdapter } from './minecraft/index.js';

/**
 * The adapter registry.
 *
 * This array is the complete list of games the platform supports. Games come
 * from one of two places and nothing downstream can tell which:
 *
 *   - A **manifest**: a declarative description compiled into an adapter.
 *     This is the path for the common case — a dedicated server that installs
 *     from Steam, is configured through a file or its command line, and says
 *     something recognisable when it is ready. Adding one is data, not code.
 *
 *   - A **coded adapter**: for games that need real logic. Minecraft resolves
 *     versions against several publishers' APIs and unpacks modpacks;
 *     expressing that as data would mean inventing a programming language.
 *
 * Reach for a manifest first. See docs/adding-a-game.md.
 *
 * Operator-supplied manifests are added to this at startup by the API, from
 * the games directory — see `registerAdapter`.
 */
const BUILT_IN: GameAdapter[] = [
  minecraftAdapter,
  compileManifest(palworldManifest),
  compileManifest(valheimManifest),
];

const builtInIds = new Set(BUILT_IN.map((adapter) => adapter.id));
const byId = new Map(BUILT_IN.map((adapter) => [adapter.id, adapter]));

/**
 * Adds a game discovered at runtime.
 *
 * Registering over an existing id is refused rather than allowed to shadow it.
 * Overriding a built-in has one good use — patching a bug locally without
 * waiting for a release — and one much more likely cause: a file copied from
 * an example whose `id` was never changed. Shadowing silently would make that
 * mistake look like the panel losing a game, and would let a stale local copy
 * quietly outlive every upstream fix. Renaming the id costs one line.
 */
export function registerAdapter(adapter: GameAdapter): void {
  const existing = byId.get(adapter.id);
  if (existing) {
    throw new Error(
      builtInIds.has(adapter.id)
        ? `"${adapter.id}" is already a game this panel ships with. Change the "id" in your manifest to something else — it is what servers are stored against, so it has to be unique.`
        : `Two game manifests both use the id "${adapter.id}". Ids have to be unique; rename one of them.`,
    );
  }
  byId.set(adapter.id, adapter);
}

export function listAdapters(): GameAdapter[] {
  return [...byId.values()];
}

export function getAdapter(gameId: string): GameAdapter {
  const adapter = byId.get(gameId);
  if (!adapter) throw notFound(`The game "${gameId}"`);
  return adapter;
}

export function tryGetAdapter(gameId: string): GameAdapter | undefined {
  return byId.get(gameId);
}

export function getVariant(gameId: string, variantId: string): GameVariant {
  const adapter = getAdapter(gameId);
  const variant = adapter.variants.find((v) => v.id === variantId);
  if (!variant) throw notFound(`The "${variantId}" option for ${adapter.name}`);
  return variant;
}

/**
 * Catalogue shape consumed by the deploy wizard. Kept free of functions so
 * it serialises straight to JSON.
 */
export interface CatalogueEntry {
  id: string;
  name: string;
  summary: string;
  icon: string;
  variants: (GameVariant & {
    defaultLimits: { memoryMib: number; cpuCores: number; diskMib: number };
    requiresEula: boolean;
    eula?: { key: string; label: string; url: string };
  })[];
}

export function buildCatalogue(): CatalogueEntry[] {
  // Built from the live registry rather than the built-in list, so a game
  // added from the games directory shows up in the deploy wizard.
  return listAdapters().map((adapter) => ({
    id: adapter.id,
    name: adapter.name,
    summary: adapter.summary,
    icon: adapter.icon,
    variants: [...adapter.variants]
      .sort((a, b) => a.order - b.order)
      .map((variant) => {
        const eula = adapter.eula?.(variant.id) ?? null;
        return {
          ...variant,
          defaultLimits: adapter.defaultLimits(variant.id),
          requiresEula: Boolean(eula),
          ...(eula ? { eula: { key: eula.key, label: eula.label, url: eula.url } } : {}),
        };
      }),
  }));
}
