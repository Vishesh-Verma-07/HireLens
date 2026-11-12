import { fetchJson } from "../lib/http.js";
import { logger } from "../lib/log.js";
import { htmlToText, isTechRole } from "../lib/text.js";
import type { SourceId, Startup } from "../types.js";
import type { AshbyConfig } from "./config.js";
import type { SourceContext } from "./types.js";

export const sourceId = "ashby" as const satisfies SourceId;

/** Ashby's public job-board API: one JSON document per company slug. */
const API_BASE = "https://api.ashbyhq.com/posting-api/job-board";

const DEFAULT_LIMIT = 50;

/** Guard against a typo or a pasted URL turning into a request. */
const COMPANY_SLUG = /^[a-z0-9][a-z0-9._-]*$/;

interface AshbyPostalAddress {
  addressLocality?: string;
  addressRegion?: string;
  addressCountry?: string;
}

interface AshbySecondaryLocation {
  location?: string;
}

interface AshbyJob {
  id?: string;
  title?: string;
  location?: string;
  secondaryLocations?: AshbySecondaryLocation[];
  department?: string;
  team?: string;
  isListed?: boolean;
  isRemote?: boolean;
  workplaceType?: string;
  employmentType?: string;
  jobUrl?: string;
  applyUrl?: string;
  publishedAt?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  address?: { postalAddress?: AshbyPostalAddress };
}

interface AshbyBoard {
  apiVersion?: string;
  jobs?: AshbyJob[];
}

/** `publishedAt` is already ISO 8601; normalize anyway so the contract holds. */
function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** Primary location, secondary locations, then the postal city/region. */
function locationList(job: AshbyJob): string[] {
  const locations: string[] = [];
  const seen = new Set<string>();

  const add = (value: string | undefined): void => {
    const location = value?.trim();
    if (!location) return;
    const key = location.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    locations.push(location);
  };

  add(job.location);
  for (const secondary of job.secondaryLocations ?? []) add(secondary?.location);

  const postal = job.address?.postalAddress;
  add(postal?.addressLocality);
  add(postal?.addressRegion);

  return locations;
}

/** Department and team are the only taxonomy the board exposes. */
function industryList(job: AshbyJob): string[] {
  const industry: string[] = [];

  for (const label of [job.department, job.team]) {
    const value = label?.trim();
    if (value && !industry.includes(value)) industry.push(value);
  }

  return industry;
}

function descriptionFor(job: AshbyJob): string | undefined {
  const text =
    job.descriptionPlain?.trim() ||
    (job.descriptionHtml ? htmlToText(job.descriptionHtml).trim() : "");
  return text ? text.slice(0, 4000) : undefined;
}

/**
 * `ashby:{company}:{job-id}`.
 *
 * The job id is the posting's UUID, which is stable for the life of the
 * posting; the company slug keeps ids readable and collision-free when the same
 * role is cross-posted to two boards.
 */
function mapJob(job: AshbyJob, company: string, jobId: string, title: string): Startup {
  const url = job.jobUrl?.trim() || job.applyUrl?.trim() || undefined;
  const locations = locationList(job);

  return {
    id: `${sourceId}:${company}:${jobId}`,
    // The board API only identifies companies by slug, so the slug is the name.
    name: company,
    oneLiner: title,
    description: descriptionFor(job),
    url,
    locations,
    remote: job.isRemote === true || /remote/i.test(job.workplaceType ?? ""),
    industry: industryList(job),
    source: sourceId,
    signals: [
      {
        type: "hiring",
        date: isoDate(job.publishedAt),
        text: `${company} — ${title}`,
        url,
      },
    ],
  };
}

/**
 * Ashby job boards, one request per configured company slug.
 *
 * Each company is fetched independently: a dead or mistyped slug logs a warning
 * and the remaining companies still contribute, so one bad entry in
 * `sources.yaml` cannot sink the source. Postings are kept in board order and
 * only technical titles survive, which stops a single large board from filling
 * the digest with sales and operations roles.
 */
export async function fetchAshby(
  config: AshbyConfig = {},
  _context?: SourceContext,
): Promise<Startup[]> {
  const requested = config.limit ?? DEFAULT_LIMIT;
  const limit = Number.isFinite(requested)
    ? Math.max(0, Math.floor(requested))
    : DEFAULT_LIMIT;
  if (limit <= 0) return [];

  const companies = config.companies ?? [];
  if (companies.length === 0) return [];

  const seen = new Set<string>();
  const fetched = new Set<string>();
  const out: Startup[] = [];

  for (const raw of companies) {
    if (out.length >= limit) break;

    const company = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!company) continue;
    if (!COMPANY_SLUG.test(company)) {
      logger.warn(`ashby: skipping invalid company slug "${raw}"`);
      continue;
    }
    if (fetched.has(company)) continue;
    fetched.add(company);

    let jobs: AshbyJob[] = [];
    try {
      const data = await fetchJson<AshbyBoard>(
        `${API_BASE}/${encodeURIComponent(company)}`,
        { headers: { accept: "application/json" } },
      );
      jobs = Array.isArray(data.jobs) ? data.jobs : [];
    } catch (error) {
      logger.warn(
        `ashby: board "${company}" failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    for (const job of jobs) {
      if (out.length >= limit) break;

      // A malformed element must not sink the rest of the board.
      if (typeof job !== "object" || job === null || Array.isArray(job)) continue;
      if (job.isListed === false) continue;

      const jobId = typeof job.id === "string" ? job.id.trim() : "";
      const title = typeof job.title === "string" ? job.title.trim() : "";
      if (!jobId || !title) continue;
      if (!isTechRole(title)) continue;

      const id = `${sourceId}:${company}:${jobId}`;
      if (seen.has(id)) continue;
      seen.add(id);

      out.push(mapJob(job, company, jobId, title));
    }
  }

  return out;
}
