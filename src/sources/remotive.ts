import { fetchJson } from "../lib/http.js";
import { htmlToText, isTechRole } from "../lib/text.js";
import type { Startup } from "../types.js";

interface RemotiveJob {
  id?: number;
  url?: string;
  title?: string;
  company_name?: string;
  category?: string;
  tags?: string[];
  publication_date?: string;
  candidate_required_location?: string;
  description?: string;
}

interface RemotiveResponse {
  jobs?: RemotiveJob[];
}

/** Remotive's public remote-jobs API. Smaller than RemoteOK, but dated. */
export async function fetchRemotive(limit: number): Promise<Startup[]> {
  const data = await fetchJson<RemotiveResponse>(
    `https://remotive.com/api/remote-jobs?limit=${Math.min(limit, 100)}`,
    { headers: { accept: "application/json" } },
  );

  const out: Startup[] = [];
  for (const job of data.jobs ?? []) {
    if (!job.title || !job.company_name) continue;
    if (!isTechRole(job.title)) continue;

    const location = job.candidate_required_location?.trim();
    const industry = [...(job.tags ?? [])];
    if (job.category) industry.push(job.category);

    out.push({
      id: `remotive:${job.id ?? job.url ?? job.company_name}`,
      name: job.company_name.trim(),
      oneLiner: job.title,
      description: job.description ? htmlToText(job.description).slice(0, 4000) : undefined,
      url: job.url,
      locations: location ? [location] : [],
      remote: true,
      industry,
      source: "remotive",
      signals: [
        {
          type: "hiring",
          date: job.publication_date,
          text: `${job.company_name.trim()} — ${job.title}${location ? ` (${location})` : ""}`,
          url: job.url,
        },
      ],
    });
  }

  return out;
}
