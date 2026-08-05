import { pino } from 'pino';
import { config } from '../config.js';

/**
 * Structured logs in production, readable logs in development.
 *
 * Redaction is not optional here: request bodies routinely carry passwords
 * and RCON secrets, and a self-hosted panel's logs are frequently pasted
 * into support threads.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.tokenHash',
      '*.AdminPassword',
      '*.ServerPassword',
      // Keys that contain a dot need bracket notation — pino/fast-redact
      // treats a bare dot as a path separator and rejects escaped forms.
      'settings["rcon.password"]',
      'values["rcon.password"]',
    ],
    censor: '[redacted]',
  },
  ...(config.isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
});

export type Logger = typeof logger;
