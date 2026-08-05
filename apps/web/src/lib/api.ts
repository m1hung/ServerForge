/**
 * API client.
 *
 * One place that knows the API lives on another origin, sends credentials,
 * and turns an error envelope back into a typed exception. Components never
 * call fetch directly.
 */

/**
 * Where the API lives, from the browser's point of view.
 *
 * The default is "auto": use whatever hostname the dashboard was opened on,
 * with the API's port. That keeps the two origins *same-site*, which matters
 * because the session cookie is `SameSite=Lax` — pinning this to one hostname
 * means opening the dashboard by any other name (localhost vs LAN IP vs a
 * hostname) silently fails to stay signed in.
 *
 * Set NEXT_PUBLIC_API_URL to an absolute URL only when the API genuinely
 * lives somewhere else, e.g. behind a separate domain with TLS.
 */
function resolveApiUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  const port = process.env.NEXT_PUBLIC_API_PORT ?? '8080';

  if (configured && configured !== 'auto') return configured;

  // Server-side render has no `window`; nothing there calls the API, and the
  // value is recomputed on the client before any request is made.
  if (typeof window === 'undefined') return `http://localhost:${port}`;

  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

export const API_URL = resolveApiUrl();

export interface ApiErrorBody {
  code: string;
  message: string;
  hint?: string;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'ApiError';
  }

  /** Field-level messages, for inline form validation. */
  get fieldIssues(): { key: string; message: string }[] {
    return Array.isArray(this.body.details)
      ? (this.body.details as { key: string; message: string }[])
      : [];
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    // Sessions are httpOnly cookies, so every request must carry them.
    credentials: 'include',
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...init.headers,
    },
  });

  if (response.status === 204) return undefined as T;

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error ?? {
        code: 'network_error',
        message: 'Could not reach the panel. Check that the API is running.',
      },
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'DELETE', body: body ? JSON.stringify(body) : undefined }),

  /** Multipart upload, used by the file manager's drop zone. */
  upload: async <T>(path: string, files: File[], onProgress?: (percent: number) => void) => {
    const form = new FormData();
    for (const file of files) form.append('files', file);

    // XHR rather than fetch: fetch still cannot report upload progress, and a
    // 2 GB modpack upload with no progress bar feels broken.
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_URL}${path}`);
      xhr.withCredentials = true;

      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress?.((event.loaded / event.total) * 100);
      });

      xhr.addEventListener('load', () => {
        let body: { error?: ApiErrorBody } | null = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          body = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
        else
          reject(
            new ApiError(xhr.status, body?.error ?? { code: 'upload_failed', message: 'Upload failed.' }),
          );
      });

      xhr.addEventListener('error', () =>
        reject(new ApiError(0, { code: 'network_error', message: 'The upload was interrupted.' })),
      );

      xhr.send(form);
    });
  },

  /** Absolute URL for links the browser navigates to directly. */
  url: (path: string) => `${API_URL}${path}`,
};

/** WebSocket URL for the live channel, derived from the API origin. */
export function streamUrl(path: string): string {
  const url = new URL(API_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${url.origin}${path}`;
}
