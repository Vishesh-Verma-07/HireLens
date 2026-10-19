import { fetchJson } from "../lib/http.js";
import { htmlToText, isTechRole } from "../lib/text.js";
import type { Startup } from "../types.js";

interface RemoteOkJob {
  id?: string;
  slug?: string;
  date?: string;
  company?: string;
  position?: string;
  tags?: string[];
  location?: string;
  url?: string;
  apply_url?: string;
  description?: string;
}

/**
 * RemoteOK's public JSON feed. Fresh remote jobs, usually updated daily.
 * The first array element is an attribution notice, so we skip anything
 * without a position.
 */
export async function fetchRemoteOk(limit: number): Promise<Startup[]> {
  const data = await fetchJson<unknown>("https://remoteok.com/api", {
    headers: { accept: "application/json" },
  });

  const items = Array.isArray(data) ? data : [];
  const out: Startup[] = [];

  for (const raw of items) {
    const job = raw as RemoteOkJob;
    if (!job?.position || !job?.company) continue;
    if (!isTechRole(job.position)) continue;

    const location = job.location?.trim();
    const url = job.url ?? job.apply_url;

    out.push({
      id: `remoteok:${job.id ?? job.slug ?? job.company}`,
      name: job.company,
      oneLiner: job.position,
      description: job.description ? htmlToText(job.description).slice(0, 4000) : undefined,
      url,
      locations: location ? [location] : [],
      remote: true,
      industry: job.tags ?? [],
      source: "remoteok",
      signals: [
        {
          type: "hiring",
          date: job.date,
          text: `${job.company} — ${job.position}${location ? ` (${location})` : ""}`,
          url,
        },
      ],
    });

    if (out.length >= limit) break;
  }

  return out;
}
