import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../src/lib/log.js";
import { loadProfile } from "../src/profile.js";
import { loadSourceConfig } from "../src/sources/index.js";
import { discoverSources } from "../src/sources/registry.js";
import { assertValidStartups } from "../test/contract.js";
import {
  FIXTURE_DIR,
  type Fixture,
  type FixtureResponse,
} from "../test/fixtures.js";
import type { SourceSettings } from "../src/sources/registry.js";
import type { Startup } from "../src/types.js";

/**
 * Records a live source response as a test fixture.
 *
 * Usage:
 *   npm run record:fixture <source>              # full response
 *   npm run record:fixture remoteok -- --trim 60 # keep the first 60 array items
 *   npm run record:fixture yc -- --config config/sources.yaml
 *
 * The recorder calls the source's own `fetch` function, so the request goes
 * through the shared HTTP client (timeouts, retries, rate limiting, circuit
 * breaker) and the source parses live data exactly as it does in production.
 * `globalThis.fetch` is wrapped only to copy the response body; the request
 * itself is untouched.
 *
 * Every 2xx response is written to `test/fixtures/<source>.json`; failed
 * responses are logged and skipped. A contract check runs on the resulting
 * startups and reports problems without discarding the recording.
 */

interface Options {
  sourceId: string;
  configPath: string;
  profilePath: string;
  /** Keep at most this many top-level array items per response. */
  trim?: number;
  /** Keep only the last N job URLs in a sitemap response. */
  trimSitemap?: number;
}

const USAGE = `Usage: npm run record:fixture <source> [options]

Options:
  --trim <n>      Keep at most n top-level array items per response (for big feeds)
  --trim-sitemap <n>  Keep only the last n job URLs in a sitemap response
  --config <path> Sources config (default: config/sources.yaml)
  --profile <path> Profile used as source context (default: profile/profile.yaml)
  --help          Show this message`;

function parseArgs(argv: string[], root: string): Options {
  let sourceId: string | undefined;
  let configPath = resolve(root, "config/sources.yaml");
  let profilePath = resolve(root, "profile/profile.yaml");
  let trim: number | undefined;
  let trimSitemap: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }

    if (arg === "--trim") {
      const raw = argv[index + 1];
      const value = Number(raw);
      if (!raw || !Number.isInteger(value) || value <= 0) {
        throw new Error("--trim needs a positive integer");
      }
      trim = value;
      index += 1;
      continue;
    }

    if (arg === "--trim-sitemap") {
      const raw = argv[index + 1];
      const value = Number(raw);
      if (!raw || !Number.isInteger(value) || value <= 0) {
        throw new Error("--trim-sitemap needs a positive integer");
      }
      trimSitemap = value;
      index += 1;
      continue;
    }

    if (arg === "--config" || arg === "--profile") {
      const raw = argv[index + 1];
      if (!raw) throw new Error(`${arg} needs a path`);
      const path = resolve(root, raw);
      if (arg === "--config") configPath = path;
      else profilePath = path;
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) throw new Error(`unknown option "${arg}"`);
    if (sourceId) throw new Error(`unexpected extra argument "${arg}"`);
    sourceId = arg;
  }

  if (!sourceId) throw new Error("missing source id");
  return { sourceId, configPath, profilePath, trim, trimSitemap };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** JSON responses are stored parsed (readable diffs); everything else as text. */
function captureBody(text: string, contentType: string): unknown {
  const looksLikeJson = /json/i.test(contentType) || /^[\s\uFEFF]*[\[{]/.test(text);
  if (!looksLikeJson) return text;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function settingsFor(raw: Record<string, unknown> | undefined): SourceSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as SourceSettings;
}

function trimResponse(response: FixtureResponse, limit: number | undefined): FixtureResponse {
  if (limit === undefined || !Array.isArray(response.body)) return response;
  if (response.body.length <= limit) return response;

  return {
    ...response,
    body: response.body.slice(0, limit),
  };
}

/**
 * Keeps only the last `limit` job entries of a sitemap `<urlset>`.
 *
 * Sitemaps are large and mix job and company URLs. Trimming before the source
 * sees the response means a recording only resolves the ids that end up in the
 * fixture, instead of requesting (and storing) hundreds of unseen jobs.
 */
function trimSitemapXml(xml: string, limit: number): string {
  if (!xml.includes("<urlset")) return xml;

  const blocks = xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
  const jobs = blocks.filter((block) => /<loc>[^<]*\/jobs\//.test(block));
  if (jobs.length === 0) return xml;

  const head = xml.match(/^[\s\S]*?<urlset[^>]*>/)?.[0] ?? "";
  return `${head}\n${jobs.slice(-limit).join("\n")}\n</urlset>\n`;
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const options = parseArgs(process.argv.slice(2), root);

  const config = loadSourceConfig(options.configPath);
  const profile = loadProfile(options.profilePath);
  const sources = await discoverSources();
  const source = sources.find((entry) => entry.id === options.sourceId);

  if (!source) {
    const available = sources.map((entry) => entry.id).sort().join(", ");
    throw new Error(
      `unknown source "${options.sourceId}". Available sources: ${available}`,
    );
  }

  const settings = settingsFor(config.sources?.[options.sourceId]);
  if (settings.enabled === false) {
    logger.warn(`record:fixture: "${options.sourceId}" is disabled in config — recording anyway`);
  }

  const captured: FixtureResponse[] = [];
  let requestCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    requestCount += 1;
    const url = requestUrl(input);
    const response = await originalFetch(input, init);

    if (!response.ok) {
      logger.warn(`record:fixture: skipping HTTP ${response.status} for ${url}`);
      return response;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.clone().text();
    const body =
      options.trimSitemap !== undefined
        ? trimSitemapXml(text, options.trimSitemap)
        : text;
    const headers: Record<string, string> = {};
    if (contentType) headers["content-type"] = contentType;

    captured.push({
      url,
      status: response.status,
      headers,
      body: captureBody(body, contentType),
    });

    if (body === text) return response;
    return new Response(body, { status: response.status, headers: response.headers });
  }) as typeof fetch;

  let startups: Startup[];
  try {
    startups = await source.fetch(settings, { profile });
  } finally {
    globalThis.fetch = originalFetch;
  }

  if (captured.length === 0) {
    throw new Error(
      `no successful responses recorded after ${requestCount} request(s); fixture not written`,
    );
  }

  const fixture: Fixture = {
    source: options.sourceId,
    recordedAt: new Date().toISOString(),
    responses: captured.map((response) => trimResponse(response, options.trim)),
  };

  mkdirSync(FIXTURE_DIR, { recursive: true });
  const path = resolve(FIXTURE_DIR, `${options.sourceId}.json`);
  const json = `${JSON.stringify(fixture, null, 2)}\n`;
  writeFileSync(path, json);

  const trimNote =
    options.trim === undefined
      ? ""
      : ` (trimmed to ${options.trim} array item(s) per response)`;
  const sitemapNote =
    options.trimSitemap === undefined
      ? ""
      : ` (kept the last ${options.trimSitemap} sitemap job url(s))`;
  logger.info(
    `record:fixture: wrote ${captured.length} response(s) from ${requestCount} request(s) ` +
      `to ${path} — ${(Buffer.byteLength(json) / 1024).toFixed(1)} KB${trimNote}${sitemapNote}`,
  );
  logger.info(`record:fixture: source returned ${startups.length} startup(s)`);

  try {
    assertValidStartups(startups, options.sourceId);
    logger.info("record:fixture: contract check passed");
  } catch (error) {
    logger.warn(
      `record:fixture: contract check failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

main().catch((error) => {
  logger.error(
    `record:fixture: ${error instanceof Error ? error.message : String(error)}`,
  );
  logger.error(USAGE);
  process.exitCode = 1;
});
