import { fetchJson } from "../lib/http.js";
import { logger } from "../lib/log.js";
import { htmlToText, isTechRole, slug } from "../lib/text.js";
import type { SourceId, Startup } from "../types.js";
import type { BaseSourceConfig, SourceContext } from "./types.js";

export const sourceId = "himalayas" as const satisfies SourceId;

export interface HimalayasConfig extends BaseSourceConfig {
  /** Maximum number of startups to return. */
  limit?: number;
  /**
   * Drop listings that explicitly ask for on-site or hybrid work. Himalayas is
   * a remote-first board, so this only filters the occasional listing that
   * contradicts the board; it stays configurable because the feed mixes both.
   */
  remoteOnly?: boolean;
}

/** One entry from Himalayas' public job-search response. */
interface HimalayasJob {
  title?: string | null;
  excerpt?: string | null;
  companyName?: string | null;
  companySlug?: string | null;
  employmentType?: string | null;
  minSalary?: number | null;
  maxSalary?: number | null;
  salaryPeriod?: string | null;
  currency?: string | null;
  seniority?: string[] | null;
  locationRestrictions?: string[] | null;
  categories?: string[] | null;
  parentCategories?: string[] | null;
  description?: string | null;
  /** Unix seconds of the last update. */
  pubDate?: number | null;
  applicationLink?: string | null;
  guid?: string | null;
}

interface HimalayasSearchResponse {
  jobs?: HimalayasJob[];
}

const SEARCH_URL = "https://himalayas.app/jobs/api/search";
const PAGE_SIZE = 20;

/**
 * The search endpoint returns at most 20 jobs per page. Several broad tech
 * queries keep the feed mostly technical; duplicate guids are dropped, so a
 * role that matches multiple queries is only returned once.
 */
const TECH_QUERIES = ["engineer", "developer", "data scientist", "devops"] as const;

/** Upper bound on requests per query, so one sparse query cannot run away. */
const MAX_PAGES_PER_QUERY = 5;

/**
 * A remote-first board still gets the occasional on-site/hybrid listing.
 * "Hybrid" only counts as a work arrangement when it is phrased as one; a
 * "Hybrid Cloud Engineer" works on hybrid cloud infrastructure and stays.
 */
const NON_REMOTE = /(?<![a-z])(on[- ]?site|in[- ]?office|office[- ]?based)(?![a-z])/i;
const HYBRID_WORK =
  /\bhybrid\s+(?:work(?:ing)?|role|position|arrangement|schedule|model|setup|based|remote)\b|\b(?:work(?:ing)?|role|position)\s+(?:is\s+)?(?:fully\s+)?hybrid\b|\(\s*hybrid\s*\)/i;

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = textValue(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/** "Senior-Frontend-Engineer-(Angular)" → "Senior Frontend Engineer (Angular)". */
function humanizeCategory(value: string | undefined): string | undefined {
  const text = textValue(value);
  if (!text) return undefined;
  return text.replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

function isRemoteJob(job: HimalayasJob): boolean {
  const haystack = `${job.title ?? ""} ${job.excerpt ?? ""}`;
  return !NON_REMOTE.test(haystack) && !HYBRID_WORK.test(haystack);
}

/**
 * Himalayas' `guid` is the stable job identifier (`/companies/{company}/jobs/{slug}`).
 * The source's own id is that path without the origin, which is unique across
 * companies and survives title edits. Jobs without a guid fall back to the
 * company slug + title slug.
 */
export function jobIdFromGuid(job: HimalayasJob): string | undefined {
  const guid = textValue(job.guid);
  const match = guid?.match(/\/companies\/([^/]+)\/jobs\/([^/?#]+)/i);
  if (match) return `${match[1]}/${match[2]}`;

  const company = textValue(job.companySlug);
  const title = textValue(job.title);
  if (!company || !title) return undefined;
  return `${company}/${slug(title)}`;
}

function isoFromEpoch(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function formatAmount(amount: number): string {
  return amount.toLocaleString("en-US");
}

/** `{ minSalary: 45000, maxSalary: 50000, currency: "USD" }` → `USD 45,000–50,000`. */
function formatSalary(job: HimalayasJob): string | undefined {
  const min =
    typeof job.minSalary === "number" && job.minSalary > 0 ? job.minSalary : undefined;
  const max =
    typeof job.maxSalary === "number" && job.maxSalary > 0 ? job.maxSalary : undefined;
  if (min === undefined && max === undefined) return undefined;

  const currency = textValue(job.currency);
  const amount =
    min !== undefined && max !== undefined && min !== max
      ? `${formatAmount(min)}–${formatAmount(max)}`
      : formatAmount(min ?? max ?? 0);

  return `${currency ?? ""} ${amount}`.trim();
}

/**
 * Titles alone miss roles such as "Member of Technical Staff", so the category
 * taxonomy (hyphenated slugs) is allowed to prove a technical role too.
 */
function isTechJob(job: HimalayasJob): boolean {
  const haystack = [
    job.title,
    ...(job.categories ?? []).map(humanizeCategory),
    ...(job.parentCategories ?? []).map(humanizeCategory),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");

  return isTechRole(haystack);
}

function locationsFor(job: HimalayasJob): string[] {
  const restrictions = uniqueStrings(job.locationRestrictions ?? []);
  return restrictions.length > 0 ? ["Remote", ...restrictions] : ["Remote"];
}

function industryFor(job: HimalayasJob): string[] {
  return uniqueStrings([
    ...(job.parentCategories ?? []).map(humanizeCategory),
    ...(job.categories ?? []).map(humanizeCategory),
  ]);
}

function descriptionFor(job: HimalayasJob): string | undefined {
  const parts: string[] = [];

  // Compensation first, so the 4000-character cut can never drop it.
  const salary = formatSalary(job);
  if (salary) parts.push(`Compensation: ${salary}`);

  const employment = textValue(job.employmentType);
  if (employment) parts.push(`Employment type: ${employment}`);

  const seniority = uniqueStrings(job.seniority ?? []);
  if (seniority.length > 0) parts.push(`Seniority: ${seniority.join(", ")}`);

  const body = textValue(job.description);
  if (body) parts.push(htmlToText(body));
  else {
    const excerpt = textValue(job.excerpt);
    if (excerpt) parts.push(excerpt);
  }

  return parts.length > 0 ? parts.join("\n\n").slice(0, 4000) : undefined;
}

function mapJob(job: HimalayasJob, remoteOnly: boolean): Startup | undefined {
  const title = textValue(job.title);
  const company = textValue(job.companyName);
  const jobId = jobIdFromGuid(job);
  if (!title || !company || !jobId) return undefined;

  if (!isTechJob(job)) return undefined;

  const remote = isRemoteJob(job);
  if (remoteOnly && !remote) return undefined;

  const url =
    textValue(job.applicationLink) ??
    textValue(job.guid) ??
    `https://himalayas.app/companies/${encodeURIComponent(jobId)}`;
  const postedAt = isoFromEpoch(job.pubDate);
  const salary = formatSalary(job);

  return {
    id: `${sourceId}:${jobId}`,
    name: company,
    oneLiner: title,
    description: descriptionFor(job),
    url,
    locations: locationsFor(job),
    remote: remote || undefined,
    industry: industryFor(job),
    source: sourceId,
    signals: [
      {
        type: "hiring",
        date: postedAt,
        text: `${company} — ${title}${salary ? ` (${salary})` : ""}`,
        url,
      },
    ],
  };
}

function freshness(startup: Startup): number {
  const date = startup.signals[0]?.date;
  const time = date ? Date.parse(date) : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Himalayas.app — a remote-first startup and tech job board with a free public
 * JSON API (no key required).
 *
 * The browse endpoint caps every page at 20 jobs, so this source asks the
 * search endpoint for a handful of broad tech queries, walks their recent
 * pages, filters out non-technical titles (and, when `remoteOnly` is set, the
 * occasional on-site/hybrid listing), and returns the freshest `limit` roles.
 *
 * A failed page only drops that query's remaining pages: the other queries
 * still contribute, so one upstream hiccup does not sink the source.
 */
export async function fetchHimalayas(
  config: HimalayasConfig = {},
  _context?: SourceContext,
): Promise<Startup[]> {
  const limit = config.limit ?? 100;
  if (limit <= 0) return [];

  const remoteOnly = config.remoteOnly ?? true;
  const seen = new Set<string>();
  const out: Startup[] = [];

  for (const query of TECH_QUERIES) {
    for (let page = 1; page <= MAX_PAGES_PER_QUERY; page += 1) {
      if (out.length >= limit) break;

      const params = new URLSearchParams({
        q: query,
        sort: "recent",
        page: String(page),
      });
      const url = `${SEARCH_URL}?${params.toString()}`;

      let jobs: HimalayasJob[] = [];
      try {
        const data = await fetchJson<HimalayasSearchResponse>(url, {
          headers: { accept: "application/json" },
        });
        jobs = Array.isArray(data.jobs) ? data.jobs : [];
      } catch (error) {
        logger.warn(
          `himalayas: search "${query}" page ${page} failed — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        break;
      }

      if (jobs.length === 0) break;

      for (const job of jobs) {
        if (out.length >= limit) break;

        const startup = mapJob(job, remoteOnly);
        if (!startup || seen.has(startup.id)) continue;

        seen.add(startup.id);
        out.push(startup);
      }

      if (jobs.length < PAGE_SIZE) break;
    }
  }

  out.sort((left, right) => freshness(right) - freshness(left));

  logger.debug(`himalayas: kept ${out.length} tech role(s)`);

  return out.slice(0, limit);
}
