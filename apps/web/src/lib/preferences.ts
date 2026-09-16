import { normalizeAccent } from './theme';

export type Preferences = {
  theme: 'system' | 'light' | 'dark';
  accentColor: string | null;
  density: 'comfortable' | 'compact';
  reducedMotion: boolean;
  showOverviewSummary: boolean;
  serverView: 'auto' | 'list' | 'grid';
  serverSort: 'name' | 'favorites' | 'running' | 'attention';
  favorites: string[];
  consoleFontSize: number;
  consoleWrap: boolean;
};

export const preferencesKey = 'serverforge-preferences-v1';
export const defaultPreferences: Preferences = {
  theme: 'system',
  accentColor: null,
  density: 'comfortable',
  reducedMotion: false,
  showOverviewSummary: true,
  serverView: 'auto',
  serverSort: 'name',
  favorites: [],
  consoleFontSize: 13,
  consoleWrap: true,
};

// Storage is editable and may contain values from an older version of the panel.
export function normalizePreferences(value: unknown): Preferences {
  const data = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    theme: data.theme === 'light' || data.theme === 'dark' ? data.theme : 'system',
    accentColor: normalizeAccent(data.accentColor),
    density: data.density === 'compact' ? 'compact' : 'comfortable',
    reducedMotion: data.reducedMotion === true,
    showOverviewSummary: data.showOverviewSummary !== false,
    serverView: data.serverView === 'list' || data.serverView === 'grid' ? data.serverView : 'auto',
    serverSort: ['favorites', 'running', 'attention'].includes(data.serverSort as string)
      ? (data.serverSort as Preferences['serverSort'])
      : 'name',
    favorites: Array.isArray(data.favorites)
      ? [
          ...new Set(
            data.favorites.filter(
              (id): id is string => typeof id === 'string' && /^[a-z0-9]{1,64}$/.test(id),
            ),
          ),
        ].slice(0, 500)
      : [],
    consoleFontSize: [12, 13, 15, 17].includes(data.consoleFontSize as number)
      ? (data.consoleFontSize as number)
      : 13,
    consoleWrap: data.consoleWrap !== false,
  };
}
