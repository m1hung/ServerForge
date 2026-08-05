import path from 'node:path';
import { z } from 'zod';

/**
 * Environment validation.
 *
 * The process refuses to boot on a bad config rather than failing later with
 * an undefined-shaped error. Secrets are length-checked here so a truncated
 * copy-paste is caught at start, not at the first login attempt.
 */

const hex64 = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, 'must be 64 hex characters — run `npm run bootstrap` to generate one');

/** An empty value means "not set" — .env.example ships these keys blank. */
const isAbsoluteIfSet = (value: string) => value.trim() === '' || path.isAbsolute(value.trim());
const absoluteMessage = 'must be an absolute path — run `npm run bootstrap` to fill it in';
const optional = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  SESSION_SECRET: hex64,
  ENCRYPTION_KEY: hex64,
  SESSION_TTL: z.coerce.number().int().min(300).default(604800),

  DATA_ROOT: z.string().default('./data/servers'),
  BACKUP_ROOT: z.string().default('./data/backups'),
  CACHE_ROOT: z.string().default('./data/cache'),
  /**
   * Host-side counterparts of DATA_ROOT / BACKUP_ROOT.
   *
   * When the API runs in Docker, DATA_ROOT is a container path and these are
   * the bind-mount sources handed to the Docker daemon for game containers.
   * Defaults match DATA_ROOT / BACKUP_ROOT for host-native `npm run dev`.
   *
   * They must be absolute: the Docker daemon resolves a relative bind source
   * against its own working directory, not this process's, so a relative value
   * would mount a directory nobody ever wrote to.
   */
  HOST_DATA_ROOT: z.string().refine(isAbsoluteIfSet, absoluteMessage).optional(),
  HOST_BACKUP_ROOT: z.string().refine(isAbsoluteIfSet, absoluteMessage).optional(),

  /**
   * Session cookie Secure flag.
   * - auto: Secure only in production (breaks plain-HTTP LAN IPs in Chromium)
   * - true / false: force
   * Compose defaults to false so LAN dashboards keep a session over HTTP.
   * Set true behind a TLS reverse proxy.
   */
  COOKIE_SECURE: z.enum(['true', 'false', 'auto']).default('auto'),

  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  DOCKER_NETWORK: z.string().default('serverforge_games'),
  PORT_RANGE_START: z.coerce.number().int().default(25500),
  PORT_RANGE_END: z.coerce.number().int().default(25999),

  /**
   * Automatic router port forwarding (UPnP IGD).
   *
   * Off by default, and deliberately so: it asks the router to expose a game
   * server to the whole internet, which is not a thing to switch on for
   * somebody as a default. Only the port a player connects to is ever mapped —
   * never rcon or query — see services/upnp.ts.
   */
  UPNP_ENABLED: z.enum(['true', 'false']).default('false'),
  /**
   * Skips SSDP discovery. Discovery is multicast and does not cross Docker's
   * bridge network, so a containerised API cannot find the router on its own;
   * the SOAP calls afterwards are plain unicast HTTP and work fine. Set this
   * to the control URL from the router's device description to use UPnP from
   * inside a container.
   */
  UPNP_CONTROL_URL: z.string().optional(),
  /** 0 = permanent. Mappings are kept alive by re-assertion, not by leases. */
  UPNP_LEASE_SECONDS: z.coerce.number().int().min(0).default(0),
  /** Overrides the auto-detected LAN address the router forwards to. */
  UPNP_INTERNAL_IP: z.string().optional(),

  CURSEFORGE_API_KEY: z.string().optional().default(''),
  MODRINTH_USER_AGENT: z.string().default('serverforge/0.1.0 (self-hosted)'),

  BRAND_NAME: z.string().default('ServerForge'),
});

export type Config = z.infer<typeof schema> & {
  isProduction: boolean;
  cookieSecure: boolean;
  corsOrigins: string[];
  dataRoot: string;
  backupRoot: string;
  cacheRoot: string;
  HOST_DATA_ROOT: string;
  HOST_BACKUP_ROOT: string;
  upnpEnabled: boolean;
};

function load(): Config {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`);
    console.error(
      ['', 'Configuration problem — the API cannot start:', ...lines, '', 'Fix your .env and try again.', ''].join(
        '\n',
      ),
    );
    process.exit(1);
  }

  const env = parsed.data;
  const dataRoot = path.resolve(env.DATA_ROOT);
  const backupRoot = path.resolve(env.BACKUP_ROOT);
  const isProduction = env.NODE_ENV === 'production';

  return {
    ...env,
    isProduction,
    cookieSecure:
      env.COOKIE_SECURE === 'true' ? true : env.COOKIE_SECURE === 'false' ? false : isProduction,
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    upnpEnabled: env.UPNP_ENABLED === 'true',
    dataRoot,
    backupRoot,
    cacheRoot: path.resolve(env.CACHE_ROOT),
    // A blank HOST_* falls back to the local root, which is right for
    // host-native runs and is what the container overrides. Blank must not
    // reach path.resolve(): that would quietly yield the current directory.
    HOST_DATA_ROOT: path.resolve(optional(env.HOST_DATA_ROOT) ?? env.DATA_ROOT),
    HOST_BACKUP_ROOT: path.resolve(optional(env.HOST_BACKUP_ROOT) ?? env.BACKUP_ROOT),
  };
}

export const config = load();
