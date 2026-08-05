import { upstreamFailure } from './errors.js';

/**
 * Thin fetch wrapper used by every adapter that talks to an upstream
 * registry (Mojang, PaperMC, Purpur, Fabric, NeoForge, Modrinth, Steam).
 *
 * Adapters must never call `fetch` directly: timeouts, retries and the
 * user-agent policy live here so upstream flakiness degrades into a clean
 * 502 with a human-readable message instead of a hung install job.
 */

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Friendly service name used in error messages, e.g. "PaperMC". */
  service?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fetchWithRetry(url: string, options: FetchOptions = {}): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    headers = {},
    signal,
    service = new URL(url).hostname,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const response = await fetch(url, { headers, signal: controller.signal });

      // 5xx and 429 are worth retrying; 4xx means we asked for the wrong thing.
      if (response.status >= 500 || response.status === 429) {
        lastError = new Error(`${service} responded ${response.status}`);
      } else {
        return response;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }

    if (attempt < retries) await sleep(backoffMs(attempt));
  }

  throw upstreamFailure(service, lastError);
}

/** Exponential backoff with jitter, capped so installs stay responsive. */
export function backoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 4_000);
  return base + Math.floor(Math.random() * 250);
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const service = options.service ?? new URL(url).hostname;
  const response = await fetchWithRetry(url, { ...options, service });

  if (!response.ok) {
    throw upstreamFailure(service, new Error(`${response.status} ${response.statusText}`));
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw upstreamFailure(service, error);
  }
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const service = options.service ?? new URL(url).hostname;
  const response = await fetchWithRetry(url, { ...options, service });
  if (!response.ok) {
    throw upstreamFailure(service, new Error(`${response.status} ${response.statusText}`));
  }
  return response.text();
}
