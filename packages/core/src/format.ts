/** Formatting helpers shared by the API (log lines) and the dashboard. */

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const unit = UNITS[exponent] ?? 'B';
  return `${value.toFixed(exponent === 0 ? 0 : decimals)} ${unit}`;
}

export function mibToBytes(mib: number): number {
  return Math.round(mib * 1024 * 1024);
}

export function bytesToMib(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const rest = s % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

export function formatPercent(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(decimals)}%`;
}

/** Trims a console line for storage without breaking ANSI sequences mid-way. */
export function truncateLine(line: string, max = 4096): string {
  return line.length <= max ? line : `${line.slice(0, max)}… [truncated]`;
}

// The control character is the point: this exists to strip ANSI escapes out
// of game console output before it reaches the browser.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI, '');
}
