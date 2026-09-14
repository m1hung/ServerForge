import type { FastifyInstance } from 'fastify';
import { config } from '../lib/config.js';
import { DockerRuntime } from '../runtime/docker.js';

const runtime = new DockerRuntime();

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    const docker = await runtime.ping();
    return {
      ok: true,
      docker,
      brand: config.brand.name,
    };
  });
}
