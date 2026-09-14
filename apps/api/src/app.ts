import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
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
import { startNetworkWorker } from './services/upnp.js';
import { connectivityRoutes } from './routes/connectivity.js';
import { lifecycle } from './services/lifecycle.js';
import { closeConsoleStreams } from './services/console-stream.js';
import { drainServerOperations } from './services/server-lock.js';
import { prisma } from '@serverforge/db';
import { maintenanceRoutes } from './routes/maintenance.js';
import { startMaintenanceRecovery } from './services/maintenance.js';
import { accountRoutes } from './routes/account.js';
import { accountsAdminRoutes } from './routes/accounts-admin.js';

export async function buildApp() {
  const app = Fastify({ logger: false, trustProxy: true });
  app.addHook('onRequest', async (request, reply) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && lifecycle.mode !== 'ready' && !request.url.startsWith('/api/internal/maintenance/'))
      return reply
        .code(503)
        .header('Retry-After', '10')
        .send({
          error: {
            code: 'maintenance',
            message:
              'The panel is preparing, in maintenance, or shutting down. Try again when it is ready.',
          },
        });
  });

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
    if (error instanceof Error && 'statusCode' in error && error.statusCode === 413) {
      return reply.status(413).send({
        error: {
          code: 'file_too_large',
          message:
            'Upload limit exceeded. Server pack ZIPs are limited to 2 GiB; individual mods to 256 MiB. Upload one file at a time.',
        },
      });
    }
    if (error instanceof Error && 'code' in error && String(error.code).startsWith('FST_ERR_') && 'statusCode' in error && [400, 415].includes(Number(error.statusCode))) {
      return reply.status(Number(error.statusCode)).send({
        error: { code: 'bad_request', message: 'Invalid request body or content type. Send valid JSON when using application/json.' },
      });
    }
    logger.error('unhandled error', {
      message: error instanceof Error ? error.message : 'Unknown error',
      url: request.url.split('?')[0],
    });
    return reply.status(500).send({
      error: { code: 'internal_error', message: 'Something went wrong on our side.' },
    });
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 512 * 1024 * 1024 } });
  await registerAuth(app);
  app.addHook('onResponse', async (request, reply) => {
    if (!request.user || reply.statusCode >= 400 || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const route = request.routeOptions.url || '';
    if (!/^\/api\/(?:servers|network|nodes)/.test(route)) return;
    const params = request.params as { uid?: string };
    await prisma.auditLog.create({ data: { actorId: request.user.id, action: `${request.method.toLowerCase()} ${route}`, targetType: route.includes('/servers') ? 'server' : 'system', targetId: params?.uid || null, ip: request.ip, metadata: {} } }).catch((error) => logger.error('Audit event could not be recorded', { message: String(error) }));
  });

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(gameRoutes, { prefix: '/api' });
  await app.register(serverRoutes, { prefix: '/api' });
  await app.register(nodeRoutes, { prefix: '/api' });
  await app.register(managementRoutes, { prefix: '/api' });
  await app.register(connectivityRoutes, { prefix: '/api' });
  await app.register(maintenanceRoutes, { prefix: '/api/internal/maintenance' });
  await app.register(accountRoutes, { prefix: '/api' });
  await app.register(accountsAdminRoutes, { prefix: '/api' });

  return app;
}

export async function start() {
  lifecycle.mode = 'starting';
  lifecycle.supervisorRequired = process.env.WORKER !== '0';
  const app = await buildApp();
  let stopSupervisor: (() => Promise<void>) | undefined;
  let stopNetwork: (() => void) | undefined;
  let stopMaintenance: (() => void) | undefined;
  let retryStartup: ReturnType<typeof setTimeout> | undefined;
  app.addHook('preClose', async () => {
    lifecycle.mode = 'stopping';
    clearTimeout(retryStartup);
    stopMaintenance?.();
    closeConsoleStreams();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stopped = Promise.all([stopSupervisor?.(), stopNetwork?.(), drainServerOperations()]);
      await Promise.race([
        stopped,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 35000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
  app.addHook('onClose', async () => {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    await prisma.$disconnect();
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 90000);
    deadline.unref();
    void app.close().catch((error) => {
      logger.error('API shutdown failed', { message: String(error) });
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  const initialize = async () => {
    if (closing) return;
    try {
    if (lifecycle.supervisorRequired) {
      stopSupervisor = await startSupervisor();
      if (closing) { await stopSupervisor(); return; }
      stopNetwork = startNetworkWorker();
      stopMaintenance = await startMaintenanceRecovery();
    }
    if (closing) { stopMaintenance?.(); stopNetwork?.(); await stopSupervisor?.(); return; }
    if ((lifecycle.mode as string) !== 'maintenance') lifecycle.mode = 'ready';
    logger.info(`API ready on ${config.apiHost}:${config.apiPort}`);
    } catch (error) {
      stopMaintenance?.(); stopNetwork?.(); await stopSupervisor?.();
      if (closing) return;
      lifecycle.mode = 'starting';
      logger.warn('Startup dependencies unavailable; health remains live while initialization retries.', { message: String(error) });
      retryStartup = setTimeout(() => void initialize(), 10000);
      retryStartup.unref();
    }
  };
  try {
    await app.listen({ host: config.apiHost, port: config.apiPort });
    void initialize();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
