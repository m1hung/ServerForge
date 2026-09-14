import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrand } from '@serverforge/core';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function env(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function required(name: string): string {
  const value = env(name);
  if (value === '') {
    throw new Error(`${name} is not set. Run npm run bootstrap.`);
  }
  return value;
}

const dataRootRaw = env('DATA_ROOT', path.join(repoRoot, 'data/servers'));
const backupRootRaw = env('BACKUP_ROOT', path.join(repoRoot, 'data/backups'));

export const config = {
  nodeEnv: env('NODE_ENV', 'development'),
  logLevel: env('LOG_LEVEL', 'info'),
  databaseUrl: required('DATABASE_URL'),
  redisUrl: env('REDIS_URL', 'redis://127.0.0.1:6379'),
  sessionSecret: required('SESSION_SECRET'),
  encryptionKey: required('ENCRYPTION_KEY'),
  apiHost: env('API_HOST', '0.0.0.0'),
  apiPort: envInt('API_PORT', 8080),
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  cookieSecure: env('COOKIE_SECURE', 'auto'),
  dataRoot: path.resolve(dataRootRaw),
  backupRoot: path.resolve(backupRootRaw),
  cacheRoot: path.resolve(env('CACHE_ROOT', path.join(repoRoot, 'data/cache'))),
  themesRoot: path.resolve(env('THEMES_ROOT', path.join(repoRoot, 'data/themes'))),
  gamesRoot: path.resolve(env('GAMES_ROOT', path.join(repoRoot, 'data/games'))),
  hostDataRoot: env('HOST_DATA_ROOT'),
  hostBackupRoot: env('HOST_BACKUP_ROOT'),
  dockerSocket: env('DOCKER_SOCKET', '/var/run/docker.sock'),
  dockerNetwork: env('DOCKER_NETWORK', 'serverforge_games'),
  upnpEnabled: env('UPNP_ENABLED', 'false') === 'true',
  upnpControlUrl: env('UPNP_CONTROL_URL'),
  upnpInternalIp: env('UPNP_INTERNAL_IP'),
  curseforgeApiKey: env('CURSEFORGE_API_KEY'),
  sessionTtlSeconds: envInt('SESSION_TTL', 604_800),
  brand: resolveBrand(process.env as Record<string, string | undefined>),
};

export function cookieSecure(): boolean {
  if (config.cookieSecure === 'true') return true;
  if (config.cookieSecure === 'false') return false;
  return config.nodeEnv === 'production';
}

export function runningInContainer(): boolean {
  return config.dataRoot.startsWith('/var/lib/serverforge');
}
