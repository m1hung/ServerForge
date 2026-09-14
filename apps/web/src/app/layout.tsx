import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { BrandProvider } from '@/components/BrandProvider';

export const dynamic = 'force-dynamic';
function branding() {
  const accent = /^#[a-f0-9]{6}$/i.test(process.env.BRAND_ACCENT || '') ? process.env.BRAND_ACCENT! : '#f97316';
  const channels = [1, 3, 5].map((offset) => parseInt(accent.slice(offset, offset + 2), 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  return {
    name: process.env.BRAND_NAME || 'ServerForge',
    tagline: process.env.BRAND_TAGLINE || 'Launch a game server in minutes, not hours.',
    accent,
    accentText: luminance > 0.179 ? '#000000' : '#ffffff',
  };
}
export function generateMetadata(): Metadata {
  const brand = branding();
  return { title: brand.name, description: brand.tagline };
}

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
      <body style={{ '--accent': branding().accent, '--accent-text': branding().accentText } as React.CSSProperties}>
        <BrandProvider value={branding()}>{children}</BrandProvider>
      </body>
    </html>
  );
}
