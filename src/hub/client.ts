import { logger } from "../lib/log.js";

export type IngestType = "companies" | "jobs" | "contacts" | "outreach";

export type HubPayload = Record<string, unknown>;

/** Hub gives up after 10 seconds per attempt. */
const TIMEOUT_MS = 10_000;
/** One initial attempt plus up to two retries. */
const MAX_ATTEMPTS = 3;
/** Backoff between retries: 500ms, then 1000ms. */
const BACKOFF_MS = 500;

function baseUrl(): string | undefined {
  const value = process.env.HUB_URL?.trim();
  return value ? value.replace(/\/+$/, "") : undefined;
}

function apiKey(): string | undefined {
  const value = process.env.HUB_API_KEY?.trim();
  return value ? value : undefined;
}

/** True only when both Hub env vars are present. */
export function hubConfigured(): boolean {
  return Boolean(baseUrl() && apiKey());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function attemptSend(
  type: IngestType,
  payload: HubPayload | HubPayload[],
  url: string,
  key: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${url}/api/ingest/${type}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": key,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const detail = body ? `: ${body.slice(0, 500)}` : "";
      throw new Error(`HTTP ${response.status} ${response.statusText}${detail}`);
    }

    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST one record (or one batch) to Hub.
 *
 * Fire-and-forget by design: failures are logged and reported as `false`, so
 * callers never need a try/catch and a Hub outage can never break the matcher.
 * When `HUB_URL` or `HUB_API_KEY` is missing this silently does nothing.
 */
export async function sendToHub(
  type: IngestType,
  payload: HubPayload | HubPayload[],
): Promise<boolean> {
  const url = baseUrl();
  const key = apiKey();

  // The integration is optional. Missing configuration is not an error.
  if (!url || !key) return false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await attemptSend(type, payload, url, key);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (attempt < MAX_ATTEMPTS) {
        logger.warn(
          `hub: ${type} attempt ${attempt}/${MAX_ATTEMPTS} failed — ${message}; retrying`,
        );
        await sleep(BACKOFF_MS * attempt);
      } else {
        logger.error(
          `hub: ${type} failed after ${MAX_ATTEMPTS} attempts — ${message}`,
        );
      }
    }
  }

  return false;
}
