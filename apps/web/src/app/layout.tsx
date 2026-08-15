import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';
import { ThemeCss } from '@/components/theme-css';
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
  // Lets env(safe-area-inset-*) resolve on notched phones so the bottom nav
  // and sticky save bars clear the home indicator.
  viewportFit: 'cover',
};

const apiUrlLiteral = JSON.stringify(process.env.NEXT_PUBLIC_API_URL ?? 'auto');
const apiPortLiteral = JSON.stringify(
  process.env.NEXT_PUBLIC_API_PORT ?? process.env.API_PORT ?? '8080',
);

/**
 * The theme class (and optional custom CSS theme) is applied before paint.
 *
 * Doing it in an effect would flash the default palette on every load for
 * dark-theme / custom-theme users.
 */
const themeScript = `
(function() {
  try {
    var stored = localStorage.getItem('sf-theme');
    var prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    var theme = stored || (prefersLight ? 'light' : 'dark');
    document.documentElement.classList.add(theme);
    document.documentElement.style.colorScheme = theme;

    var cssTheme = localStorage.getItem('sf-css-theme');
    if (cssTheme && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(cssTheme) && cssTheme !== 'default') {
      document.documentElement.setAttribute('data-sf-theme', cssTheme);
      var configured = ${apiUrlLiteral};
      var port = ${apiPortLiteral};
      var base = (configured && configured !== 'auto')
        ? configured
        : (window.location.protocol + '//' + window.location.hostname + ':' + port);
      var link = document.createElement('link');
      link.id = 'sf-theme-css';
      link.rel = 'stylesheet';
      link.href = base + '/api/themes/' + encodeURIComponent(cssTheme);
      document.head.appendChild(link);
    } else {
      document.documentElement.removeAttribute('data-sf-theme');
    }
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
        <Providers>
          <ThemeCss />
          {children}
        </Providers>
      </body>
    </html>
  );
}
