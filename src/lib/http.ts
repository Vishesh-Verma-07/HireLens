import { CircuitOpenError, type CircuitBreaker } from "./circuit-breaker";
import { logger } from "./log";
import type { RateLimiter } from "./rate-limit";

const USER_AGENT =
  "jobfinder/0.1 (personal startup-job matcher; public sources only)";

/** Statuses worth retrying. Other 4xx responses are deterministic failures. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** A failed HTTP request, with enough detail for callers to decide what next. */
export class HttpError extends Error {
  readonly url: string;
  /** HTTP status, or 0 for network/timeout failures. */
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    url: string,
    status: number,
    message: string,
    retryable: boolean,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HttpError";
    this.url = url;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** HTTP method. Defaults to GET. */
  method?: string;
  /** Request body, sent verbatim. Callers set their own `content-type`. */
  body?: string;
  /** Token bucket consulted before every network attempt. */
  rateLimiter?: RateLimiter;
  /** Breaker wrapped around every network attempt, so open state fails fast. */
  circuitBreaker?: CircuitBreaker;
  /** Base delay for exponential backoff. Default 300ms. */
  backoffMs?: number;
  /** Upper bound for a single retry delay. Default 5s. */
  maxBackoffMs?: number;
  /** @internal Injectable sleep, used by tests to avoid real delays. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** One network attempt, with timeout, rate limiting, and breaker accounting. */
async function attemptOnce(url: string, opts: FetchOptions): Promise<string> {
  const run = async (): Promise<string> => {
    await opts.rateLimiter?.acquire();
    return requestOnce(url, opts);
  };

  return opts.circuitBreaker ? opts.circuitBreaker.exec(run) : run();
}

async function requestOnce(url: string, opts: FetchOptions): Promise<string> {
  const { timeoutMs = 20_000, headers = {} } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: opts.method,
      body: opts.body,
      signal: ctrl.signal,
      headers: { "user-agent": USER_AGENT, accept: "*/*", ...headers },
    });

    if (!res.ok) {
      throw new HttpError(
        url,
        res.status,
        `HTTP ${res.status} ${res.statusText}`.trim() + ` for ${url}`,
        isRetryableStatus(res.status),
      );
    }

    return await res.text();
  } catch (error) {
    if (error instanceof HttpError) throw error;

    // Aborts, DNS failures, TLS errors, and dropped connections all land here.
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(url, 0, `fetch failed for ${url}: ${message}`, true, error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches `url` as text, retrying transient failures with exponential backoff.
 *
 * Retries only network/timeout failures and retryable statuses (408, 425, 429,
 * 5xx). A non-retryable 4xx fails immediately. When a `CircuitBreaker` is
 * supplied, an open breaker aborts the attempt (and any remaining retries)
 * without touching the network.
 */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const retries = Math.max(0, Math.floor(opts.retries ?? 2));
  const backoffMs = Math.max(0, opts.backoffMs ?? 300);
  const maxBackoffMs = Math.max(backoffMs, opts.maxBackoffMs ?? 5_000);
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await attemptOnce(url, opts);
    } catch (error) {
      lastError = error;

      // Fail fast: retrying while the breaker is open can only waste tokens.
      if (error instanceof CircuitOpenError) throw error;

      const retryable = error instanceof HttpError ? error.retryable : true;
      if (!retryable || attempt === retries) break;

      const delayMs = Math.min(maxBackoffMs, backoffMs * 2 ** attempt);
      logger.debug(
        `fetch failed (attempt ${attempt + 1}/${retries + 1}); retrying in ${delayMs}ms: ${url}`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, {
    ...opts,
    headers: { accept: "application/json", ...opts.headers },
  });
  return JSON.parse(text) as T;
}
