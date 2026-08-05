import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export const BRAND = {
  name: process.env.NEXT_PUBLIC_BRAND_NAME ?? 'ServerForge',
  tagline: process.env.NEXT_PUBLIC_BRAND_TAGLINE ?? 'Launch a game server in minutes, not hours.',
  accent: process.env.NEXT_PUBLIC_BRAND_ACCENT ?? '#f97316',
};

/**
 * Black or white, whichever is legible on `hex`.
 *
 * Avatar colours are picked by the user from a swatch list that spans light
 * yellows to dark indigos, so a single fixed initials colour fails contrast on
 * one end or the other. Relative luminance decides it per colour instead.
 */
export function inkOn(hex: string): '#0d0d10' | '#ffffff' {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  const channel = (i: number) => {
    const v = parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  // The crossover point where white and black are equally legible.
  return luminance > 0.179 ? '#0d0d10' : '#ffffff';
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : decimals)} ${units[exponent]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** "3 minutes ago" — used across the activity feed and backup list. */
export function timeAgo(input: string | number | Date): string {
  const then = new Date(input).getTime();
  const seconds = Math.floor((Date.now() - then) / 1000);

  if (seconds < 45) return 'just now';
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [604800, 'day'],
    [2629800, 'week'],
    [31557600, 'month'],
  ];

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  let previous = 1;
  for (const [limit, unit] of units) {
    if (seconds < limit) return formatter.format(-Math.floor(seconds / previous), unit);
    previous = limit;
  }
  return formatter.format(-Math.floor(seconds / 31557600), 'year');
}

export function formatMib(mib: number): string {
  return mib >= 1024 ? `${(mib / 1024).toFixed(mib % 1024 === 0 ? 0 : 1)} GB` : `${mib} MB`;
}

/** Copy helper with a graceful fallback for non-secure origins. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http://192.168.x.x has no clipboard API — common for a home server.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  }
}
