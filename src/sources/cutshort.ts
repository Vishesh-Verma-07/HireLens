import { fetchJson } from "../lib/http.js";
import { logger } from "../lib/log.js";
import { htmlToText, isTechRole } from "../lib/text.js";
import type { SourceId, Startup } from "../types.js";
import type { BaseSourceConfig, SourceContext } from "./types.js";

export const sourceId = "cutshort" as const satisfies SourceId;

export interface CutshortConfig extends BaseSourceConfig {
  /** Maximum number of jobs to return. */
  limit?: number;
}

/**
 * Cutshort is India's startup job board. The visible listing pages hydrate
 * client-side, but the data itself comes from an unauthenticated JSON endpoint
 * the site's own bundle calls, so no account, cookie or token is required.
 *
 * The general "startup jobs" listing is the freshest feed and every job carries
 * its company, city, salary, experience range, skills and full description —
 * enough to score a role without a detail-page request.
 */
const LISTING_URL = "https://cutshort.io/backend-api/webpage/jobs/startup-jobs";

/** A browser UA is what the site's own frontend sends; curl-like agents may be challenged. */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const DEFAULT_LIMIT = 60;
/** The listing endpoint returns at most 50 jobs per page. */
const PAGE_SIZE = 50;
/** Upper bound on listing pages per run, so a bad pagination loop cannot run away. */
const MAX_PAGES = 6;
/**
 * Roughly half of a page is non-technical, and pages overlap by a few featured
 * jobs. Planning ~20 technical roles per page keeps the default limit covered
 * without walking the whole 45k-job feed.
 */
const TECH_PER_PAGE = 20;

interface CutshortCompanyLinks {
  website?: string | null;
  linkedin?: string | null;
}

interface CutshortCompany {
  name?: string | null;
  size?: string | null;
  stage?: string | null;
  type?: string | null;
  description?: string | null;
  sanitizedDescription?: string | null;
  alias?: string | null;
  links?: CutshortCompanyLinks | null;
}

interface CutshortSalaryRange {
  currency?: string | null;
  min?: number | null;
  max?: number | null;
}

interface CutshortExperienceRange {
  min?: number | null;
  max?: number | null;
}

interface CutshortJobFacts {
  roleTitle?: string | null;
  companyName?: string | null;
  companyStage?: string | null;
  experience?: string | null;
  salary?: string | null;
  postedDate?: string | null;
  postedDateLabel?: string | null;
}

interface CutshortJob {
  /** Mongo ObjectId; stable across edits and reposts. */
  _id?: string | null;
  publicUrl?: string | null;
  headline?: string | null;
  allSkills?: string[] | null;
  salaryRange?: CutshortSalaryRange | null;
  salaryRangeText?: string | null;
  locations?: string[] | null;
  locationsText?: string | null;
  companyDetails?: CutshortCompany | null;
  companyId?: { name?: string | null } | null;
  expRange?: CutshortExperienceRange | null;
  sanitizedComment?: string | null;
  roleTypes?: string[] | null;
  /** `remote_only` | `remote_okay` | `remote_not_okay`. */
  remoteType?: string | null;
  jobFactSummary?: CutshortJobFacts | null;
}

interface CutshortListingResponse {
  success?: boolean;
  data?: {
    pageData?: { jobs?: CutshortJob[] | null } | null;
  } | null;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function isoDate(value: unknown): string | undefined {
  const text = textValue(value);
  if (!text) return undefined;
  const time = Date.parse(text);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** "full_time" → "Full time". */
function humanizeToken(value: string): string {
  const text = value.replace(/[_-]+/g, " ").trim();
  return text === "" ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/** `https://www.acme.com/` → `acme.com`. */
function domainFromUrl(value: unknown): string | undefined {
  const text = textValue(value);
  if (!text) return undefined;

  const candidate = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const host = new URL(candidate).hostname.replace(/^www\./i, "").toLowerCase();
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

function experienceText(job: CutshortJob): string | undefined {
  const min = numberValue(job.expRange?.min);
  const max = numberValue(job.expRange?.max);

  if (min !== undefined && max !== undefined) {
    if (min === max) return `${min} year${min === 1 ? "" : "s"}`;
    return `${min} - ${max} years`;
  }
  if (min !== undefined) return `${min}+ years`;
  if (max !== undefined) return `up to ${max} years`;

  return textValue(job.jobFactSummary?.experience);
}

function descriptionFor(job: CutshortJob, company: string): string | undefined {
  const parts: string[] = [];

  // Compensation and experience first, so the 4000-character cut cannot drop
  // the facts the freshness/salary filters care about.
  const salary =
    textValue(job.salaryRangeText) ?? textValue(job.jobFactSummary?.salary);
  if (salary) parts.push(`Compensation: ${salary}`);

  const experience = experienceText(job);
  if (experience) parts.push(`Experience: ${experience}`);

  const skills = uniqueStrings(job.allSkills ?? []);
  if (skills.length > 0) parts.push(`Skills: ${skills.join(", ")}`);

  const roleTypes = uniqueStrings(job.roleTypes ?? []).map(humanizeToken);
  if (roleTypes.length > 0) parts.push(`Employment type: ${roleTypes.join(", ")}`);

  const body = textValue(job.sanitizedComment);
  if (body) {
    const text = htmlToText(body);
    if (text) parts.push(text);
  }

  const companyDescription =
    textValue(job.companyDetails?.sanitizedDescription) ??
    textValue(job.companyDetails?.description);
  if (companyDescription) {
    const text = htmlToText(companyDescription);
    if (text) parts.push(`About ${company}:\n${text}`);
  }

  return parts.length > 0 ? parts.join("\n\n").slice(0, 4000) : undefined;
}

/**
 * `cutshort:{job-id}`.
 *
 * `_id` is Cutshort's own Mongo id, so the cross-run dedupe key survives title
 * edits and re-posts. A job without one is skipped rather than given a
 * fabricated key.
 */
function mapJob(job: CutshortJob): Startup | undefined {
  const jobId = textValue(job._id);
  const title = textValue(job.headline) ?? textValue(job.jobFactSummary?.roleTitle);
  const company =
    textValue(job.companyDetails?.name) ??
    textValue(job.companyId?.name) ??
    textValue(job.jobFactSummary?.companyName);

  if (!jobId || !title || !company) return undefined;
  if (!isTechRole(title)) return undefined;

  const remoteType = textValue(job.remoteType)?.toLowerCase();
  const remote = remoteType === "remote_only" || remoteType === "remote_okay";

  // Cutshort is an India-only board and most listings name only a city (or no
  // location at all for remote roles), so the country is added explicitly.
  const locations = uniqueStrings([
    ...(job.locations ?? []),
    ...(remote ? ["Remote"] : []),
    "India",
  ]);

  const url =
    textValue(job.publicUrl) ?? `https://cutshort.io/job/${encodeURIComponent(jobId)}`;
  const postedAt = isoDate(job.jobFactSummary?.postedDate);
  const where = locations.filter((location) => location !== "India").join(", ");

  return {
    id: `${sourceId}:${jobId}`,
    name: company,
    oneLiner: title,
    description: descriptionFor(job, company),
    url,
    locations,
    remote: remote || undefined,
    industry: [],
    employees: textValue(job.companyDetails?.size),
    companyDomain: domainFromUrl(job.companyDetails?.links?.website),
    source: sourceId,
    signals: [
      {
        type: "hiring",
        date: postedAt,
        text: `${company} — ${title}${where ? ` (${where})` : ""}`,
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
 * Cutshort's public startup-jobs listing (India).
 *
 * Walks the newest listing pages of the unauthenticated webpage API, keeps
 * technical titles, deduplicates overlapping/featured jobs and returns the
 * freshest `limit` roles. The listing is roughly newest-first but pages can
 * overlap in time, so the whole collected batch is sorted before slicing.
 *
 * Fail-soft: a failed page is logged and skipped, leaving the other pages to
 * contribute. An empty response ends pagination.
 *
 * Limitation: only the public listing is read. Candidate-facing actions (saved
 * jobs, applications, recruiter contact) need a Cutshort account, and their
 * endpoints are deliberately not called.
 */
export async function fetchCutshort(
  config: CutshortConfig = {},
  _context?: SourceContext,
): Promise<Startup[]> {
  const limit = config.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) return [];

  const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(limit / TECH_PER_PAGE)));

  const seen = new Set<string>();
  const out: Startup[] = [];

  for (let page = 1; page <= pages; page += 1) {
    const url = `${LISTING_URL}?page=${page}`;

    let jobs: CutshortJob[] = [];
    try {
      const payload = await fetchJson<CutshortListingResponse>(url, {
        headers: { "user-agent": BROWSER_UA, accept: "application/json" },
      });
      const pageJobs = payload.data?.pageData?.jobs;
      jobs = Array.isArray(pageJobs) ? pageJobs : [];
    } catch (error) {
      logger.warn(
        `cutshort: page ${page} failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    if (jobs.length === 0) break;

    for (const job of jobs) {
      const startup = mapJob(job);
      if (!startup || seen.has(startup.id)) continue;
      seen.add(startup.id);
      out.push(startup);
    }

    if (jobs.length < PAGE_SIZE) break;
  }

  out.sort((left, right) => freshness(right) - freshness(left));

  logger.debug(`cutshort: kept ${out.length} tech role(s)`);

  return out.slice(0, limit);
}
