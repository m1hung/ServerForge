import type { FastifyInstance } from 'fastify';
import { prisma, serializeBigInts } from '@serverforge/db';
import { requireUser } from '../plugins/auth.js';
import { forbidden } from '@serverforge/core';

export async function nodeRoutes(app: FastifyInstance) {
  app.get('/nodes', async (request) => {
    const user = requireUser(request);
    if (user.role === 'user') throw forbidden();
    const nodes = await prisma.node.findMany({ include: { _count: { select: { servers: true } } } });
    return { nodes: serializeBigInts(nodes) };
  });

  app.patch('/nodes/:uid', async (request) => {
    const user = requireUser(request);
    if (user.role === 'user') throw forbidden();
    const { uid } = request.params as { uid: string };
    const body = request.body as { publicHost?: string; name?: string };
    const node = await prisma.node.update({
      where: { uid },
      data: {
        ...(body.publicHost !== undefined ? { publicHost: body.publicHost } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
      },
    });
    return { node };
  });
}
