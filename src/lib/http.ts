import { logger } from "./log";

const USER_AGENT =
  "jobfinder/0.1 (personal startup-job matcher; public sources only)";

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const { timeoutMs = 20_000, retries = 2, headers = {} } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { "user-agent": USER_AGENT, accept: "*/*", ...headers },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      logger.debug(`fetch failed (attempt ${attempt + 1}/${retries + 1}): ${url}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, {
    ...opts,
    headers: { accept: "application/json", ...opts.headers },
  });
  return JSON.parse(text) as T;
}
