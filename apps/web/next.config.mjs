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
const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');

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
  },
};

export default nextConfig;
