import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authorizeMaintenance, beginMaintenance, finishMaintenance, heartbeatMaintenance } from '../services/maintenance.js';
export async function maintenanceRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => authorizeMaintenance(request.headers.authorization));
  app.post('/begin', async (request) => beginMaintenance(z.object({ kind: z.enum(['panel', 'full']) }).parse(request.body).kind));
  app.post('/heartbeat', async (request) => heartbeatMaintenance(z.object({ id: z.string().optional() }).parse(request.body).id));
  app.post('/finish', async (request) => finishMaintenance(z.object({ id: z.string() }).parse(request.body).id));
}
