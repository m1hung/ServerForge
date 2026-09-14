export function apiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL ?? 'auto';
  // Keep cookies, uploads and live streams on the same HTTPS origin on LAN and Tailscale.
  return configured === 'auto' ? '' : configured.replace(/\/$/, '');
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
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
