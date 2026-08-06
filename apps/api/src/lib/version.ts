import { createRequire } from 'node:module';

/**
 * The panel version, read from the repo's root package.json.
 *
 * Not `process.env.npm_package_version`: that only exists when the process was
 * started by an npm script, and the container starts it with `node` directly.
 * Reading it there yields undefined, so a hardcoded fallback answers instead —
 * which is right until the first version bump and quietly wrong afterwards.
 *
 * The path is four levels up from both `apps/api/src/lib` (development, via
 * tsx) and `apps/api/dist/lib` (production), and the API image copies the root
 * package.json in beside the build for exactly this.
 */
const require = createRequire(import.meta.url);

function readVersion(): string {
  try {
    const pkg = require('../../../../package.json') as { version?: string };
    return pkg.version ?? UNKNOWN_VERSION;
  } catch {
    // Reading it is best-effort: a panel that will not start because it could
    // not find its own version number would be a poor trade.
    return UNKNOWN_VERSION;
  }
}

/** Deliberately not a plausible number — it should read as "we don't know". */
const UNKNOWN_VERSION = '0.0.0';

export const PANEL_VERSION = readVersion();
