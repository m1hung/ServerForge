/**
 * Custom CSS themes — token overrides, full visual redesigns, and motion.
 *
 * Persisted in localStorage so the boot script in layout.tsx can attach the
 * stylesheet and `data-sf-theme` before paint. Themes may restyle any panel
 * chrome (see themes/README.md); the attribute scopes redesign rules.
 */

export const CSS_THEME_STORAGE_KEY = 'sf-css-theme';
export const DEFAULT_CSS_THEME = 'default';
export const THEME_LINK_ID = 'sf-theme-css';
export const THEME_DATA_ATTR = 'data-sf-theme';

const THEME_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function isValidCssThemeId(id: string): boolean {
  return id === DEFAULT_CSS_THEME || THEME_ID_RE.test(id);
}

/** Same-origin-friendly API base used by the FOUC boot script and the client. */
export function themeApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  const port = process.env.NEXT_PUBLIC_API_PORT ?? '8080';
  if (configured && configured !== 'auto') return configured;
  if (typeof window === 'undefined') return `http://localhost:${port}`;
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

export function themeCssUrl(id: string): string {
  return `${themeApiBase()}/api/themes/${encodeURIComponent(id)}`;
}

function syncThemeAttribute(theme: string): void {
  if (typeof document === 'undefined') return;
  if (theme === DEFAULT_CSS_THEME) {
    document.documentElement.removeAttribute(THEME_DATA_ATTR);
  } else {
    document.documentElement.setAttribute(THEME_DATA_ATTR, theme);
  }
}

/** Attach or remove the custom theme stylesheet and data-sf-theme hook. */
export function applyCssTheme(id: string | null | undefined): void {
  if (typeof document === 'undefined') return;

  const theme = id && isValidCssThemeId(id) ? id : DEFAULT_CSS_THEME;
  const existing = document.getElementById(THEME_LINK_ID) as HTMLLinkElement | null;

  syncThemeAttribute(theme);

  if (theme === DEFAULT_CSS_THEME) {
    existing?.remove();
    return;
  }

  const href = themeCssUrl(theme);
  if (existing) {
    if (existing.getAttribute('href') !== href) existing.href = href;
    return;
  }

  const link = document.createElement('link');
  link.id = THEME_LINK_ID;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

export function readStoredCssTheme(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = localStorage.getItem(CSS_THEME_STORAGE_KEY);
    if (value && isValidCssThemeId(value)) return value;
  } catch {
    // private mode / blocked storage
  }
  return null;
}

export function storeCssTheme(id: string): void {
  if (!isValidCssThemeId(id)) return;
  try {
    if (id === DEFAULT_CSS_THEME) localStorage.removeItem(CSS_THEME_STORAGE_KEY);
    else localStorage.setItem(CSS_THEME_STORAGE_KEY, id);
  } catch {
    // ignore
  }
  applyCssTheme(id);
}
