import { start } from './app.js';
import { logger } from './lib/logger.js';

start().catch((error: unknown) => {
  logger.error('API failed to start', { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
