'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  defaultPreferences,
  normalizePreferences,
  preferencesKey,
  type Preferences,
} from '@/lib/preferences';
import { accentVariables, normalizeAccent } from '@/lib/theme';
import { useBrand } from './BrandProvider';

const Context = createContext<{
  preferences: Preferences;
  update: (patch: Partial<Preferences>) => void;
  dark: boolean;
  storageError: boolean;
} | null>(null);

export function usePreferences() {
  const context = useContext(Context);
  if (!context) throw new Error('PreferencesProvider is required.');
  return context;
}

function applyAppearance(value: Preferences, brandAccent: string) {
  const dark =
    value.theme === 'dark' ||
    (value.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.density = value.density;
  document.documentElement.dataset.motion = value.reducedMotion ? 'reduce' : 'system';
  for (const [name, color] of Object.entries(accentVariables(value.accentColor ?? brandAccent)))
    document.documentElement.style.setProperty(name, color);
  return dark;
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { accent: brandAccent } = useBrand();
  const [preferences, setPreferences] = useState(defaultPreferences);
  const current = useRef(defaultPreferences);
  const [dark, setDark] = useState(false);
  const [storageError, setStorageError] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    function apply() {
      setDark(applyAppearance(current.current, brandAccent));
    }
    function load() {
      try {
        let stored = {};
        try {
          stored = JSON.parse(localStorage.getItem(preferencesKey) || '{}');
        } catch {
          /* Ignore a malformed preference record. */
        }
        current.current = normalizePreferences({
          ...stored,
          // Keep the existing key so upgrades preserve the sidebar toggle.
          theme: localStorage.getItem('serverforge-theme'),
        });
        setPreferences(current.current);
      } catch {
        /* Corrupt or blocked storage must not prevent using the dashboard. */
      }
      apply();
    }
    function storage(event: StorageEvent) {
      if (event.key === null || [preferencesKey, 'serverforge-theme'].includes(event.key)) load();
    }
    load();
    media.addEventListener('change', apply);
    window.addEventListener('storage', storage);
    return () => {
      media.removeEventListener('change', apply);
      window.removeEventListener('storage', storage);
    };
  }, [brandAccent]);

  function update(patch: Partial<Preferences>) {
    const next = normalizePreferences({ ...current.current, ...patch });
    current.current = next;
    setPreferences(next);
    try {
      localStorage.setItem(preferencesKey, JSON.stringify(next));
      localStorage.setItem('serverforge-theme', next.theme);
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
    setDark(applyAppearance(next, brandAccent));
  }

  return (
    <Context.Provider value={{ preferences, update, dark, storageError }}>
      {children}
    </Context.Provider>
  );
}

export function PreferencesSettings() {
  const { preferences: p, update, storageError } = usePreferences();
  const { accent: brandAccent } = useBrand();
  const [notice, setNotice] = useState('');
  const [resetCount, setResetCount] = useState(0);
  return (
    <section className="card stack" id="preferences" aria-labelledby="preferences-title">
      <div className="section-heading">
        <h2 id="preferences-title">Make it yours</h2>
        <span className="status-pill neutral">This browser</span>
      </div>
      <p className="muted">
        Saved automatically in this browser, for everyone using this browser profile. Your servers
        and other devices aren’t changed.
      </p>
      {storageError && (
        <p className="error-banner" role="alert">
          Your browser couldn’t save these preferences. They’ll work until you reload; allow site
          storage to keep them.
        </p>
      )}
      <div className="settings-field-grid">
        <label>
          Theme
          <select
            value={p.theme}
            onChange={(e) => update({ theme: e.target.value as Preferences['theme'] })}
          >
            <option value="system">Use device setting</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label>
          Spacing
          <select
            value={p.density}
            onChange={(e) => update({ density: e.target.value as Preferences['density'] })}
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact · fit more on screen</option>
          </select>
        </label>
      </div>
      <AccentSettings
        key={resetCount}
        accent={p.accentColor}
        brandAccent={brandAccent}
        onChange={(accentColor) => update({ accentColor })}
      />
      <div>
        <label className="setting-checkbox">
          <input
            type="checkbox"
            checked={p.reducedMotion}
            onChange={(e) => update({ reducedMotion: e.target.checked })}
          />
          Reduce animation and smooth scrolling
        </label>
        <p className="field-hint">Your device’s reduced-motion setting is always respected.</p>
      </div>
      <details className="settings-details settings-disclosure">
        <summary>Overview display</summary>
        <div className="stack">
          <label>
            Default server view
            <select
              value={p.serverView}
              onChange={(e) => update({ serverView: e.target.value as Preferences['serverView'] })}
            >
              <option value="auto">Automatic · cards on mobile</option>
              <option value="list">List</option>
              <option value="grid">Cards</option>
            </select>
          </label>
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={p.showOverviewSummary}
              onChange={(e) => update({ showOverviewSummary: e.target.checked })}
            />
            Show overview statistics and workspace snapshot
          </label>
          <p className="field-hint">
            Star your favorite servers on the overview to find them faster.
          </p>
        </div>
      </details>
      <details className="settings-details settings-disclosure">
        <summary>Console display</summary>
        <div className="stack">
          <label>
            Console text size
            <select
              value={p.consoleFontSize}
              onChange={(e) => update({ consoleFontSize: Number(e.target.value) })}
            >
              {[12, 13, 15, 17].map((size) => (
                <option key={size} value={size}>
                  {size} px
                </option>
              ))}
            </select>
          </label>
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={p.consoleWrap}
              onChange={(e) => update({ consoleWrap: e.target.checked })}
            />
            Wrap long console lines
          </label>
          <p className="field-hint">These controls are also available above each server console.</p>
        </div>
      </details>
      <div className="form-actions">
        <button
          className="btn secondary small"
          onClick={() => {
            update({ ...defaultPreferences, favorites: p.favorites });
            setResetCount((count) => count + 1);
            setNotice('Display defaults restored. Your favorite servers were kept.');
          }}
        >
          Reset display preferences
        </button>
        <span className="muted" role="status">
          {notice}
        </span>
      </div>
    </section>
  );
}

function AccentSettings({
  accent,
  brandAccent,
  onChange,
}: {
  accent: string | null;
  brandAccent: string;
  onChange: (accent: string | null) => void;
}) {
  const [hex, setHex] = useState(accent ?? brandAccent);
  useEffect(() => setHex(accent ?? brandAccent), [accent, brandAccent]);
  const invalid = normalizeAccent(hex) === null;
  return (
    <fieldset className="accent-settings" aria-describedby="accent-help">
      <legend>Accent color</legend>
      <p id="accent-help" className="field-hint">
        Choose a color for buttons, links and title accents. Text and focus outlines adjust to stay
        readable in both light and dark mode.
      </p>
      <div className="accent-custom">
        <label>
          Custom accent
          <input
            type="color"
            value={accent ?? brandAccent}
            onChange={(event) => {
              setHex(event.target.value);
              onChange(event.target.value);
            }}
          />
        </label>
        <div>
          <label htmlFor="accent-hex">Hex color</label>
          <input
            id="accent-hex"
            type="text"
            value={hex}
            maxLength={7}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid}
            aria-describedby="accent-hex-hint"
            onChange={(event) => {
              setHex(event.target.value);
              const color = normalizeAccent(event.target.value);
              if (color) onChange(color);
            }}
          />
          <p
            className={invalid ? 'field-hint error' : 'field-hint'}
            id="accent-hex-hint"
            role="status"
          >
            {invalid
              ? 'Enter # followed by six hexadecimal digits. Your last valid color is still active.'
              : 'For example, #2563eb. Valid colors save automatically.'}
          </p>
        </div>
      </div>
      <div className="form-actions">
        <button
          type="button"
          className="btn secondary small"
          onClick={() => {
            setHex(brandAccent);
            onChange(null);
          }}
        >
          Use workspace default
        </button>
      </div>
    </fieldset>
  );
}
