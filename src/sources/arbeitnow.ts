import { fetchJson } from "../lib/http.js";
import { htmlToText, isTechRole } from "../lib/text.js";
import type { SourceId, Startup } from "../types.js";
import type { BaseSourceConfig, SourceContext } from "./types.js";

export const sourceId = "arbeitnow" as const satisfies SourceId;

export interface ArbeitnowConfig extends BaseSourceConfig {
  limit?: number;
}

interface ArbeitnowJob {
  slug?: string;
  company_name?: string;
  title?: string;
  description?: string;
  remote?: boolean;
  url?: string;
  tags?: string[];
  location?: string;
  /** Unix seconds. */
  created_at?: number;
}

interface ArbeitnowResponse {
  data?: ArbeitnowJob[];
}

const INDIA =
  /india|bengaluru|bangalore|pune|hyderabad|mumbai|noida|gurgaon|gurugram|indore|chennai|kolkata/i;

/**
 * Arbeitnow's public job-board API. Large and fresh, but mostly EU/Germany, so
 * we keep only remote or India-based technical roles to respect the profile's
 * location preferences.
 */
export async function fetchArbeitnow(
  config: ArbeitnowConfig = {},
  _context?: SourceContext,
): Promise<Startup[]> {
  const limit = config.limit ?? 60;
  const data = await fetchJson<ArbeitnowResponse>(
    "https://www.arbeitnow.com/api/job-board-api",
    { headers: { accept: "application/json" } },
  );

  const out: Startup[] = [];
  for (const job of data.data ?? []) {
    if (!job.title || !job.company_name) continue;
    if (!isTechRole(job.title)) continue;

    const location = job.location?.trim();
    const remote = job.remote === true;
    if (!remote && !INDIA.test(location ?? "")) continue;

    const date =
      typeof job.created_at === "number"
        ? new Date(job.created_at * 1000).toISOString()
        : undefined;
    const url = job.url;
    const where = location && !/^remote job$/i.test(location) ? ` (${location})` : "";

    out.push({
      id: `arbeitnow:${job.slug ?? job.company_name}`,
      name: job.company_name.trim(),
      oneLiner: job.title,
      description: job.description ? htmlToText(job.description).slice(0, 4000) : undefined,
      url,
      locations: remote ? ["Remote"] : location ? [location] : [],
      remote: remote || undefined,
      industry: job.tags ?? [],
      source: sourceId,
      signals: [
        {
          type: "hiring",
          date,
          text: `${job.company_name.trim()} — ${job.title}${where}`,
          url,
        },
      ],
    });

    if (out.length >= limit) break;
  }

  return out;
}
