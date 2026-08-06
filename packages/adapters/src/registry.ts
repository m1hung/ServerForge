import { notFound } from '@serverforge/core';
import type { GameAdapter, GameVariant } from './types.js';
import { compileManifest } from './manifest/compile.js';
import { valheimManifest } from './manifest/games/valheim.js';
import { minecraftAdapter } from './minecraft/index.js';
import { palworldAdapter } from './palworld/index.js';

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
 */
const ADAPTERS: GameAdapter[] = [
  minecraftAdapter,
  palworldAdapter,
  compileManifest(valheimManifest),
];

const byId = new Map(ADAPTERS.map((adapter) => [adapter.id, adapter]));

export function listAdapters(): GameAdapter[] {
  return [...ADAPTERS];
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
  return ADAPTERS.map((adapter) => ({
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
