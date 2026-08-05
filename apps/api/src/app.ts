import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, brand, isAppError } from '@serverforge/core';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { authRoutes } from './routes/auth.js';
import { serverRoutes } from './routes/servers.js';
import { fileRoutes } from './routes/files.js';
import { backupRoutes } from './routes/backups.js';
import { modRoutes } from './routes/mods.js';
import { adminRoutes } from './routes/admin.js';
import { setupRoutes } from './routes/setup.js';
import { websocketRoutes } from './routes/ws.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Pino satisfies the interface Fastify needs; the cast keeps buildApp()
    // returning a plain FastifyInstance so route modules stay portable.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // Behind a reverse proxy the client IP comes from X-Forwarded-For, and
    // rate limiting keyed on the proxy's IP would throttle everyone at once.
    trustProxy: true,
    bodyLimit: 12 * 1024 * 1024,
    disableRequestLogging: !config.isProduction,
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    redis,
    // Console command spam and file listing are legitimately chatty; the
    // strict limits live on the auth routes instead.
    allowList: (request) => request.url.startsWith('/api/servers') && request.method === 'GET',
    keyGenerator: (request) => request.ip,
  });

  await app.register(multipart, {
    limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 20 },
  });

  await app.register(websocket, {
    options: { maxPayload: 1024 * 1024 },
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Powered-By', brand.name);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
  });

  // ── Error handling ────────────────────────────────────────────────────
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      // Zod's own messages are already written for humans in `contracts.ts`,
      // so they are surfaced directly rather than replaced with "invalid".
      const issues = error.issues.map((issue) => ({
        key: issue.path.join('.'),
        message: issue.message,
      }));
      return reply.code(422).send({
        error: {
          code: 'validation_failed',
          message: issues[0]?.message ?? 'Some fields need fixing.',
          details: issues,
        },
      });
    }

    if (isAppError(error)) {
      if (error.status >= 500) logger.error({ error, url: request.url }, 'application error');
      return reply.code(error.status).send(error.toJSON());
    }

    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({
        error: { code: 'rate_limited', message: 'Too many requests. Slow down a moment.' },
      });
    }

    logger.error({ error, url: request.url, method: request.method }, 'unhandled error');
    return reply.code(500).send({
      error: {
        code: 'internal_error',
        message: 'Something went wrong on our side. The details are in the panel logs.',
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { code: 'not_found', message: `No route for ${request.method} ${request.url}.` },
    });
  });

  // ── Routes ────────────────────────────────────────────────────────────
  app.get('/health', async () => {
    const { prisma } = await import('@serverforge/db');
    const [database, cache] = await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      redis.ping().then(() => true).catch(() => false),
    ]);

    const healthy = database && cache;
    return {
      status: healthy ? 'ok' : 'degraded',
      brand: brand.name,
      version: process.env.npm_package_version ?? '0.1.0',
      checks: { database, cache },
    };
  });

  await app.register(authRoutes);
  await app.register(serverRoutes);
  await app.register(fileRoutes);
  await app.register(backupRoutes);
  await app.register(modRoutes);
  const { modpackStagingRoutes } = await import('./routes/modpack-staging.js');
  await app.register(modpackStagingRoutes);
  await app.register(adminRoutes);
  await app.register(setupRoutes);
  await app.register(websocketRoutes);

  return app;
}

export { AppError };
