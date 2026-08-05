import type { FastifyInstance } from 'fastify';
import { badRequest } from '@serverforge/core';
import { requireAuth } from '../lib/auth.js';
import { purgeExpiredStagedModpacks, saveStagedModpack } from '../services/modpack-staging.js';

/**
 * Pre-create modpack upload.
 *
 * The deploy wizard asks for the pack before a server exists, so the zip has
 * to live somewhere briefly. Install consumes it once and deletes it.
 */
export async function modpackStagingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/modpack-staging', async (request, reply) => {
    await requireAuth(request);
    void purgeExpiredStagedModpacks();

    const file = await request.file();
    if (!file) throw badRequest('Choose a modpack .zip to upload.');

    const saved = await saveStagedModpack({
      stream: file.file,
      filename: file.filename,
    });

    return reply.code(201).send({
      stagingId: saved.stagingId,
      filename: saved.filename,
      message: 'Modpack uploaded. Finish the wizard to create the server.',
    });
  });
}
