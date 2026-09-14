type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): number {
  const name = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return order[name as Level] ?? order.info;
}

function write(level: Level, message: string, extra?: Record<string, unknown>) {
  if (order[level] < currentLevel()) return;
  const line = extra ? `${message} ${JSON.stringify(extra)}` : message;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`[${level}] ${line}\n`);
}

export const logger = {
  debug: (message: string, extra?: Record<string, unknown>) => write('debug', message, extra),
  info: (message: string, extra?: Record<string, unknown>) => write('info', message, extra),
  warn: (message: string, extra?: Record<string, unknown>) => write('warn', message, extra),
  error: (message: string, extra?: Record<string, unknown>) => write('error', message, extra),
};
