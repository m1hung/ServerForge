import type { FastifyInstance } from 'fastify';
import { prisma, serializeBigInts } from '@serverforge/db';
import { requireAdmin } from '../plugins/auth.js';
import { nodeCapacity } from '../services/resources.js';
import { z } from 'zod';

export async function nodeRoutes(app: FastifyInstance) {
  app.get('/nodes', async (request) => {
    requireAdmin(request);
    const nodes = await prisma.node.findMany({
      include: { _count: { select: { servers: true } } },
    });
    return {
      nodes: serializeBigInts(
        await Promise.all(
          nodes.map(async ({ agentToken: _token, ...node }) => ({ ...node, capacity: await nodeCapacity({ ...node, agentToken: '' }).catch(() => null) })),
        ),
      ),
    };
  });

  app.patch('/nodes/:uid', async (request) => {
    requireAdmin(request);
    const { uid } = request.params as { uid: string };
    const body = z.object({ publicHost: z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.:[\]-]+$/, 'Enter a hostname or IP address without a protocol or path.').optional(), name: z.string().trim().min(1).max(128).optional() }).parse(request.body);
    const node = await prisma.node.update({
      where: { uid },
      data: {
        ...(body.publicHost !== undefined ? { publicHost: body.publicHost } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
      },
    });
    const { agentToken: _token, ...visible } = node;
    return { node: visible };
  });
}
