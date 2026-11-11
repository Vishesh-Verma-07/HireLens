import { fetchText } from "../lib/http.js";
import { logger } from "../lib/log.js";
import { isTechRole, slug } from "../lib/text.js";
import type { SourceId, Startup } from "../types.js";
import type { BaseSourceConfig, SourceContext } from "./types.js";

export const sourceId = "wellfound" as const satisfies SourceId;

export interface WellfoundConfig extends BaseSourceConfig {
  limit?: number;
  /**
   * Accepted so `sources.yaml` can keep a slot for a future authenticated API.
   * The public role pages below need no key, so it is not sent anywhere.
   */
  apiKey?: string;
  /** Wellfound role slugs, or the short aliases used in `SOURCE_DEFAULTS`. */
  categories?: string[];
}

const BASE_URL = "https://wellfound.com";

/**
 * Wellfound serves an `application/json` security challenge to plain clients,
 * but the public role pages render for a browser user agent.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Job listings per role page, as reported by the page itself. */
const PER_PAGE = 20;

/** Never walk more than this many pages for one category. */
const MAX_PAGES_PER_CATEGORY = 10;

const DEFAULT_CATEGORIES = ["engineering", "product", "design"];

/**
 * The config defaults use friendly bucket names; Wellfound URLs use role
 * slugs. Anything already a slug passes through unchanged.
 */
const ROLE_ALIASES: Record<string, string> = {
  engineering: "software-engineer",
  engineer: "software-engineer",
  "software-engineering": "software-engineer",
  product: "product-manager",
  "product-management": "product-manager",
  design: "designer",
  "product-design": "designer",
  data: "data-scientist",
};

/**
 * Wellfound's stage badges are coarse buckets, while `Startup.stage` is the
 * normalized seed/series vocabulary the scorer compares with the profile.
 */
const STAGE_BY_BUCKET: Record<string, string> = {
  early_stage: "seed",
  growth_stage: "series-b",
  scale_stage: "series-c",
};

interface PageProps {
  role?: unknown;
  apolloState?: { data?: unknown };
}

interface JobEntry {
  startup: Record<string, unknown>;
  job: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Wellfound's job search is a Next.js page whose full result set lives in the
 * `__NEXT_DATA__` JSON blob (Apollo cache), not in a public REST endpoint. The
 * blob is the page's own data payload, so parsing it gives the same jobs the
 * browser renders without any authentication.
 */
function propsFromHtml(html: string): PageProps | undefined {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!match?.[1]) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed) || !isRecord(parsed.props)) return undefined;
  return isRecord(parsed.props.pageProps)
    ? (parsed.props.pageProps as PageProps)
    : undefined;
}

function apolloState(props: PageProps): Record<string, unknown> | undefined {
  const state = props.apolloState;
  return isRecord(state) && isRecord(state.data) ? state.data : undefined;
}

/** The `seoLandingPageJobSearchResults` entry for the role page. */
function readResults(state: Record<string, unknown>): Record<string, unknown> | undefined {
  const root = state.ROOT_QUERY;
  if (!isRecord(root) || !isRecord(root.talent)) return undefined;

  for (const [key, value] of Object.entries(root.talent)) {
    if (!key.startsWith("seoLandingPageJobSearchResults")) continue;
    if (isRecord(value) && Array.isArray(value.startups)) return value;
  }

  return undefined;
}

/**
 * Flattens `startups[].highlightedJobListings[]` back into (startup, job)
 * pairs. The Apollo cache stores references, so both sides need resolving.
 */
function readJobEntries(
  state: Record<string, unknown>,
  results: Record<string, unknown>,
): JobEntry[] {
  const entries: JobEntry[] = [];

  for (const reference of results.startups as unknown[]) {
    const startupRef = isRecord(reference) ? stringValue(reference.__ref) : undefined;
    if (!startupRef) continue;

    const startup = state[startupRef];
    if (!isRecord(startup) || !stringValue(startup.name)) continue;

    const listings = Array.isArray(startup.highlightedJobListings)
      ? startup.highlightedJobListings
      : [];

    for (const listing of listings) {
      const jobRef = isRecord(listing) ? stringValue(listing.__ref) : undefined;
      if (!jobRef) continue;

      const job = state[jobRef];
      if (!isRecord(job)) continue;
      if (job.id === undefined || !stringValue(job.title)) continue;

      entries.push({ startup, job });
    }
  }

  return entries;
}

function roleFromCategory(category: string): string {
  const text = category.trim();
  const urlMatch = text.match(/wellfound\.com\/role\/r\/([^/?#]+)/i);
  const raw = urlMatch?.[1] ?? text.replace(/^\/?role\/r\//i, "");
  return ROLE_ALIASES[raw.toLowerCase()] ?? slug(raw);
}

function resolveCategories(categories: string[] | undefined): string[] {
  const configured = (categories ?? []).filter(
    (category) => typeof category === "string" && category.trim() !== "",
  );
  const source = configured.length > 0 ? configured : DEFAULT_CATEGORIES;
  return [...new Set(source.map(roleFromCategory))];
}

function isoFromEpoch(value: unknown): string | undefined {
  const seconds = numberValue(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function readStage(
  state: Record<string, unknown>,
  startup: Record<string, unknown>,
): string | undefined {
  const badges = Array.isArray(startup.badges) ? startup.badges : [];

  for (const reference of badges) {
    const ref = isRecord(reference) ? stringValue(reference.__ref) : undefined;
    if (!ref) continue;

    const badge = state[ref];
    if (!isRecord(badge)) continue;

    const bucket = stringValue(badge.data);
    const stage = bucket ? STAGE_BY_BUCKET[bucket] : undefined;
    if (stage) return stage;
  }

  return undefined;
}

/** `SIZE_51_200` → `51-200`, `SIZE_1001_PLUS` → `1001+`. */
function employeesFromSize(value: unknown): string | undefined {
  const size = stringValue(value);
  const match = size?.match(/^SIZE_(\d+)(?:_(\d+|PLUS))?$/i);
  if (!match?.[1]) return undefined;

  const [, min, max] = match;
  if (!max) return min;
  return max.toUpperCase() === "PLUS" ? `${min}+` : `${min}-${max}`;
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = stringValue(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function mapEntry(
  state: Record<string, unknown>,
  entry: JobEntry,
): Startup | undefined {
  const name = stringValue(entry.startup.name);
  const title = stringValue(entry.job.title);
  if (!name || !title) return undefined;

  // Job boards mix sales, ops and support into every category.
  if (!isTechRole(title)) return undefined;

  const id = String(entry.job.id);
  const jobSlug = stringValue(entry.job.slug) ?? slug(title);
  const url = `${BASE_URL}/jobs/${encodeURIComponent(id)}-${jobSlug}`;

  const locations = uniqueStrings(entry.job.locationNames);
  const remoteKind = isRecord(entry.job.remoteConfig)
    ? stringValue(entry.job.remoteConfig.kind)
    : undefined;
  const remote =
    entry.job.remote === true ||
    remoteKind === "REMOTE" ||
    locations.some((location) => /remote/i.test(location));

  const compensation = stringValue(entry.job.compensation);
  const yearsExperience = numberValue(entry.job.yearsExperienceMin);
  const primaryRole = stringValue(entry.job.primaryRoleTitle);
  const postedAt = isoFromEpoch(entry.job.liveStartAt);

  const description = [
    stringValue(entry.job.description),
    compensation ? `Compensation: ${compensation}` : undefined,
    yearsExperience ? `Experience: ${yearsExperience}+ years` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n")
    .slice(0, 4000);

  return {
    id: `wellfound:${id}`,
    name,
    oneLiner: title,
    description: description || undefined,
    url,
    locations,
    remote: remote || undefined,
    stage: readStage(state, entry.startup),
    industry: primaryRole ? [primaryRole] : [],
    employees: employeesFromSize(entry.startup.companySize),
    source: sourceId,
    signals: [
      {
        type: "hiring",
        date: postedAt,
        text: `${name} — ${title}${compensation ? ` (${compensation})` : ""}`,
        url,
      },
    ],
  };
}

/**
 * Wellfound (formerly AngelList Talent) startup jobs.
 *
 * There is no unauthenticated JSON API any more: `wellfound.com/graphql`
 * answers with a security challenge. The public `/role/r/{role}` pages are
 * still server-rendered with the full result set in `__NEXT_DATA__`, so this
 * source walks those pages, filters to technical titles, and maps each
 * startup/job pair to a `Startup`. One category failing never sinks the rest.
 */
export async function fetchWellfound(
  config: WellfoundConfig = {},
  _context?: SourceContext,
): Promise<Startup[]> {
  const limit = config.limit ?? 100;
  const categories = resolveCategories(config.categories);
  const maxPages = Math.min(
    MAX_PAGES_PER_CATEGORY,
    Math.max(1, Math.ceil(limit / PER_PAGE)),
  );

  const seen = new Set<string>();
  const out: Startup[] = [];

  for (const role of categories) {
    for (let page = 1; page <= maxPages; page += 1) {
      if (out.length >= limit) return out.slice(0, limit);

      const url = `${BASE_URL}/role/r/${encodeURIComponent(role)}?page=${page}`;

      let html: string;
      try {
        html = await fetchText(url, {
          headers: {
            "user-agent": BROWSER_UA,
            accept: "text/html,application/xhtml+xml",
          },
        });
      } catch (error) {
        logger.warn(
          `wellfound: ${role} page ${page} failed — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        break;
      }

      const props = propsFromHtml(html);
      if (!props) {
        logger.warn(`wellfound: ${role} page ${page} had no __NEXT_DATA__ payload`);
        break;
      }

      // Unknown roles redirect to the generic /remote page; its jobs do not
      // belong to the requested category, so skip rather than duplicate them.
      if (stringValue(props.role) !== role) {
        logger.debug(`wellfound: role "${role}" is not a Wellfound slug — skipping`);
        break;
      }

      const state = apolloState(props);
      const results = state ? readResults(state) : undefined;
      if (!state || !results) break;

      const entries = readJobEntries(state, results);
      if (entries.length === 0) break;

      for (const entry of entries) {
        if (out.length >= limit) break;
        const startup = mapEntry(state, entry);
        if (!startup || seen.has(startup.id)) continue;
        seen.add(startup.id);
        out.push(startup);
      }

      const pageCount = numberValue(results.pageCount);
      if (pageCount !== undefined && page >= pageCount) break;
    }
  }

  return out.slice(0, limit);
}
