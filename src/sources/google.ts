// Google search source for the "Board Scan" method.
//
// It compiles the profile into the same Google query the `scan` CLI previews,
// runs that query through a Google results API, keeps the links that point at
// the selected ATS boards, turns each result into a Startup, and optionally
// fetches the public job page so the matcher has more than a snippet to score.

import { fetchText } from "../lib/http.js";
import { logger } from "../lib/log.js";
import {
  decodeEntities,
  htmlToText,
  normalizeWhitespace,
  slug,
} from "../lib/text.js";
import type { Board } from "../scan/boards.js";
import {
  dateRestrict,
  isLevelId,
  isSetupId,
  isTimeId,
  scanForProfile,
  tbs,
  timeLabel,
  type LevelId,
  type SetupId,
  type TimeId,
} from "../scan/query.js";
import type { Profile, SourceId, Startup } from "../types.js";
import type { SourceContext } from "./types.js";

export const sourceId = "google" as const satisfies SourceId;

export interface GoogleSourceConfig {
  enabled?: boolean;
  /** Maximum ATS results kept across all runs. */
  limit?: number;
  /** Result pages to fetch per run (10 results per page). */
  pages?: number;
  /** Fetch each ATS page to score its full text instead of the snippet. */
  enrich?: boolean;
  /** How many ATS pages to fetch at most. */
  enrichLimit?: number;
  /** Google country code (gl), e.g. "us" or "in". */
  country?: string;
  /** Boards to query individually when the combined query drops the site filter. */
  siteQueries?: number;
  /** Also search Google Jobs, which surfaces roles outside the ATS boards. */
  jobs?: boolean;
  /** Google Jobs query; defaults to the profile's first role + remote. */
  jobsQuery?: string;
  /** Google Jobs location; defaults to the profile's first non-remote location. */
  jobsLocation?: string;
  /** Google Jobs country code; defaults from jobsLocation. */
  jobsCountry?: string;
  /** Maximum Google Jobs results kept. */
  jobsLimit?: number;
  roles?: string[];
  location?: string;
  posted?: TimeId;
  level?: LevelId;
  setup?: SetupId;
  boards?: string;
  variants?: boolean;
  sponsored?: boolean;
}

interface SearchResult {
  title: string;
  link: string;
  snippet: string;
  /** ISO date or a relative string such as "2 days ago". */
  date?: string;
}

interface SerpApiResponse {
  organic_results?: Array<{
    title?: string;
    link?: string;
    snippet?: string;
    date?: string;
  }>;
  error?: string;
}

interface CseResponse {
  items?: Array<{
    title?: string;
    link?: string;
    snippet?: string;
    pagemap?: { metatags?: Array<Record<string, string>> };
  }>;
  error?: { message?: string };
}

interface GoogleJobsResponse {
  jobs_results?: Array<{
    title?: string;
    job_title?: string;
    company_name?: string;
    location?: string;
    description?: string;
    source_link?: string;
    share_link?: string;
    via?: string;
    extensions?: string[];
    detected_extensions?: {
      posted_at?: string;
      schedule_type?: string;
      work_from_home?: boolean;
    };
    apply_options?: Array<{ title?: string; link?: string }>;
  }>;
  error?: string;
}

const GENERIC_LABELS = new Set([
  "www",
  "jobs",
  "job",
  "job-boards",
  "boards",
  "apply",
  "ats",
  "recruiting",
  "careers",
  "career",
  "home",
  "company",
  "companies",
  "en",
  "en-us",
  "en-gb",
  "us",
  "remote-jobs",
  "job-detail",
  "detail",
  "positions",
  "position",
  "opening",
  "openings",
  "view",
  "embed",
  "job_app",
  "application",
  "applications",
  "job-details",
  "jobdetail",
]);

const ROLE_NOUN =
  /(?<![a-z])(engineer|engineering|developer|programmer|software|full[- ]?stack|front[- ]?end|back[- ]?end|devops|sre|platform|architect|data|machine learning|ml|ai|qa|tester|designer|scientist|analyst|administrator|specialist|consultant|manager|director|lead|intern|fresher|sales|account|marketing|customer|support|finance|operations|recruiter|talent|nurse|attorney|teacher|accountant|representative)(?![a-z])/i;

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function googleConfigured(): boolean {
  return Boolean(
    env("SERPAPI_KEY") ||
      (env("GOOGLE_API_KEY") && env("GOOGLE_CSE_ID")),
  );
}

/** Local JSON fetch: API keys live in the query string, so no URL in errors. */
async function fetchJsonSecret<T>(url: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let detail = "";
      try {
        const parsed = JSON.parse(body) as {
          error?: string | { message?: string };
        };
        detail =
          typeof parsed.error === "string"
            ? parsed.error
            : (parsed.error?.message ?? "");
      } catch {
        // Non-JSON error body; the status is enough.
      }
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function searchSerpApi(
  key: string,
  query: string,
  time: TimeId,
  pages: number,
  max: number,
  country: string,
): Promise<SearchResult[]> {
  const out: SearchResult[] = [];

  for (let page = 0; page < pages && out.length < max; page++) {
    const params = new URLSearchParams({
      engine: "google",
      q: query,
      api_key: key,
      num: "10",
      start: String(page * 10),
      hl: "en",
      gl: country,
    });
    const filter = tbs(time);
    if (filter) params.set("tbs", filter);

    let data: SerpApiResponse;
    try {
      data = await fetchJsonSecret<SerpApiResponse>(
        `https://serpapi.com/search.json?${params.toString()}`,
      );
    } catch (err) {
      if (page === 0) throw err;
      logger.warn(
        `google: SerpAPI page ${page + 1} failed — ${(err as Error).message}`,
      );
      break;
    }
    if (data.error) {
      if (page === 0) throw new Error(`SerpAPI: ${data.error}`);
      logger.warn(`google: SerpAPI page ${page + 1} failed — ${data.error}`);
      break;
    }

    const results = data.organic_results ?? [];
    for (const result of results) {
      if (!result.title || !result.link) continue;
      out.push({
        title: result.title,
        link: result.link,
        snippet: result.snippet ?? "",
        date: result.date,
      });
      if (out.length >= max) break;
    }
    if (results.length < 10) break;
  }

  return out;
}

function cseDate(item: NonNullable<CseResponse["items"]>[number]): string | undefined {
  const meta = item.pagemap?.metatags?.[0];
  if (!meta) return undefined;
  return (
    meta["article:published_time"] ??
    meta["date"] ??
    meta["og:updated_time"] ??
    meta["article:modified_time"]
  );
}

async function searchCse(
  key: string,
  cx: string,
  query: string,
  time: TimeId,
  pages: number,
  max: number,
  country: string,
): Promise<SearchResult[]> {
  const out: SearchResult[] = [];

  for (let page = 0; page < pages && out.length < max; page++) {
    const params = new URLSearchParams({
      key,
      cx,
      q: query,
      num: "10",
      start: String(page * 10 + 1),
      hl: "en",
      gl: country,
    });
    const filter = dateRestrict(time);
    if (filter) params.set("dateRestrict", filter);

    let data: CseResponse;
    try {
      data = await fetchJsonSecret<CseResponse>(
        `https://www.googleapis.com/customsearch/v1?${params.toString()}`,
      );
    } catch (err) {
      if (page === 0) throw err;
      logger.warn(
        `google: Custom Search page ${page + 1} failed — ${(err as Error).message}`,
      );
      break;
    }
    if (data.error) {
      if (page === 0) {
        throw new Error(`Google CSE: ${data.error.message ?? "request failed"}`);
      }
      logger.warn(
        `google: Custom Search page ${page + 1} failed — ${data.error.message ?? "request failed"}`,
      );
      break;
    }

    const items = data.items ?? [];
    for (const item of items) {
      if (!item.title || !item.link) continue;
      out.push({
        title: item.title,
        link: item.link,
        snippet: item.snippet ?? "",
        date: cseDate(item),
      });
      if (out.length >= max) break;
    }
    if (items.length < 10) break;
  }

  return out;
}

/**
 * Runs one Google query. SerpAPI is preferred when both providers are set
 * because it returns Google's result dates directly; CSE is the fallback.
 */
async function searchGoogle(
  query: string,
  time: TimeId,
  pages: number,
  max: number,
  country: string,
): Promise<SearchResult[]> {
  const errors: string[] = [];

  const serpKey = env("SERPAPI_KEY");
  if (serpKey) {
    try {
      return await searchSerpApi(serpKey, query, time, pages, max, country);
    } catch (err) {
      errors.push((err as Error).message);
      logger.warn(`google: SerpAPI failed — ${(err as Error).message}`);
    }
  }

  const cseKey = env("GOOGLE_API_KEY");
  const cseId = env("GOOGLE_CSE_ID");
  if (cseKey && cseId) {
    try {
      return await searchCse(cseKey, cseId, query, time, pages, max, country);
    } catch (err) {
      errors.push((err as Error).message);
      logger.warn(`google: Custom Search failed — ${(err as Error).message}`);
    }
  }

  throw new Error(
    errors.length > 0
      ? errors.join("; ")
      : "Google search is not configured (set SERPAPI_KEY or GOOGLE_API_KEY + GOOGLE_CSE_ID)",
  );
}

function parseUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function hostWithoutWildcard(board: Board): string {
  return board.domain.replace(/^\*\./, "").toLowerCase();
}

function boardFor(url: URL, boards: Board[]): Board | undefined {
  const host = url.hostname.toLowerCase();
  return boards.find((board) => {
    const domain = hostWithoutWildcard(board);
    return host === domain || host.endsWith(`.${domain}`);
  });
}

function urlKey(raw: string): string | undefined {
  const url = parseUrl(raw);
  if (!url) return undefined;
  return `${url.hostname}${url.pathname}`
    .toLowerCase()
    .replace(/\/+$/, "");
}

function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];

  for (const result of results) {
    const key = urlKey(result.link);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }

  return out;
}

function prettify(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function cleanCompany(value: string): string {
  return value
    .replace(/\s*[-–—|]\s*(careers?|jobs?|hiring|talent)\s*$/i, "")
    .replace(/\s+(careers?|jobs?)$/i, "")
    .trim();
}

function cleanRole(value: string): string {
  return value
    .replace(/\s*[([][^)\]]*(remote|hybrid|onsite|on-site)[^)\]]*[)\]]\s*$/i, "")
    .replace(/\s*[-–—|]\s*(remote|hybrid|onsite|on-site)\s*$/i, "")
    .replace(/\s+in\s+(remote|hybrid|onsite|on-site)\s*$/i, "")
    .trim();
}

function hostCompany(host: string, board: Board): string | undefined {
  const base = hostWithoutWildcard(board);
  if (host === base || !host.endsWith(`.${base}`)) return undefined;

  const prefix = host.slice(0, host.length - base.length - 1);
  const first = prefix.split(".")[0];
  if (
    !first ||
    first.length < 2 ||
    GENERIC_LABELS.has(first.toLowerCase()) ||
    /^wd\d+$/i.test(first)
  ) {
    return undefined;
  }
  return first;
}

function pathCompany(url: URL): string | undefined {
  for (const raw of url.pathname.split("/").filter(Boolean)) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      segment = raw;
    }
    const lower = segment.toLowerCase();
    if (GENERIC_LABELS.has(lower)) continue;
    if (/^\d+$/.test(lower) || /^[0-9a-f-]{16,}$/i.test(lower)) continue;
    if (lower.length < 2 || lower.length > 50) continue;
    return segment;
  }
  return undefined;
}

interface ParsedTitle {
  role: string;
  company?: string;
}

function parseTitle(raw: string): ParsedTitle {
  const title = normalizeWhitespace(decodeEntities(raw))
    .replace(
      /\s*[|·]\s*(linkedin|lever|greenhouse|ashby|workday|workable|smartrecruiters|rippling|bamboohr|breezy|teamtailor|recruitee|pinpoint|jazzhr|personio|indeed|glassdoor)\s*$/i,
      "",
    )
    .replace(/\s*[-–—]\s*(jobs?|careers?|hiring)\s*$/i, "")
    .trim();

  let match = title.match(/^job application for\s+(.+?)\s+at\s+(.+)$/i);
  if (match?.[1] && match[2]) {
    return { role: match[1].trim(), company: match[2].trim() };
  }

  match = title.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (match?.[1] && match[2]) {
    return { role: match[1].trim(), company: match[2].trim() };
  }

  match = title.match(/^(.+?)\s+(?:is\s+)?hiring\s+(?:a|an|our)?\s*(.+)$/i);
  if (match?.[1] && match[2]) {
    return { role: match[2].trim(), company: match[1].trim() };
  }

  const parts = title.split(/\s*[|–—]\s*|\s+-\s+/);
  if (parts.length >= 2) {
    const first = parts[0]?.trim() ?? "";
    const rest = parts.slice(1).join(" - ").trim();
    const firstIsRole = ROLE_NOUN.test(first);
    const restIsRole = ROLE_NOUN.test(rest);
    if (firstIsRole && !restIsRole) return { role: first, company: rest };
    if (restIsRole && !firstIsRole) return { role: rest, company: first };
  }

  return { role: title };
}

function companyName(result: SearchResult, url: URL, board: Board): string | undefined {
  const parsed = parseTitle(result.title);
  const fromHost = hostCompany(url.hostname.toLowerCase(), board);
  const fromPath = pathCompany(url);
  // ATS hosts/paths are the most reliable source of the company slug. On
  // aggregator boards, prefer the title ("Acme - Software Engineer").
  const urlCompany = fromHost ?? (board.core ? fromPath : undefined);
  const pathFallback =
    !board.core && fromPath && !ROLE_NOUN.test(fromPath) ? fromPath : undefined;
  const raw = urlCompany ?? parsed.company ?? pathFallback;
  if (!raw) return undefined;

  const cleaned = cleanCompany(raw);
  if (!cleaned || cleaned.length < 2 || cleaned.length > 60) return undefined;
  if (GENERIC_LABELS.has(cleaned.toLowerCase())) return undefined;
  return prettify(cleaned);
}

function parseDate(raw: string | undefined, now: number): string | undefined {
  if (!raw) return undefined;

  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();

  const relative = raw.match(/(\d+)\s*(hour|day|week|month|year)s?\s+ago/i);
  if (relative?.[1] && relative[2]) {
    const count = Number.parseInt(relative[1], 10);
    const unit = relative[2].toLowerCase();
    const ms = unit.startsWith("hour")
      ? 3_600_000
      : unit.startsWith("day")
        ? 86_400_000
        : unit.startsWith("week")
          ? 604_800_000
          : unit.startsWith("month")
            ? 2_592_000_000
            : 31_536_000_000;
    return new Date(now - count * ms).toISOString();
  }

  if (/today|just now/i.test(raw)) return new Date(now).toISOString();
  if (/yesterday/i.test(raw)) return new Date(now - 86_400_000).toISOString();
  return undefined;
}

function inferLocations(
  text: string,
  queryLocation: string,
  setup: SetupId,
): { locations: string[]; remote?: boolean } {
  const lower = text.toLowerCase();
  const remote =
    setup === "remote" ||
    /^remote$/i.test(queryLocation) ||
    /\bremote\b|work from home|work-from-home|anywhere/.test(lower);
  const locations: string[] = [];
  if (remote) locations.push("Remote");
  if (queryLocation && !/^remote$/i.test(queryLocation)) {
    locations.push(queryLocation);
  }
  return { locations, remote: remote || undefined };
}

function toStartup(
  result: SearchResult,
  boards: Board[],
  opts: { location: string; setup: SetupId; time: TimeId; now: number },
): Startup | undefined {
  const url = parseUrl(result.link);
  if (!url) return undefined;

  const board = boardFor(url, boards);
  if (!board) return undefined;

  const parsed = parseTitle(result.title);
  const role = cleanRole(parsed.role);
  if (!role || role.length > 160) return undefined;
  if (/^(careers?|jobs?|job application|apply|home)$/i.test(role)) return undefined;

  const company = companyName(result, url, board);
  if (!company) return undefined;

  const key = urlKey(result.link);
  if (!key) return undefined;

  const { locations, remote } = inferLocations(
    `${result.title} ${result.snippet} ${url.pathname}`,
    opts.location,
    opts.setup,
  );
  const date =
    parseDate(result.date, opts.now) ??
    (opts.time === "all" ? undefined : new Date(opts.now).toISOString());

  return {
    id: `google:${slug(key)}`,
    name: company,
    oneLiner: role,
    description: result.snippet
      ? normalizeWhitespace(result.snippet).slice(0, 4000)
      : undefined,
    url: result.link,
    locations,
    remote,
    industry: [],
    source: sourceId,
    signals: [
      {
        type: "hiring",
        date,
        text: `${company} — ${role}${locations.length ? ` (${locations.join(", ")})` : ""} · Google ${timeLabel(opts.time)}`,
        url: result.link,
      },
    ],
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      out[index] = await fn(item);
    }
  });

  await Promise.all(workers);
  return out;
}

/** Fetches the public ATS page so the scorer sees more than the snippet. */
async function enrich(startup: Startup): Promise<Startup> {
  if (!startup.url) return startup;
  try {
    const html = await fetchText(startup.url, {
      timeoutMs: 10_000,
      retries: 0,
      headers: { accept: "text/html" },
    });
    const text = htmlToText(html);
    if (text.length > (startup.description?.length ?? 0)) {
      startup.description = text.slice(0, 12_000);
    }
  } catch (err) {
    logger.debug(`google: could not fetch ${startup.url} — ${(err as Error).message}`);
  }
  return startup;
}

/**
 * Google Jobs is a second Google surface: it finds current roles directly,
 * including companies that do not publish on the ATS boards in the catalogue.
 */
async function fetchGoogleJobs(
  profile: Profile,
  config: GoogleSourceConfig,
): Promise<Startup[]> {
  if (config.jobs === false) return [];

  const key = env("SERPAPI_KEY");
  if (!key) return [];

  const role = profile.roles[0] ?? "software engineer";
  const seniority = profile.seniority.toLowerCase();
  const prefix = /junior|entry|fresher/.test(seniority) ? "junior " : "";
  const query = config.jobsQuery?.trim() || `${prefix}${role} remote`;
  const location =
    config.jobsLocation?.trim() ||
    profile.preferences.locations.find((l) => !/^remote$/i.test(l) && l.trim())?.trim() ||
    "India";
  const lowerLocation = location.toLowerCase();
  const country =
    config.jobsCountry?.trim().toLowerCase() ||
    (lowerLocation.includes("india")
      ? "in"
      : /united states|usa|\bus\b/.test(lowerLocation)
        ? "us"
        : config.country?.trim().toLowerCase() || "us");
  const limit = Math.max(1, Math.min(config.jobsLimit ?? 10, 20));

  const params = new URLSearchParams({
    engine: "google_jobs",
    q: query,
    location,
    gl: country,
    hl: "en",
    api_key: key,
  });

  let data: GoogleJobsResponse;
  try {
    data = await fetchJsonSecret<GoogleJobsResponse>(
      `https://serpapi.com/search.json?${params.toString()}`,
    );
  } catch (err) {
    logger.warn(`google: Google Jobs failed — ${(err as Error).message}`);
    return [];
  }
  if (data.error) {
    logger.warn(`google: Google Jobs failed — ${data.error}`);
    return [];
  }

  const now = new Date().toISOString();
  const startups: Startup[] = [];
  for (const job of data.jobs_results ?? []) {
    const title = normalizeWhitespace(job.title ?? job.job_title ?? "");
    const company = normalizeWhitespace(job.company_name ?? "");
    const link =
      job.source_link ??
      job.apply_options?.find((option) => option.link)?.link ??
      job.share_link;
    if (!title || !company || !link) continue;

    const jobLocation = normalizeWhitespace(job.location ?? "");
    const extensions = (job.extensions ?? []).join(" ");
    const remote =
      Boolean(job.detected_extensions?.work_from_home) ||
      /\b(remote|anywhere|work from home|work-from-home)\b/i.test(
        `${jobLocation} ${extensions} ${title}`,
      );

    const locations: string[] = [];
    if (remote) locations.push("Remote");
    if (jobLocation && !/^(anywhere|remote)$/i.test(jobLocation)) {
      locations.push(jobLocation);
    }

    const date =
      parseDate(job.detected_extensions?.posted_at, Date.parse(now)) ?? now;
    const id = `google:job:${slug(`${company}-${title}-${link}`)}`;

    startups.push({
      id,
      name: company,
      oneLiner: title,
      description: job.description
        ? normalizeWhitespace(job.description).slice(0, 12_000)
        : undefined,
      url: link,
      locations,
      remote: remote || undefined,
      industry: [],
      source: sourceId,
      signals: [
        {
          type: "hiring",
          date,
          text: `${company} — ${title}${locations.length ? ` (${locations.join(", ")})` : ""} · Google Jobs`,
          url: link,
        },
      ],
    });
  }

  const kept = startups.slice(0, limit);
  logger.info(
    `google: ${kept.length} Google Jobs startup(s) for "${query}" in ${location}`,
  );
  return kept;
}

/**
 * Compiles the profile into Google queries, searches each run, keeps results
 * that point at the selected boards, and returns them as Startups.
 */
export async function fetchGoogleScan(
  config: GoogleSourceConfig = {},
  context?: SourceContext,
): Promise<Startup[]> {
  const profile = context?.profile;
  if (!profile) {
    logger.warn("google: missing profile context — skipping");
    return [];
  }

  if (!googleConfigured()) {
    logger.warn(
      "google: no search credentials — set SERPAPI_KEY or GOOGLE_API_KEY + GOOGLE_CSE_ID",
    );
    return [];
  }

  const limit = Math.max(1, Math.min(config.limit ?? 20, 100));
  const scan = scanForProfile(profile, {
    roles: Array.isArray(config.roles)
      ? config.roles.filter((role): role is string => typeof role === "string")
      : undefined,
    location: typeof config.location === "string" ? config.location : undefined,
    time: config.posted && isTimeId(config.posted) ? config.posted : undefined,
    level: config.level && isLevelId(config.level) ? config.level : undefined,
    setup: config.setup && isSetupId(config.setup) ? config.setup : undefined,
    boards: typeof config.boards === "string" ? config.boards : undefined,
    variants: config.variants,
    sponsored: config.sponsored,
  });

  if (!scan.plan.ready) {
    logger.warn("google: query is not ready (no roles or no boards)");
    return [];
  }

  const pages = Math.max(
    1,
    Math.min(
      config.pages ?? Math.ceil(limit / Math.max(1, scan.plan.runs.length) / 10),
      10,
    ),
  );
  const now = Date.now();
  const results: SearchResult[] = [];
  const country =
    typeof config.country === "string" && config.country.trim()
      ? config.country.trim().toLowerCase()
      : "us";

  for (const run of scan.plan.runs) {
    let found: SearchResult[] = [];
    try {
      found = await searchGoogle(run.query, scan.time, pages, pages * 10, country);
      logger.info(`google: ${run.label} returned ${found.length} result(s)`);
    } catch (err) {
      logger.warn(`google: ${run.label} failed — ${(err as Error).message}`);
    }

    const hasBoard = found.some((result) => {
      const url = parseUrl(result.link);
      return url !== undefined && boardFor(url, scan.boards) !== undefined;
    });

    if (!hasBoard) {
      // Google regularly drops `site:` when it is ANDed with titles, location,
      // and level terms. A site-only query is reliable, so use it as a
      // discovery pass and let the local matcher apply the profile.
      const wanted = Math.max(
        1,
        Math.min(config.siteQueries ?? 4, run.domains.length),
      );
      const perBoard: SearchResult[][] = [];

      for (const domain of run.domains.slice(0, wanted)) {
        const host = domain.replace(/^\*\./, "").toLowerCase();
        try {
          const siteResults = await searchGoogle(
            `site:${host}`,
            scan.time,
            1,
            10,
            country,
          );
          logger.info(
            `google: ${run.label} site:${host} fallback returned ${siteResults.length} result(s)`,
          );
          perBoard.push(siteResults);
        } catch (err) {
          logger.warn(
            `google: ${run.label} site:${host} fallback failed — ${(err as Error).message}`,
          );
        }
      }

      if (perBoard.length > 0) {
        // Round-robin so the global limit is shared across boards instead of
        // being consumed by the first high-volume ATS.
        const longest = Math.max(...perBoard.map((rows) => rows.length));
        const fallback: SearchResult[] = [];
        for (let i = 0; i < longest; i++) {
          for (const rows of perBoard) {
            const result = rows[i];
            if (result) fallback.push(result);
          }
        }
        found = fallback;
      }
    }

    results.push(...found);
  }

  const unique = dedupe(results);
  const startups = unique
    .map((result) =>
      toStartup(result, scan.boards, {
        location: scan.location,
        setup: scan.setup,
        time: scan.time,
        now,
      }),
    )
    .filter((startup): startup is Startup => startup !== undefined)
    .slice(0, limit);

  if (config.enrich !== false) {
    const enrichLimit = Math.max(
      0,
      Math.min(config.enrichLimit ?? 20, startups.length),
    );
    const enriched = await mapLimit(startups.slice(0, enrichLimit), 6, enrich);
    startups.splice(0, enriched.length, ...enriched);
  }

  logger.info(
    `google: ${startups.length} ATS startup(s) from ${unique.length} result(s)`,
  );

  const jobs = await fetchGoogleJobs(profile, config);
  if (jobs.length > 0) {
    logger.info(`google: added ${jobs.length} Google Jobs startup(s)`);
  }
  return [...startups, ...jobs];
}
