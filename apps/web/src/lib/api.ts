const DEFAULT = 'http://localhost:8080';

export function apiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL ?? DEFAULT;
  if (configured !== 'auto') return configured.replace(/\/$/, '');
  if (typeof window === 'undefined') return DEFAULT;
  const port = process.env.NEXT_PUBLIC_API_PORT ?? '8080';
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(data.error?.message ?? `Request failed (${response.status})`);
  }
  return data;
}
