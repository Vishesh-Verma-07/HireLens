import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Recorded source fixtures + replay.
 *
 * A fixture is one real HTTP exchange per response the source made, captured by
 * `npm run record:fixture <source>`. Tests replay it by swapping
 * `globalThis.fetch`, so a source test is deterministic, offline, and still
 * exercises the source's real parsing code (not a hand-written mock).
 *
 * See `test/fixtures/README.md` for the format and the recording workflow.
 */

export interface FixtureResponse {
  /** Exact URL the source requested while recording. */
  url: string;
  /** HTTP status of the recorded response (only 2xx responses are recorded). */
  status: number;
  /** Response headers worth replaying (today: `content-type`). */
  headers: Record<string, string>;
  /** Parsed JSON when the response was JSON, otherwise the raw body text. */
  body: unknown;
}

export interface Fixture {
  /** Source id this fixture belongs to; guards against copy-paste mistakes. */
  source: string;
  /** ISO timestamp of the recording. */
  recordedAt: string;
  responses: FixtureResponse[];
}

/** `test/fixtures/` — one `<source>.json` per source. */
export const FIXTURE_DIR = join(import.meta.dirname, "fixtures");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absolute path of a source's fixture.
 *
 * The fixture directory and this helper live in `test/` on purpose: fixtures and
 * their reader are test-only, so production code never imports either.
 */
export function fixturePath(sourceId: string): string {
  return join(FIXTURE_DIR, `${sourceId}.json`);
}

/**
 * Reads `test/fixtures/<sourceId>.json` and checks the envelope.
 *
 * Throws with the exact recording command when the file is missing, so a new
 * source author is never left guessing.
 */
export function loadFixture(sourceId: string): Fixture {
  const path = fixturePath(sourceId);
  let raw: string;

  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `No fixture for "${sourceId}" at ${path}. Record one with: npm run record:fixture ${sourceId}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Fixture ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`Fixture ${path} must be a JSON object`);
  }

  if (parsed.source !== sourceId) {
    throw new Error(
      `Fixture ${path} was recorded for "${String(parsed.source)}", not "${sourceId}". ` +
        `Record it with: npm run record:fixture ${sourceId}`,
    );
  }

  if (!Array.isArray(parsed.responses) || parsed.responses.length === 0) {
    throw new Error(`Fixture ${path} has no recorded responses`);
  }

  return parsed as unknown as Fixture;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Origin + path, used to tolerate query-string drift between runs. */
function urlWithoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Picks the recorded response for a request.
 *
 * Exact URL match wins. Otherwise the request may differ only in query params
 * (for example a changed `limit`); in that case a response for the same
 * origin + path is used. A single-response fixture is reused for any URL, which
 * keeps tests stable when a source adds a harmless parameter.
 */
export function selectResponse(fixture: Fixture, url: string): FixtureResponse {
  const exact = fixture.responses.find((response) => response.url === url);
  if (exact) return exact;

  const path = urlWithoutQuery(url);
  const samePath = fixture.responses.filter(
    (response) => urlWithoutQuery(response.url) === path,
  );
  if (samePath[0]) return samePath[0];

  const only = fixture.responses.length === 1 ? fixture.responses[0] : undefined;
  if (only) return only;

  const available = fixture.responses.map((response) => response.url).join("\n  ");
  throw new Error(
    `Fixture "${fixture.source}" has no response for ${url}. Recorded URLs:\n  ${available}\n` +
      `Re-record with: npm run record:fixture ${fixture.source}`,
  );
}

function replayBody(response: FixtureResponse): string | null {
  if (response.status === 204 || response.status === 205) return null;
  return typeof response.body === "string"
    ? response.body
    : JSON.stringify(response.body);
}

/**
 * Runs `run` with `globalThis.fetch` replaced by a fixture replay.
 *
 * The fixture is loaded lazily and restored in `finally`, so a failed test can
 * never leak the stub into another test file. Calls a source makes to any URL
 * not present in the fixture fail loudly rather than silently hitting the live
 * network.
 */
export async function withFixtureFetch<T>(
  sourceId: string,
  run: () => Promise<T>,
  fixture: Fixture = loadFixture(sourceId),
): Promise<T> {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const response = selectResponse(fixture, requestUrl(input));
    const body = replayBody(response);

    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  }) as typeof fetch;

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
