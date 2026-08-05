/**
 * Single source of truth for product identity.
 *
 * Renaming the product is a three-variable change in `.env`:
 *   BRAND_NAME / BRAND_TAGLINE / BRAND_ACCENT
 * (plus the NEXT_PUBLIC_* mirrors so the browser bundle can see them).
 *
 * Nothing else in the codebase should hardcode the product name in
 * user-visible strings — import `brand` instead.
 */
export interface Brand {
  /** Display name, e.g. "ServerForge". */
  name: string;
  /** Lowercase, filesystem/DNS safe form, e.g. "serverforge". */
  slug: string;
  /** One-line product promise shown on auth + onboarding screens. */
  tagline: string;
  /** Primary accent colour as a hex string. Drives the CSS custom property. */
  accent: string;
  /** Container/volume/label prefix. Derived from the slug. */
  resourcePrefix: string;
  /** Docker label namespace used to identify managed containers. */
  labelNamespace: string;
}

const DEFAULT_NAME = 'ServerForge';
const DEFAULT_TAGLINE = 'Launch a game server in minutes, not hours.';
const DEFAULT_ACCENT = '#f97316';

export function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'serverforge'
  );
}

/**
 * Reads branding from whichever env is available. Works in Node (process.env)
 * and in the Next.js browser bundle (inlined NEXT_PUBLIC_* values).
 */
export function resolveBrand(env: Record<string, string | undefined> = readEnv()): Brand {
  const name = env.BRAND_NAME || env.NEXT_PUBLIC_BRAND_NAME || DEFAULT_NAME;
  const slug = slugify(name);
  return {
    name,
    slug,
    tagline: env.BRAND_TAGLINE || env.NEXT_PUBLIC_BRAND_TAGLINE || DEFAULT_TAGLINE,
    accent: env.BRAND_ACCENT || env.NEXT_PUBLIC_BRAND_ACCENT || DEFAULT_ACCENT,
    resourcePrefix: slug,
    labelNamespace: `${slug}.io`,
  };
}

function readEnv(): Record<string, string | undefined> {
  if (typeof process !== 'undefined' && process.env) return process.env as Record<string, string>;
  return {};
}

export const brand: Brand = resolveBrand();
