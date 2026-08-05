import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

/**
 * Custom CSS themes.
 *
 * Themes are plain `.css` files that redefine the design tokens in
 * `globals.css` (`--canvas`, `--accent`, …). Built-in examples ship in the
 * repo `themes/` directory; operators drop their own files in THEMES_ROOT
 * (`data/themes` by default).
 */

export const DEFAULT_THEME_ID = 'default';

const THEME_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface ThemeInfo {
  id: string;
  name: string;
  description: string | null;
  /** builtin = shipped with the panel; custom = operator-provided file. */
  source: 'builtin' | 'custom';
}

/** Safe theme id from a URL / setting value, or null when invalid. */
export function parseThemeId(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const id = raw.trim().replace(/\.css$/i, '');
  if (id === DEFAULT_THEME_ID) return DEFAULT_THEME_ID;
  if (!THEME_ID_RE.test(id)) return null;
  return id;
}

/** Directory of themes that ship with the product. */
export function builtinThemesRoot(): string {
  // apps/api/{src,dist}/lib → repo root /themes
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../themes');
}

function themeFileName(id: string): string {
  return `${id}.css`;
}

async function readIfFile(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Resolve a theme id to CSS text.
 * Custom themes win over built-in ones with the same id.
 */
export async function readThemeCss(id: string): Promise<string | null> {
  const parsed = parseThemeId(id);
  if (!parsed || parsed === DEFAULT_THEME_ID) return null;

  const file = themeFileName(parsed);
  const custom = await readIfFile(path.join(config.themesRoot, file));
  if (custom !== null) return custom;

  return readIfFile(path.join(builtinThemesRoot(), file));
}

function parseThemeMeta(css: string, fallbackId: string): {
  name: string;
  description: string | null;
} {
  const header = css.slice(0, 800);
  const nameMatch = header.match(/^\s*\/\*+[^*\n]*\btheme:\s*([^\n*]+)/im);
  const descMatch = header.match(/\bdescription:\s*([^\n*]+)/im);
  const name = nameMatch?.[1]?.trim() || fallbackId;
  const description = descMatch?.[1]?.trim() || null;
  return { name, description };
}

async function listDirThemes(
  dir: string,
  source: 'builtin' | 'custom',
): Promise<ThemeInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const themes: ThemeInfo[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.css')) continue;
    const id = parseThemeId(entry.slice(0, -4));
    if (!id || id === DEFAULT_THEME_ID) continue;

    const css = await readIfFile(path.join(dir, entry));
    if (css === null) continue;
    const meta = parseThemeMeta(css, id);
    themes.push({
      id,
      name: meta.name,
      description: meta.description,
      source,
    });
  }
  return themes;
}

/** All discoverable themes. Custom entries replace built-ins with the same id. */
export async function listThemes(): Promise<ThemeInfo[]> {
  const [builtin, custom] = await Promise.all([
    listDirThemes(builtinThemesRoot(), 'builtin'),
    listDirThemes(config.themesRoot, 'custom'),
  ]);

  const byId = new Map<string, ThemeInfo>();
  for (const theme of builtin) byId.set(theme.id, theme);
  for (const theme of custom) byId.set(theme.id, theme);

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function ensureThemesRoot(): Promise<void> {
  await fs.mkdir(config.themesRoot, { recursive: true });
}
