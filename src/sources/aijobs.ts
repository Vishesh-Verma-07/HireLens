import { load, type CheerioAPI } from "cheerio";
import { fetchText } from "../lib/http.js";
import { logger } from "../lib/log.js";
import { isTechRole, normalizeWhitespace } from "../lib/text.js";
import type { SourceId, Startup } from "../types.js";
import type { BaseSourceConfig, SourceContext } from "./types.js";

export const sourceId = "ai_jobs_net" as const satisfies SourceId;

export interface AiJobsNetConfig extends BaseSourceConfig {
  /** Maximum number of jobs to return. */
  limit?: number;
}

/**
 * ai-jobs.net now 301s to **foorilla.com**, the renamed successor of the same
 * board (verified 2026-11-13: `ai-jobs.net` → `https://foorilla.com/`). The
 * source id stays `ai_jobs_net` so configs and dedupe keys keep working, but
 * requests go straight to the canonical host to avoid the extra hop.
 */
export const ORIGIN = "https://foorilla.com";

/** The board's newest-first listing; pagination is `?page=N` (1-based). */
export const LISTING_URL = `${ORIGIN}/hiring/jobs/`;

const DEFAULT_LIMIT = 60;

/** Listing pages hold 50 rows; the last one also triggers the next `?page=N`. */
const ROWS_PER_PAGE = 50;

/** Upper bound on listing pages per run, so a sparse run cannot crawl forever. */
const MAX_PAGES = 6;

/** A browser UA keeps the edge from treating the scrape as a bot. */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * `hx-request: true` is REQUIRED. Without it the server answers with the site's
 * JS shell, which contains no job rows at all — the same header the page's own
 * HTMX frontend sends when it swaps `#main1`.
 */
const REQUEST_HEADERS: Record<string, string> = {
  "hx-request": "true",
  "user-agent": BROWSER_UA,
  accept: "text/html,application/xhtml+xml",
};

/** `[EN]` / `[MI]` / `[SE]` are the listing's short forms of the level tags. */
const SENIORITY_CODES: Record<string, string> = {
  "[EN]": "Entry-level",
  "[MI]": "Mid-level",
  "[SE]": "Senior-level / Expert",
};

/** `[R]` is the board's `REMO=true` tag; `[WRA]` is its "remote anywhere" tag. */
const REMOTE_MARKERS = new Set(["[R]", "[WRA]"]);

/** `[WH]` is `WMOD` (hybrid / work-from-home possible), not a remote role. */
const WORK_MODE_MARKERS = new Set(["[WH]"]);

/**
 * A location advertises remote work only when it says so and is not hybrid:
 * "München, Remote" is remote, "Berlin (hybrid)" is not.
 */
function locationIsRemote(location: string | undefined): boolean {
  return !!location && /remote/i.test(location) && !/hybrid/i.test(location);
}

const EMPLOYMENT_TYPE =
  /full[- ]?time|part[- ]?time|contract|freelance|internship|temporary/i;

/** Relative listing ages: `2h ago`, `21d ago`, `1mo ago`, `5m ago`. */
const RELATIVE_AGE = /^(\d+)\s*(mo|m|h|d|w|y)\s*ago$/i;

const AGE_UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  mo: 30 * 86_400_000,
  y: 365 * 86_400_000,
};

/** A cheerio selection, as returned by `$(...)`. */
type Selection = ReturnType<CheerioAPI>;

/** One `li.list-group-item` job row from the listing. */
interface JobRow {
  /** Numeric foorilla job id, e.g. `4124347`. */
  id: string;
  title: string;
  /** Absolute job-detail URL. */
  url: string;
  /** Relative age text, e.g. `2h ago`. */
  age?: string;
  salary?: string;
  location?: string;
  /** Level label from the listing's short marker, e.g. `Senior-level / Expert`. */
  seniority?: string;
  /** Whether the listing already flags the role as remote. */
  remote: boolean;
}

/** The detail page's own facts; the listing has no company name. */
interface JobDetail {
  title?: string;
  company?: string;
  location?: string;
  remote: boolean;
  salary?: string;
  seniority?: string;
  experience?: string;
  employment: string[];
  skills: string[];
  topics: string[];
  tasks: string[];
  publishedAt?: string;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }

  return out;
}

/**
 * `[AWS]` → `AWS`, `* Build things` → `Build things`.
 *
 * Only the marker's own brackets and a leading list bullet are removed; real
 * parentheses stay (`[Google Cloud Platform (GCP)]`).
 */
function tagText(value: string): string | undefined {
  const text = normalizeWhitespace(value)
    .replace(/^[[*+\u2022]\s*/, "")
    .replace(/\]$/, "")
    .trim();
  return text === "" ? undefined : text;
}

/** `2026-11-13` → `2026-11-13T00:00:00.000Z` so every signal is a date-time. */
function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value.trim());
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** Turns the listing's relative age into an approximate ISO date. */
function dateFromAge(age: string | undefined, now = Date.now()): string | undefined {
  if (!age) return undefined;
  const match = RELATIVE_AGE.exec(normalizeWhitespace(age));
  const amount = Number(match?.[1]);
  const unit = match?.[2]?.toLowerCase();
  if (!Number.isFinite(amount) || !unit) return undefined;

  const multiplier = AGE_UNIT_MS[unit];
  if (multiplier === undefined) return undefined;
  return new Date(now - amount * multiplier).toISOString();
}

/** `Locations: Vancouver, Canada [WH]` → `Vancouver, Canada`. */
function cleanLocation(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = normalizeWhitespace(value)
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/^Locations:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? undefined : text;
}

/** Reads the `[marker]` tags inside `scope`. */
function readTags($: CheerioAPI, scope: Selection, selector: string): string[] {
  return scope
    .find(selector)
    .map((_, element) => normalizeWhitespace($(element).text()))
    .get()
    .filter((text) => /^\[[^\]]+\]$/.test(text));
}

/** `[Senior-level / Expert]`, `[~4yoe]`, `[Full Time]` → the canonical pieces. */
function readDetailTags(tags: string[]): Pick<
  JobDetail,
  "remote" | "seniority" | "experience" | "employment"
> {
  let remote = false;
  let seniority: string | undefined;
  const experienceParts: string[] = [];
  const employment: string[] = [];

  for (const raw of tags) {
    const tag = normalizeWhitespace(raw);
    if (tag === "") continue;

    if (REMOTE_MARKERS.has(tag)) {
      remote = true;
      continue;
    }
    if (WORK_MODE_MARKERS.has(tag)) continue;

    const years = /^\[~?\s*([\d.]+)\s*(?:yoe|years?|yrs?)/i.exec(tag);
    if (years?.[1]) {
      experienceParts.push(`~${years[1]} years`);
      continue;
    }

    const inner = tag.replace(/^\[|\]$/g, "").trim();
    if (/level|junior|senior|expert|intermediate/i.test(inner)) {
      seniority ??= inner;
      continue;
    }
    if (EMPLOYMENT_TYPE.test(inner)) employment.push(inner);
  }

  return {
    remote,
    seniority,
    experience: experienceParts.length > 0 ? experienceParts.join(", ") : undefined,
    employment: uniqueStrings(employment),
  };
}

/**
 * Extracts the listing rows.
 *
 * The last row doubles as the infinite-scroll trigger (`hx-get="...?page=N"`),
 * so there is no separate sentinel row; rows without a detail link are skipped
 * defensively.
 */
function parseRows($: CheerioAPI): JobRow[] {
  const rows: JobRow[] = [];

  $("li.list-group-item").each((_, element) => {
    const row = $(element);
    const link = row.find("a.terminal-title").first();
    const title = normalizeWhitespace(link.text());
    const detailPath = (link.attr("hx-get") ?? "").trim();
    const jobId = /-(\d+)\/?$/.exec(detailPath)?.[1];

    if (!title || !detailPath || !jobId) return;

    let url: string;
    try {
      url = new URL(detailPath, ORIGIN).toString();
    } catch {
      return;
    }

    const levelTag = normalizeWhitespace(
      row.find("small.text-warning-emphasis").first().text(),
    );
    const location = cleanLocation(row.find(".text-end small").first().text());
    const salary = normalizeWhitespace(row.find(".salary-value").first().text());

    rows.push({
      id: jobId,
      title,
      url,
      age: normalizeWhitespace(row.find(".terminal-meta small").first().text()) || undefined,
      salary: salary === "" ? undefined : salary,
      location,
      seniority: SENIORITY_CODES[levelTag],
      remote:
        readTags($, row, "span.text-success").some((tag) => REMOTE_MARKERS.has(tag)) ||
        locationIsRemote(location),
    });
  });

  return rows;
}

/**
 * Collects the items that follow a `<strong>Label:</strong>` in the detail body.
 *
 * `Tasks:`, `Perks/Benefits:`, `Skills/Tech stack required:` and `Topics:` are
 * flat sibling blocks. A section ends at the next block that carries a
 * `<strong>` label (some labels, like `Topics:`, are wrapped in a `<div>`), and
 * walking also stops as soon as a sibling holds none of `itemSelector` — that
 * is what keeps the unlabelled "Entities / cross-references" link, which sits
 * right after the skills block, out of the skill list.
 */
function itemsAfterLabel(
  $: CheerioAPI,
  label: RegExp,
  itemSelector: string,
): string[] {
  const heading = $(".detail-section strong")
    .filter((_, element) => label.test(normalizeWhitespace($(element).text())))
    .first();
  if (heading.length === 0) return [];

  const items: string[] = [];
  let sibling = heading.next();

  while (sibling.length > 0) {
    if (sibling.is("strong") || sibling.find("strong").length > 0) break;

    const found = sibling.find(itemSelector);
    if (found.length === 0) break;

    found.each((_, element) => {
      const text = tagText($(element).text());
      if (text) items.push(text);
    });
    sibling = sibling.next();
  }

  return items;
}

/** Reads the detail page, scoped to the first (the job's own) sections. */
function parseDetail($: CheerioAPI): JobDetail {
  const heading = $("h1").first();
  const header = heading.closest(".detail-section").nextAll(".detail-section").first();

  // The company link only exists on the detail page; its rendered form is
  // `@ Electronic Arts`.
  const company = normalizeWhitespace(
    $('a[href^="/hiring/companies/"]').first().text(),
  ).replace(/^@\s*/, "");

  const tags = uniqueStrings(readTags($, header, "a.terminal-tag"));
  const tagFacts = readDetailTags(tags);

  // The location cell also holds the `[WH]` marker; drop the tags before
  // reading its text so the location stays clean.
  const locationCell = header
    .children(".hstack")
    .first()
    .children("div")
    .first()
    .clone();
  locationCell.find("a").remove();

  const salary = normalizeWhitespace(header.find(".salary-value").first().text());
  const published = /Published\s+(\d{4}-\d{2}-\d{2})/i.exec(
    $(".object-stats-facts").first().text(),
  )?.[1];

  return {
    title: normalizeWhitespace(heading.text()) || undefined,
    company: company === "" ? undefined : company,
    location: cleanLocation(locationCell.text()),
    remote: tagFacts.remote,
    salary: salary === "" ? undefined : salary,
    seniority: tagFacts.seniority,
    experience: tagFacts.experience,
    employment: tagFacts.employment,
    skills: uniqueStrings(itemsAfterLabel($, /^skills/i, "a.terminal-tag").map(tagText)),
    topics: uniqueStrings(itemsAfterLabel($, /^topics/i, "a.terminal-tag").map(tagText)),
    tasks: uniqueStrings(itemsAfterLabel($, /^tasks/i, "li").map(tagText)),
    publishedAt: isoDate(published),
  };
}

/**
 * Builds the description from the facts the scorer needs, in priority order so
 * the 4000-character cap cannot truncate compensation or seniority.
 */
function descriptionFor(row: JobRow, detail: JobDetail): string | undefined {
  const salary = detail.salary ?? row.salary;
  const seniority = detail.seniority ?? row.seniority;
  const parts: string[] = [];

  if (salary) parts.push(`Compensation: ${salary}`);
  if (seniority) parts.push(`Seniority: ${seniority}`);
  if (detail.experience) parts.push(`Experience: ${detail.experience}`);
  if (detail.employment.length > 0) {
    parts.push(`Employment type: ${detail.employment.join(", ")}`);
  }
  if (detail.skills.length > 0) parts.push(`Skills: ${detail.skills.join(", ")}`);
  if (detail.tasks.length > 0) {
    parts.push(`Tasks:\n${detail.tasks.map((task) => `* ${task}`).join("\n")}`);
  }

  return parts.length > 0 ? parts.join("\n\n").slice(0, 4000) : undefined;
}

/** Maps one listing row + its detail page to a `Startup`. */
function mapJob(row: JobRow, detail: JobDetail): Startup | undefined {
  const title = detail.title ?? row.title;
  const company = detail.company;

  // The company only exists on the detail page, so a posting without one is not
  // usable as a `Startup` (that is also what the contract requires).
  if (!company) return undefined;
  if (!isTechRole(title)) return undefined;

  const location = detail.location ?? row.location;
  const remote = detail.remote || row.remote || locationIsRemote(location);
  const locations = uniqueStrings([
    location,
    remote && !locationIsRemote(location) ? "Remote" : undefined,
  ]);
  const postedAt = detail.publishedAt ?? dateFromAge(row.age);
  const where = locations.join(", ");

  return {
    id: `${sourceId}:${row.id}`,
    name: company,
    oneLiner: title,
    description: descriptionFor(row, detail),
    url: row.url,
    locations,
    remote: remote || undefined,
    // The board's own "Topics" are its industry taxonomy; the tech stack is the
    // fallback for postings that carry no topics.
    industry: detail.topics.length > 0 ? detail.topics : detail.skills,
    source: sourceId,
    signals: [
      {
        type: "hiring",
        date: postedAt,
        text: `${company} — ${title}${where ? ` (${where})` : ""}`,
        url: row.url,
      },
    ],
  };
}

function freshness(startup: Startup): number {
  const date = startup.signals[0]?.date;
  const time = date ? Date.parse(date) : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

/** Page 1 is the bare listing; later pages use the board's `?page=N` links. */
function pageUrl(page: number): string {
  return page === 1 ? LISTING_URL : `${LISTING_URL}?page=${page}`;
}

/**
 * ai-jobs.net (now **foorilla.com**) — a niche AI/ML-friendly tech job board.
 *
 * The listing is server-rendered HTML, but only when the request carries
 * `hx-request: true` (the header the site's own HTMX frontend sends); without
 * it the response is a JS shell with no rows. Each `li.list-group-item` row
 * carries the job id (in its detail path), title, relative age, salary,
 * location and level/remote markers — but **not** the company name, so each
 * kept row costs one detail request. The detail page adds the company,
 * seniority, years of experience, employment type, skills/tech stack, topics,
 * tasks and an absolute `Published` date.
 *
 * Because details are one request apiece, non-technical titles are dropped from
 * the listing first, and collection stops as soon as `limit` roles are built.
 * Detail failures are logged and skipped rather than sinking the page. The
 * board's listing is not AI-only, so `isTechRole` is what keeps the digest
 * focused.
 */
export async function fetchAiJobs(
  config: AiJobsNetConfig = {},
  _context?: SourceContext,
): Promise<Startup[]> {
  const limit = config.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) return [];

  // One spare page covers rows that the tech filter drops.
  const pages = Math.min(MAX_PAGES, Math.ceil(limit / ROWS_PER_PAGE) + 1);
  const seen = new Set<string>();
  const out: Startup[] = [];

  for (let page = 1; page <= pages && out.length < limit; page += 1) {
    let html: string;
    try {
      html = await fetchText(pageUrl(page), { headers: REQUEST_HEADERS });
    } catch (error) {
      logger.warn(
        `ai_jobs_net: listing page ${page} failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    const rows = parseRows(load(html));
    if (rows.length === 0) break;

    let fresh = 0;

    for (const row of rows) {
      if (out.length >= limit) break;
      if (!isTechRole(row.title)) continue;
      if (seen.has(row.id)) continue;

      seen.add(row.id);
      fresh += 1;

      let detailHtml: string;
      try {
        detailHtml = await fetchText(row.url, { headers: REQUEST_HEADERS });
      } catch (error) {
        logger.warn(
          `ai_jobs_net: detail ${row.url} failed — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }

      const startup = mapJob(row, parseDetail(load(detailHtml)));
      if (startup) out.push(startup);
    }

    // Pagination is a repeating cursor: seeing no new rows means the end.
    if (fresh === 0) break;
  }

  out.sort((left, right) => freshness(right) - freshness(left));

  logger.debug(`ai_jobs_net: kept ${out.length} tech role(s)`);

  return out.slice(0, limit);
}
