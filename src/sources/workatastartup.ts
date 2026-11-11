import { fetchJson } from "../lib/http.js";
import { logger } from "../lib/log.js";
import { isTechRole } from "../lib/text.js";
import type { SourceId, Startup } from "../types.js";
import type { BaseSourceConfig, SourceContext } from "./types.js";

export const sourceId = "workatastartup" as const satisfies SourceId;

export interface WorkAtAStartupConfig extends BaseSourceConfig {
  limit?: number;
}

/** One entry from Work at a Startup's public job-search response. */
interface WorkAtAStartupJob {
  id?: number | string;
  title?: string;
  jobType?: string;
  location?: string;
  roleType?: string | null;
  salary?: string | null;
  companyName?: string;
  companySlug?: string;
  companyBatch?: string | null;
  companyOneLiner?: string | null;
  companyLogoUrl?: string | null;
  companyLastActiveAt?: string | null;
  applyUrl?: string;
}

interface WorkAtAStartupSearchResponse {
  jobs?: WorkAtAStartupJob[];
}

const SEARCH_URL = "https://www.workatastartup.com/jobs/search";
const JOB_URL = "https://www.workatastartup.com/jobs";
const DEFAULT_LIMIT = 100;

/**
 * The search endpoint returns at most 30 jobs per query and offers no
 * pagination, so one request can never fill the configured limit. These terms
 * cover different slices of the board; duplicate job ids are dropped.
 */
const TECH_QUERIES = [
  "software engineer",
  "developer",
  "backend",
  "frontend",
  "full stack",
] as const;

/**
 * `roleType` rescues roles whose title alone is not descriptive, such as
 * "Member of Technical Staff" or "Open Application" at software companies.
 */
function isTechJob(job: WorkAtAStartupJob): boolean {
  return isTechRole(`${job.title ?? ""} ${job.roleType ?? ""}`);
}

function mapJob(job: WorkAtAStartupJob, id: string, title: string, company: string): Startup {
  const rawLocation = job.location?.trim();
  const locations = (rawLocation ?? "")
    .split("/")
    .map((location) => location.trim())
    .filter(Boolean);
  const remote = locations.some((location) => /remote/i.test(location)) || undefined;
  const roleType = job.roleType?.trim();
  const url = `${JOB_URL}/${id}`;

  return {
    id: `${sourceId}:${id}`,
    name: company,
    oneLiner: title,
    description: job.companyOneLiner?.trim() || undefined,
    url,
    locations,
    remote,
    // The board does not expose company industries; its role type is the only
    // useful taxonomy and is kept as a tag for matching.
    industry: roleType ? [roleType] : [],
    batch: job.companyBatch?.trim() || undefined,
    source: sourceId,
    signals: [
      {
        type: "hiring",
        text: `${company} — ${title}${rawLocation ? ` (${rawLocation})` : ""}`,
        url,
      },
    ],
  };
}

/**
 * YC's Work at a Startup job board.
 *
 * The public `/jobs/search` endpoint needs a query and caps every response at
 * 30 jobs. We sweep a handful of tech-role queries, dedupe by job id, and stop
 * once `limit` is reached. Each query fails soft: one bad response still lets
 * the remaining queries contribute.
 */
export async function fetchWorkAtAStartup(
  config: WorkAtAStartupConfig = {},
  _context?: SourceContext,
): Promise<Startup[]> {
  const limit = config.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) return [];

  const seen = new Set<string>();
  const out: Startup[] = [];

  for (const query of TECH_QUERIES) {
    if (out.length >= limit) break;

    let jobs: WorkAtAStartupJob[] = [];
    try {
      const data = await fetchJson<WorkAtAStartupSearchResponse>(
        `${SEARCH_URL}?q=${encodeURIComponent(query)}`,
        { headers: { accept: "application/json" } },
      );
      jobs = Array.isArray(data.jobs) ? data.jobs : [];
    } catch (error) {
      logger.warn(
        `workatastartup: search "${query}" failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    for (const job of jobs) {
      if (out.length >= limit) break;

      const id = job.id === undefined || job.id === null ? "" : String(job.id).trim();
      const title = job.title?.trim();
      const company = job.companyName?.trim();
      if (!id || !title || !company) continue;
      if (seen.has(id)) continue;
      if (!isTechJob(job)) continue;

      seen.add(id);
      out.push(mapJob(job, id, title, company));
    }
  }

  return out;
}
