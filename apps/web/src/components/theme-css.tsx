'use client';

import { useEffect } from 'react';
import { api } from '@/lib/api';
import {
  applyCssTheme,
  DEFAULT_CSS_THEME,
  readStoredCssTheme,
} from '@/lib/theme-css';

/**
 * Ensures a CSS theme is applied after hydration.
 *
 * The layout boot script already applies a stored preference before paint.
 * This fills in the panel default when the browser has no preference yet,
 * and re-applies after client navigations.
 */
export function ThemeCss() {
  useEffect(() => {
    const stored = readStoredCssTheme();
    if (stored) {
      applyCssTheme(stored);
      return;
    }

    let cancelled = false;
    void api
      .get<{ active: string }>('/api/themes')
      .then((data) => {
        if (cancelled) return;
        // Respect a preference written while the request was in flight.
        if (readStoredCssTheme()) return;
        applyCssTheme(data.active || DEFAULT_CSS_THEME);
      })
      .catch(() => {
        // API down — stay on built-in tokens.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
