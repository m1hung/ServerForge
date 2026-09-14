import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_BRAND_NAME ?? 'ServerForge',
  description:
    process.env.NEXT_PUBLIC_BRAND_TAGLINE ?? 'Launch a game server in minutes, not hours.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try { document.documentElement.dataset.theme = localStorage.getItem('serverforge-theme') === 'dark' ? 'dark' : 'light'; } catch {}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
