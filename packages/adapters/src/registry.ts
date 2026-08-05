import { notFound } from '@serverforge/core';
import type { GameAdapter, GameVariant } from './types.js';
import { minecraftAdapter } from './minecraft/index.js';
import { palworldAdapter } from './palworld/index.js';
import { valheimAdapter } from './valheim/index.js';

/**
 * The adapter registry.
 *
 * This array is the complete list of games the platform supports. Adding one
 * is: write the adapter, import it, push it here. No other file changes.
 */
const ADAPTERS: GameAdapter[] = [minecraftAdapter, palworldAdapter, valheimAdapter];

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
