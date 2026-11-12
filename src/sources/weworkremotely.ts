import { isTechRole, slug } from "../lib/text.js";
import type { SourceId, Startup } from "../types.js";
import { fetchFeed, type FeedItem } from "./rss.js";
import type { BaseSourceConfig, SourceContext } from "./types.js";

export const sourceId = "weworkremotely" as const satisfies SourceId;

export interface WeWorkRemotelyConfig extends BaseSourceConfig {
  /** Maximum number of jobs to return. */
  limit?: number;
  /** RSS feed to read. Defaults to the remote-programming category feed. */
  feedUrl?: string;
}

/** Every WWR posting is remote, so the feed URL selects the niche, not the location. */
export const DEFAULT_FEED_URL =
  "https://weworkremotely.com/categories/remote-programming-jobs.rss";

const DEFAULT_LIMIT = 100;

/**
 * WWR categories look like "Full-Stack Programming", "DevOps and Sysadmin",
 * "Back-End Programming", while design, marketing, sales, and support have
 * their own non-technical categories. Matching the category (not the feed URL)
 * keeps a `feedUrl` pointed at the all-jobs feed from flooding the digest.
 */
const PROGRAMMING_CATEGORY =
  /(programming|developer|engineering|software|devops|sre|data|machine learning|artificial intelligence|\bai\b|full[- ]?stack|back[- ]?end|front[- ]?end|mobile|qa\b|quality assurance|security|systems|database|cloud)/i;

/** True when a WWR category names a programming/engineering discipline. */
export function isProgrammingCategory(category: string): boolean {
  return PROGRAMMING_CATEGORY.test(category);
}

/**
 * WWR titles are "Company: Role". A title without a company prefix is kept
 * as-is so a parsing change upstream never drops a real posting silently;
 * `isTechRole` still has to accept it.
 */
export function parseWwrTitle(title: string): { company: string; role: string } {
  const match = title.match(/^(.+?):\s+(.+)$/);
  if (!match?.[1] || !match[2]) {
    const text = title.trim();
    return { company: text, role: text };
  }
  return { company: match[1].trim(), role: match[2].trim() };
}

/** RFC 2822 pubDates become the ISO 8601 dates the shared contract expects. */
function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/**
 * The local id is WWR's slug, taken from the guid (or link). Both are
 * `https://weworkremotely.com/remote-jobs/<slug>` today; falling back to the
 * title keeps the id stable if a feed variant omits them.
 */
function localId(item: FeedItem, title: string): string {
  for (const candidate of [item.guid, item.link]) {
    if (!candidate) continue;

    const path = candidate.split(/[?#]/)[0] ?? "";
    const segment = path.split("/").filter(Boolean).pop();
    if (segment) return decodeURIComponent(segment).trim();
  }

  const { company, role } = parseWwrTitle(title);
  return slug(`${company} ${role}`);
}

function descriptionFor(item: FeedItem): string | undefined {
  const text = (item.description ?? item.summary)?.trim();
  return text ? text.slice(0, 4000) : undefined;
}

function mapItem(item: FeedItem): Startup | undefined {
  const category = item.category?.trim();
  if (category && !isProgrammingCategory(category)) return undefined;

  const { company, role } = parseWwrTitle(item.title);
  if (!company || !role || !isTechRole(role)) return undefined;

  const region = item.region?.trim();
  const locations = region ? [region] : ["Remote"];
  const date = isoDate(item.date);
  const id = localId(item, item.title);
  if (!id) return undefined;

  return {
    id: `${sourceId}:${id}`,
    name: company,
    oneLiner: role,
    description: descriptionFor(item),
    url: item.link,
    locations,
    remote: true,
    industry: category ? [category] : [],
    source: sourceId,
    signals: [
      {
        type: "hiring",
        date,
        text: `${company} — ${role}${region ? ` (${region})` : ""}`,
        url: item.link,
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
 * We Work Remotely's public RSS feed.
 *
 * Reads the programming feed (or any `feedUrl` override), keeps technical
 * roles only, and maps each item to a remote `Startup`. The category filter
 * matters when `feedUrl` points at the all-jobs feed, because that feed mixes
 * design/marketing postings into the same list.
 */
export async function fetchWeWorkRemotely(
  config: WeWorkRemotelyConfig = {},
  _context?: SourceContext,
): Promise<Startup[]> {
  const limit = config.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) return [];

  const feedUrl = config.feedUrl?.trim() || DEFAULT_FEED_URL;
  const items = await fetchFeed(feedUrl);

  const seen = new Set<string>();
  const out: Startup[] = [];

  for (const item of items) {
    const startup = mapItem(item);
    if (!startup || seen.has(startup.id)) continue;

    seen.add(startup.id);
    out.push(startup);
  }

  out.sort((left, right) => freshness(right) - freshness(left));

  return out.slice(0, limit);
}
