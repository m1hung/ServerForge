import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Next only looks for `.env` inside its own app directory, but this is a
 * monorepo with a single root `.env` — so without this the browser bundle
 * silently falls back to the compiled-in defaults, and the dashboard ends up
 * pointing at whatever happens to be on the default port.
 *
 * `NEXT_PUBLIC_*` values are inlined at build time, so they must be present in
 * `process.env` before this config is evaluated. Values already set in the
 * real environment win, which keeps Docker build args working.
 */
const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootEnv = path.resolve(appDir, '../../.env');

/**
 * The version shown in the dashboard, from the repo's root package.json —
 * the same file the API reads, so the two can never disagree about what is
 * running. Inlined at build time like the branding values below.
 */
function panelVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(appDir, '../../package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

try {
  const explicit = { ...process.env };
  process.loadEnvFile(rootEnv);
  // loadEnvFile overwrites; restore anything that was already set explicitly.
  for (const [key, value] of Object.entries(explicit)) {
    if (value !== undefined) process.env[key] = value;
  }
} catch {
  // No root .env yet (a container build, or a fresh clone before bootstrap).
  // The defaults below take over.
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The API is a separate service; the browser talks to it directly using
  // NEXT_PUBLIC_API_URL so websockets and file downloads bypass Next entirely.
  transpilePackages: ['@serverforge/core'],
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  env: {
    // 'auto' = same hostname as the dashboard, so the session cookie stays
    // same-site however the panel is reached. See resolveApiUrl().
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'auto',
    NEXT_PUBLIC_API_PORT:
      process.env.NEXT_PUBLIC_API_PORT ?? process.env.API_PORT ?? '8080',
    NEXT_PUBLIC_BRAND_NAME:
      process.env.NEXT_PUBLIC_BRAND_NAME ?? process.env.BRAND_NAME ?? 'ServerForge',
    NEXT_PUBLIC_BRAND_TAGLINE:
      process.env.NEXT_PUBLIC_BRAND_TAGLINE ??
      process.env.BRAND_TAGLINE ??
      'Launch a game server in minutes, not hours.',
    NEXT_PUBLIC_BRAND_ACCENT:
      process.env.NEXT_PUBLIC_BRAND_ACCENT ?? process.env.BRAND_ACCENT ?? '#f97316',
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION ?? panelVersion(),
  },
};

export default nextConfig;
