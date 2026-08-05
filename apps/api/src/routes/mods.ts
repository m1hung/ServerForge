import type { FastifyInstance } from 'fastify';
import { badRequest, modInstallSchema } from '@serverforge/core';
import { getAdapter } from '@serverforge/adapters';
import { requireServerAccess } from '../lib/auth.js';
import { recordActivity } from '../lib/events.js';
import { config } from '../config.js';
import {
  installMod,
  listInstalledMods,
  modrinthVersions,
  checkModUpdates,
  removeMod,
  searchModrinth,
  setModEnabled,
  updateMod,
} from '../services/mods.js';

export async function modRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:uid/mods', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.view');

    const adapter = getAdapter(server.gameId);
    const modDir = adapter.modDirectory?.(server.variantId);
    const variant = adapter.variants.find((v) => v.id === server.variantId);

    return {
      supported: Boolean(modDir),
      directory: modDir,
      loader: variant?.modLoader ?? null,
      /** Tells the UI whether to show the browse tab or upload-only guidance. */
      sources: {
        modrinth: Boolean(modDir) && server.gameId === 'minecraft-java',
        curseforge: Boolean(config.CURSEFORGE_API_KEY) && server.gameId === 'minecraft-java',
        upload: Boolean(modDir),
      },
      mods: await listInstalledMods(server),
    };
  });

  app.get('/api/servers/:uid/mods/search', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.mods');
    const query = request.query as { q?: string; offset?: string };

    if (!query.q || query.q.trim().length < 2) {
      throw badRequest('Type at least two characters to search.');
    }

    return searchModrinth({
      query: query.q.trim(),
      variantId: server.variantId,
      gameVersion: server.version,
      offset: Number(query.offset ?? 0),
    });
  });

  app.get('/api/servers/:uid/mods/:projectId/versions', async (request) => {
    const { uid, projectId } = request.params as { uid: string; projectId: string };
    const { server } = await requireServerAccess(request, uid, 'server.mods');

    return {
      versions: await modrinthVersions(projectId, {
        variantId: server.variantId,
        gameVersion: server.version,
      }),
    };
  });

  app.post('/api/servers/:uid/mods', async (request, reply) => {
    const { uid } = request.params as { uid: string };
    const { server, user } = await requireServerAccess(request, uid, 'server.mods');
    const input = modInstallSchema.parse(request.body);

    const result = await installMod(server, input);
    await recordActivity({
      serverId: server.id,
      actorId: user.id,
      actorName: user.displayName,
      action: 'mod.install',
      message: `${user.displayName} installed ${result.fileName}.`,
    });

    return reply.code(201).send({
      ok: true,
      fileName: result.fileName,
      message: 'Installed. Restart the server for it to load.',
      needsRestart: ['running', 'starting'].includes(server.state),
    });
  });

  app.patch('/api/servers/:uid/mods/:fileName', async (request) => {
    const { uid, fileName } = request.params as { uid: string; fileName: string };
    const { server, user } = await requireServerAccess(request, uid, 'server.mods');
    const body = request.body as { enabled?: boolean };

    if (typeof body.enabled !== 'boolean') throw badRequest('Say whether the mod should be on or off.');

    await setModEnabled(server, decodeURIComponent(fileName), body.enabled);
    await recordActivity({
      serverId: server.id,
      actorId: user.id,
      actorName: user.displayName,
      action: 'mod.toggle',
      message: `${user.displayName} ${body.enabled ? 'enabled' : 'disabled'} ${fileName}.`,
    });

    return { ok: true, needsRestart: ['running', 'starting'].includes(server.state) };
  });

  app.delete('/api/servers/:uid/mods/:fileName', async (request) => {
    const { uid, fileName } = request.params as { uid: string; fileName: string };
    const { server, user } = await requireServerAccess(request, uid, 'server.mods');

    await removeMod(server, decodeURIComponent(fileName));
    await recordActivity({
      serverId: server.id,
      actorId: user.id,
      actorName: user.displayName,
      action: 'mod.remove',
      message: `${user.displayName} removed ${fileName}.`,
    });

    return { ok: true, needsRestart: ['running', 'starting'].includes(server.state) };
  });

  app.post('/api/servers/:uid/mods/check-updates', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.mods');
    const result = await checkModUpdates(server);
    return {
      ok: true,
      ...result,
      message:
        result.updates === 0
          ? 'Everything is up to date.'
          : `${result.updates} mod${result.updates === 1 ? '' : 's'} can be updated.`,
    };
  });

  app.post('/api/servers/:uid/mods/:fileName/update', async (request, reply) => {
    const { uid, fileName } = request.params as { uid: string; fileName: string };
    const { server, user } = await requireServerAccess(request, uid, 'server.mods');

    const result = await updateMod(server, decodeURIComponent(fileName));
    await recordActivity({
      serverId: server.id,
      actorId: user.id,
      actorName: user.displayName,
      action: 'mod.update',
      message: `${user.displayName} updated ${result.fileName}.`,
    });

    return reply.code(201).send({
      ok: true,
      fileName: result.fileName,
      message: 'Updated. Restart the server for it to load.',
      needsRestart: ['running', 'starting'].includes(server.state),
    });
  });
}
