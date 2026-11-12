import { isTechRole, slug } from "../lib/text.js";
import type { SourceId, Startup } from "../types.js";
import { fetchFeed, type FeedItem } from "./rss.js";
import type { BaseSourceConfig, SourceContext } from "./types.js";

export const sourceId = "remoteco" as const satisfies SourceId;

export interface RemoteCoConfig extends BaseSourceConfig {
  /** Maximum number of jobs to return. */
  limit?: number;
  /** RSS feed to read. Defaults to Remote.co's public remote-jobs feed. */
  feedUrl?: string;
}

/** Remote.co's public WordPress (WP Job Manager) job feed. */
export const DEFAULT_FEED_URL = "https://remote.co/remote-jobs/feed/";

const DEFAULT_LIMIT = 100;

/** Employment type labels are not useful as industry tags. */
const EMPLOYMENT_TYPE = /^(full[- ]?time|part[- ]?time|contract|freelance|temporary|internship)$/i;

/** RFC 2822 `pubDate` values become the ISO 8601 dates the contract expects. */
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
 * `remoteco:{slug-or-guid}`.
 *
 * WP Job Manager writes the permalink into both `guid` and `link`
 * (`https://remote.co/remote-jobs/<slug>/`), so its last path segment is the
 * stable id. A feed item without a usable URL falls back to a derived
 * company+title slug, which keeps the cross-run dedupe key deterministic.
 */
function localId(item: FeedItem, company: string): string {
  for (const candidate of [item.guid, item.link]) {
    if (!candidate) continue;

    try {
      const segments = new URL(candidate).pathname.split("/").filter(Boolean);
      const last = segments.at(-1);
      if (last && /^[a-z0-9-]+$/i.test(last)) return last.toLowerCase();
    } catch {
      // Not a parseable URL; try the next candidate.
    }
  }

  return slug(`${company} ${item.title}`);
}

/** Department/type labels minus employment types, used as industry tags. */
function industryLabels(item: FeedItem): string[] {
  return (item.categories ?? []).filter((tag) => !EMPLOYMENT_TYPE.test(tag));
}

function descriptionFor(item: FeedItem): string | undefined {
  const text = (item.description ?? item.summary)?.trim();
  return text ? text.slice(0, 4000) : undefined;
}

function freshness(startup: Startup): number {
  const date = startup.signals[0]?.date;
  const time = date ? Date.parse(date) : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Remote.co's public RSS feed.
 *
 * Remote.co runs WordPress with WP Job Manager, so each `<item>` is a
 * `job_listing`: the title is the role, `job_listing:company` names the
 * employer, and `job_listing:location` / `job_listing:job_type` carry the
 * location and department. The feed mixes engineering, design, marketing and
 * sales postings, so only technical titles are kept.
 */
export async function fetchRemoteCo(
  config: RemoteCoConfig = {},
  _context?: SourceContext,
): Promise<Startup[]> {
  const limit = config.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) return [];

  const feedUrl = config.feedUrl?.trim() || DEFAULT_FEED_URL;
  const items = await fetchFeed(feedUrl);

  const seen = new Set<string>();
  const out: Startup[] = [];

  for (const item of items) {
    const role = item.title.trim();
    if (!role || !isTechRole(role)) continue;

    const company = item.company?.trim();
    if (!company) continue;

    const id = `${sourceId}:${localId(item, company)}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const location = item.location?.trim();
    const locations = locationList(location);
    const industry = industryLabels(item);

    out.push({
      id,
      name: company,
      oneLiner: role,
      description: descriptionFor(item),
      url: item.link,
      locations: locations.length > 0 ? locations : ["Remote"],
      // Remote.co is a remote-only board, even when the feed names a region.
      remote: true,
      industry,
      source: sourceId,
      signals: [
        {
          type: "hiring",
          date: isoDate(item.date),
          text: `${company} - ${role}${location ? ` (${location})` : ""}`,
          url: item.link,
        },
      ],
    });
  }

  out.sort((left, right) => freshness(right) - freshness(left));

  return out.slice(0, limit);
}
