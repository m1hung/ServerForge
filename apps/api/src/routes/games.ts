import type { FastifyInstance } from 'fastify';
import { listAdapters, getAdapter, loadManifestsFrom } from '@serverforge/adapters';
import { defaultsFor } from '@serverforge/core';
import { config } from '../lib/config.js';
import { requireUser } from '../plugins/auth.js';

let manifestsLoaded = false;

async function ensureManifests() {
  if (manifestsLoaded) return;
  await loadManifestsFrom(config.gamesRoot).catch(() => undefined);
  manifestsLoaded = true;
}

export async function gameRoutes(app: FastifyInstance) {
  app.get('/games', async (request) => {
    requireUser(request);
    await ensureManifests();
    return {
      games: listAdapters().map((adapter) => ({
        id: adapter.id,
        name: adapter.name,
        summary: adapter.summary,
        icon: adapter.icon,
        variants: adapter.variants,
        reportsPlayers: adapter.reportsPlayers === true,
      })),
    };
  });

  app.get('/games/:gameId', async (request) => {
    requireUser(request);
    await ensureManifests();
    const { gameId } = request.params as { gameId: string };
    const adapter = getAdapter(gameId);
    return {
      id: adapter.id,
      name: adapter.name,
      summary: adapter.summary,
      icon: adapter.icon,
      variants: adapter.variants.map((variant) => ({
        ...variant,
        defaults: adapter.defaultLimits(variant.id),
        ports: adapter.requiredPorts(variant.id),
        eula: adapter.eula?.(variant.id) ?? null,
        schema: adapter.settingsSchema(variant.id),
        settings: defaultsFor(adapter.settingsSchema(variant.id)),
      })),
    };
  });

  app.get('/games/:gameId/versions', async (request) => {
    requireUser(request);
    const { gameId } = request.params as { gameId: string };
    const variantId = String((request.query as { variant?: string }).variant ?? '');
    const adapter = getAdapter(gameId);
    return { versions: await adapter.listVersions(variantId || adapter.variants[0]!.id) };
  });
}
