type Level = 'debug' | 'info' | 'warn' | 'error';
import { redactText, redactDiagnostic } from '@serverforge/core';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): number {
  const name = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return order[name as Level] ?? order.info;
}

function write(level: Level, message: string, extra?: Record<string, unknown>) {
  if (order[level] < currentLevel()) return;
  const secrets = Object.entries(process.env).filter(([key]) => /SECRET|TOKEN|PASSWORD|KEY|DATABASE_URL/.test(key)).map(([, value]) => value || '');
  const safeMessage = redactText(message, secrets);
  const line = extra ? `${safeMessage} ${JSON.stringify(redactDiagnostic(extra, secrets))}` : safeMessage;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`[${level}] ${line}\n`);
}

export const logger = {
  debug: (message: string, extra?: Record<string, unknown>) => write('debug', message, extra),
  info: (message: string, extra?: Record<string, unknown>) => write('info', message, extra),
  warn: (message: string, extra?: Record<string, unknown>) => write('warn', message, extra),
  error: (message: string, extra?: Record<string, unknown>) => write('error', message, extra),
};
