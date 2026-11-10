import { fetchJson } from "../lib/http.js";
import { htmlToText, isTechRole } from "../lib/text.js";
import type { SourceId, Startup } from "../types.js";
import type { BaseSourceConfig, SourceContext } from "./types.js";

export const sourceId = "unstop" as const satisfies SourceId;

export interface UnstopConfig extends BaseSourceConfig {
  limit?: number;
}

/**
 * Unstop's public opportunity search (India-focused jobs + internships).
 *
 * The API is structured: title, company, skills, locations, work mode and a
 * real `created_at`, which makes it a good freshness-verified source for
 * junior/AI roles in India. Internships and non-technical listings are
 * filtered out here.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

interface UnstopSkill {
  skill?: string;
  skill_name?: string;
}

interface UnstopWorkFunction {
  name?: string;
}

interface UnstopJobDetail {
  /** Years. */
  min_experience?: number | string | null;
  max_experience?: number | string | null;
  /** "wfh" | "in_office" | ... */
  type?: string;
  locations?: string[];
}

interface UnstopLocation {
  city?: string;
  state?: string;
  country?: string;
}

interface UnstopJob {
  id?: number;
  public_url?: string;
  title?: string;
  type?: string;
  subtype?: string;
  created_at?: string;
  updated_at?: string;
  details?: string;
  organisation?: { name?: string };
  required_skills?: UnstopSkill[];
  workfunction?: UnstopWorkFunction[];
  jobDetail?: UnstopJobDetail;
  locations?: UnstopLocation[];
  region?: string;
}

interface UnstopResponse {
  data?: { data?: UnstopJob[] };
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export async function fetchUnstop(
  config: UnstopConfig = {},
  _context?: SourceContext,
): Promise<Startup[]> {
  const limit = config.limit ?? 60;
  const out: Startup[] = [];

  for (let page = 1; page <= 4 && out.length < limit; page++) {
    let data: UnstopJob[];
    try {
      const res = await fetchJson<UnstopResponse>(
        `https://unstop.com/api/public/opportunity/search-new?opportunity=jobs&page=${page}&per_page=50`,
        { headers: { "user-agent": BROWSER_UA, accept: "application/json" } },
      );
      data = res.data?.data ?? [];
    } catch {
      break;
    }
    if (!data.length) break;

    for (const job of data) {
      if (out.length >= limit) break;
      const title = job.title?.trim();
      const company = job.organisation?.name?.trim();
      if (!title || !company) continue;
      if (/intern(ship)?\b/i.test(title)) continue;
      if (!isTechRole(title)) continue;

      const jd = job.jobDetail ?? {};
      const minExp = toNumber(jd.min_experience);
      const locations = [
        ...(jd.locations ?? []),
        ...(job.locations ?? []).map((l) => l.city ?? "").filter(Boolean),
        "India",
      ];

      const skills = (job.required_skills ?? [])
        .map((s) => s.skill_name ?? s.skill)
        .filter((x): x is string => Boolean(x));

      const description = [
        job.details ? htmlToText(job.details) : "",
        skills.length ? `Skills: ${skills.join(", ")}` : "",
        minExp !== undefined && minExp > 0 ? `Experience: ${minExp} years` : "",
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 4000);

      const remote = /wfh|remote/i.test(jd.type ?? "");
      const url = job.public_url ? `https://unstop.com/${job.public_url}` : undefined;

      out.push({
        id: `unstop:${job.id ?? job.public_url ?? company}`,
        name: company,
        oneLiner: title,
        description: description || undefined,
        url,
        locations: [...new Set(locations)],
        remote: remote || undefined,
        industry: [],
        source: sourceId,
        signals: [
          {
            type: "hiring",
            date: job.created_at ?? job.updated_at,
            text: `${company} — ${title}`,
            url,
          },
        ],
      });
    }
  }

  return out;
}
