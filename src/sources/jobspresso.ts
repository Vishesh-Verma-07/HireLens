import { isTechRole, slug } from "../lib/text.js";
import type { SourceId, Startup } from "../types.js";
import type { JobspressoConfig } from "./config.js";
import { fetchFeed, type FeedItem } from "./rss.js";
import type { SourceContext } from "./types.js";

export const sourceId = "jobspresso" as const satisfies SourceId;

/** Jobspresso's public WordPress job feed. */
export const DEFAULT_FEED_URL = "https://jobspresso.co/?feed=job_feed";

/** Employment type labels are not useful as industry tags. */
const EMPLOYMENT_TYPE =
  /^(full[- ]?time|part[- ]?time|contract|freelance|temporary|internship)$/i;

/** RFC 2822 dates from RSS are normalized to the ISO 8601 the contract expects. */
function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** "United States, Canada" -> ["United States", "Canada"]. */
function locationList(location: string | undefined): string[] {
  if (!location) return [];
  return location
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * `jobspresso:{slug-or-guid}`.
 *
 * The posting URL ends in a stable slug (`/job/senior-engineer-acme/`); when a
 * feed item has no usable link, a company+title slug is derived instead.
 */
function localId(item: FeedItem, company: string): string {
  if (item.link) {
    try {
      const segments = new URL(item.link).pathname.split("/").filter(Boolean);
      const last = segments.at(-1);
      if (last && /^[a-z0-9-]+$/i.test(last)) return last.toLowerCase();
    } catch {
      // Not a parseable URL; fall back to the derived slug below.
    }
  }
  return slug(`${company} ${item.title}`);
}

/**
 * Jobspresso's public RSS feed. Filters to technical roles and maps each
 * posting to a `Startup` whose hiring signal is the job itself.
 */
export async function fetchJobspresso(
  config: JobspressoConfig = {},
  _context?: SourceContext,
): Promise<Startup[]> {
  const limit = config.limit ?? 100;
  const feedUrl = config.feedUrl ?? DEFAULT_FEED_URL;
  const items = await fetchFeed(feedUrl);

  const out: Startup[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (out.length >= limit) break;
    if (!isTechRole(item.title)) continue;

    const company = item.company?.trim();
    if (!company) continue;

    const id = `jobspresso:${localId(item, company)}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const industry = (item.categories ?? []).filter(
      (tag) => !EMPLOYMENT_TYPE.test(tag),
    );

    out.push({
      id,
      name: company,
      oneLiner: item.title,
      description: item.summary,
      url: item.link,
      locations: locationList(item.location),
      // Jobspresso is a remote-only board, even when the feed names a region.
      remote: true,
      industry,
      source: sourceId,
      signals: [
        {
          type: "hiring",
          date: isoDate(item.date),
          text: `${company} - ${item.title}`,
          url: item.link,
        },
      ],
    });
  }

  return out;
}
