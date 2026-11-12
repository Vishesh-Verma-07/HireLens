import { CircuitOpenError } from "../lib/circuit-breaker.js";
import { fetchJson, HttpError } from "../lib/http.js";
import { logger } from "../lib/log.js";
import { decodeEntities, htmlToText, isTechRole } from "../lib/text.js";
import type { SourceId, Startup } from "../types.js";
import type { GreenhouseConfig } from "./config.js";
import type { SourceContext } from "./types.js";

export const sourceId = "greenhouse" as const satisfies SourceId;

const DEFAULT_LIMIT = 50;

/** Board slugs are URL path segments, so only accept boring ones. */
const COMPANY_SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

/** Location/office labels that mean a role is not tied to one office. */
const REMOTE_LABEL = /\bremote\b/i;

/** Greenhouse's public job-board API; `content=true` inlines the description. */
export function boardUrl(company: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company)}/jobs?content=true`;
}

interface Labelled {
  name?: string;
}

interface GreenhouseJob {
  id?: number | string;
  title?: string;
  company_name?: string;
  absolute_url?: string;
  updated_at?: string;
  location?: Labelled;
  content?: string;
  departments?: Labelled[];
  offices?: Labelled[];
}

interface GreenhouseBoard {
  jobs?: GreenhouseJob[];
}

/** Trims, drops empties, and removes case-insensitive duplicates. */
function uniqueLabels(labels: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const label of labels) {
    if (typeof label !== "string") continue;
    const value = label.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }

  return out;
}

/** Reads the `name` of a `{name}` label object, ignoring malformed entries. */
function labelName(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const name = (value as Labelled).name;
  return typeof name === "string" ? name : undefined;
}

/** Names of the department/office label objects on a job. */
function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(labelName).filter((name): name is string => name !== undefined);
}

/**
 * Greenhouse timestamps are ISO 8601 with an offset; the contract wants plain
 * ISO 8601, so anything unparseable is dropped rather than passed through.
 */
function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function locationsFor(job: GreenhouseJob): string[] {
  return uniqueLabels([labelName(job.location), ...labelNames(job.offices)]);
}

/** Departments describe the team; offices are the fallback when none is set. */
function industryFor(job: GreenhouseJob): string[] {
  const departments = uniqueLabels(labelNames(job.departments));
  if (departments.length > 0) return departments;
  return uniqueLabels(labelNames(job.offices));
}

function descriptionFor(job: GreenhouseJob): string | undefined {
  if (typeof job.content !== "string" || !job.content) return undefined;
  // `content` is HTML-escaped HTML ("&lt;p&gt;…"), so decode first: stripping
  // tags before decoding would leave the markup in the text.
  const text = htmlToText(decodeEntities(job.content));
  return text ? text.slice(0, 4000).trimEnd() || undefined : undefined;
}

/** Maps one posting, or `undefined` when it is not a technical role or has no id. */
function toStartup(raw: unknown, company: string): Startup | undefined {
  // A malformed element must not sink the rest of the board.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;

  const job = raw as GreenhouseJob;
  const title = typeof job.title === "string" ? job.title.trim() : "";
  if (!title || !isTechRole(title)) return undefined;

  const rawId = job.id as unknown;
  if (rawId === undefined || rawId === null) return undefined;
  const jobId = String(rawId).trim();
  if (!jobId) return undefined;

  const locations = locationsFor(job);
  const url = typeof job.absolute_url === "string" ? job.absolute_url.trim() : undefined;
  // Jobs carry the board's display name ("Airtable"); fall back to the slug.
  const name =
    typeof job.company_name === "string" && job.company_name.trim()
      ? job.company_name.trim()
      : company;

  return {
    // Ids stay slug-based so they remain stable across runs even if a board
    // renames itself; the display name is only used for presentation.
    id: `${sourceId}:${company}:${jobId}`,
    name,
    oneLiner: title,
    description: descriptionFor(job),
    url: url || undefined,
    locations,
    remote: locations.some((label) => REMOTE_LABEL.test(label)),
    industry: industryFor(job),
    source: sourceId,
    signals: [
      {
        type: "hiring",
        date: isoDate(job.updated_at),
        text: `${name} — ${title}`,
        url: url || undefined,
      },
    ],
  };
}

/** Normalised slugs, in config order, with duplicates and junk removed. */
function companySlugs(companies: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(companies)) return [];

  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of companies) {
    if (typeof raw !== "string") {
      logger.debug(`greenhouse: ignoring non-string company slug ${String(raw)}`);
      continue;
    }

    const company = raw.trim().toLowerCase();
    if (!COMPANY_SLUG.test(company)) {
      logger.debug(`greenhouse: ignoring invalid company slug "${raw}"`);
      continue;
    }
    if (seen.has(company)) continue;

    seen.add(company);
    out.push(company);
  }

  return out;
}

function runLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(0, Math.floor(limit));
}

/**
 * Reads one company's board. A missing board (404) or a broken response is
 * logged and treated as "no jobs": one bad slug must not reject the source.
 * An open circuit breaker is different — it means the run is degraded and must
 * surface as a failure rather than as a healthy empty result.
 */
async function fetchBoard(company: string): Promise<GreenhouseJob[]> {
  const url = boardUrl(company);

  try {
    const data = await fetchJson<GreenhouseBoard>(url, {
      headers: { accept: "application/json" },
    });
    return Array.isArray(data?.jobs) ? data.jobs : [];
  } catch (error) {
    if (error instanceof CircuitOpenError) throw error;

    if (error instanceof SyntaxError) {
      logger.warn(`greenhouse: board "${company}" returned invalid JSON — skipping`);
    } else if (error instanceof HttpError && error.status === 404) {
      logger.warn(`greenhouse: no board for "${company}" (HTTP 404) — skipping`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`greenhouse: could not read board "${company}" — ${message}`);
    }

    return [];
  }
}

/**
 * Greenhouse job boards.
 *
 * One public request per company slug (no auth, no pagination). Boards mix
 * engineering with sales, support and finance postings, so only technical
 * titles survive. Companies are read sequentially and the run stops once the
 * total `limit` is reached, which also caps the number of requests.
 */
export async function fetchGreenhouse(
  config: GreenhouseConfig = {},
  _context?: SourceContext,
): Promise<Startup[]> {
  const limit = runLimit(config.limit);
  if (limit === 0) return [];

  const companies = companySlugs(config.companies);
  if (companies.length === 0) return [];

  const seen = new Set<string>();
  const out: Startup[] = [];

  for (const company of companies) {
    if (out.length >= limit) break;

    const jobs = await fetchBoard(company);

    for (const job of jobs) {
      const startup = toStartup(job, company);
      if (!startup || seen.has(startup.id)) continue;

      seen.add(startup.id);
      out.push(startup);

      if (out.length >= limit) break;
    }
  }

  return out;
}
