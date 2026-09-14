import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { isAppError, PathEscapeError } from '@serverforge/core';
import { ZodError } from 'zod';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { registerAuth } from './plugins/auth.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { gameRoutes } from './routes/games.js';
import { serverRoutes } from './routes/servers.js';
import { managementRoutes } from './routes/management.js';
import { nodeRoutes } from './routes/nodes.js';
import { startSupervisor } from './workers/supervisor.js';

export async function buildApp() {
  const app = Fastify({ logger: false, trustProxy: true });

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 512 * 1024 * 1024 } });
  await registerAuth(app);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(gameRoutes, { prefix: '/api' });
  await app.register(serverRoutes, { prefix: '/api' });
  await app.register(nodeRoutes, { prefix: '/api' });
  await app.register(managementRoutes, { prefix: '/api' });

  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      return reply.status(error.status).send(error.toJSON());
    }
    if (error instanceof ZodError || error instanceof PathEscapeError) {
      return reply.status(400).send({
        error: {
          code: 'bad_request',
          message:
            error instanceof ZodError
              ? (error.issues[0]?.message ?? 'Invalid request.')
              : error.message,
        },
      });
    }
    if (error.statusCode === 413) {
      return reply.status(413).send({
        error: {
          code: 'file_too_large',
          message:
            'Upload limit exceeded. Server pack ZIPs are limited to 2 GiB; individual mods to 256 MiB. Upload one file at a time.',
        },
      });
    }
    logger.error('unhandled error', { message: error.message, url: request.url });
    return reply.status(500).send({
      error: { code: 'internal_error', message: 'Something went wrong on our side.' },
    });
  });

  return app;
}

export async function start() {
  const app = await buildApp();
  if (process.env.WORKER !== '0') await startSupervisor();
  await app.listen({ host: config.apiHost, port: config.apiPort });
  logger.info(`API ready on ${config.apiHost}:${config.apiPort}`);
}
