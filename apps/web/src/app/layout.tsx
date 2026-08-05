import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';
import { BRAND } from '@/lib/utils';

export const metadata: Metadata = {
  title: {
    default: BRAND.name,
    template: `%s · ${BRAND.name}`,
  },
  description: BRAND.tagline,
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#15141b' },
    { media: '(prefers-color-scheme: light)', color: '#fafafc' },
  ],
  width: 'device-width',
  initialScale: 1,
};

/**
 * The theme class is applied before paint by an inline script.
 *
 * Doing it in an effect would show a white flash on every load for dark-theme
 * users, which is exactly the kind of small ugliness that makes a panel feel
 * cheap.
 */
const themeScript = `
(function() {
  try {
    var stored = localStorage.getItem('sf-theme');
    var prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    var theme = stored || (prefersLight ? 'light' : 'dark');
    document.documentElement.classList.add(theme);
    document.documentElement.style.colorScheme = theme;
  } catch (e) {
    document.documentElement.classList.add('dark');
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {/* Keyboard users get past the nav without tabbing through every link. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-[13px] focus:font-medium focus:text-accent-ink"
        >
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
