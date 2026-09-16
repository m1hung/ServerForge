import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { BrandProvider } from '@/components/BrandProvider';
import { PreferencesProvider } from '@/components/Preferences';
import { preferencesKey } from '@/lib/preferences';
import { accentVariables, normalizeAccent } from '@/lib/theme';
import { UnsavedChangesProvider } from '@/components/UnsavedChanges';

export const dynamic = 'force-dynamic';
function branding() {
  const accent = normalizeAccent(process.env.BRAND_ACCENT) ?? '#f97316';
  return {
    name: process.env.BRAND_NAME || 'ServerForge',
    tagline: process.env.BRAND_TAGLINE || 'Launch a game server in minutes, not hours.',
    accent,
  };
}
export function generateMetadata(): Metadata {
  const brand = branding();
  return { title: brand.name, description: brand.tagline };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const brand = branding();
  return (
    <html
      lang="en"
      suppressHydrationWarning
      style={accentVariables(brand.accent) as React.CSSProperties}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(() => {
              let theme = 'system', preferences = {};
              try { theme = localStorage.getItem('serverforge-theme') || 'system'; } catch {}
              try { preferences = JSON.parse(localStorage.getItem('${preferencesKey}') || '{}') || {}; } catch {}
              const root = document.documentElement;
              root.dataset.theme = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
              root.dataset.density = preferences.density === 'compact' ? 'compact' : 'comfortable';
              root.dataset.motion = preferences.reducedMotion === true ? 'reduce' : 'system';
              const accent = typeof preferences.accentColor === 'string' && /^#[a-f0-9]{6}$/i.test(preferences.accentColor) ? preferences.accentColor : '${brand.accent}';
              const variables = (${accentVariables.toString()})(accent);
              for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
            })();`,
          }}
        />
      </head>
      <body>
        <BrandProvider value={brand}>
          <PreferencesProvider>
            <UnsavedChangesProvider>{children}</UnsavedChangesProvider>
          </PreferencesProvider>
        </BrandProvider>
      </body>
    </html>
  );
}
