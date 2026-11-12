import { load, type CheerioAPI } from "cheerio";
import { fetchText } from "../lib/http.js";
import { logger } from "../lib/log.js";
import { htmlToText, isTechRole, slug } from "../lib/text.js";
import type { SourceId, Startup } from "../types.js";
import type { BaseSourceConfig, SourceContext } from "./types.js";

export const sourceId = "web3_career" as const satisfies SourceId;

export interface Web3CareerConfig extends BaseSourceConfig {
  /** Maximum number of jobs to return. */
  limit?: number;
}

/** The board's newest-first listing; pagination is `?page=N`. */
export const LISTING_URL = "https://web3.career/";

const DEFAULT_LIMIT = 60;

/** The listing renders roughly 15 job rows per page. */
const JOBS_PER_PAGE = 15;

/** Upper bound on listing pages per run, so a sparse run cannot crawl forever. */
const MAX_PAGES = 8;

/** A browser UA is required; the site is behind Cloudflare. */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** One `tr[data-jobid]` row from the listing table. */
interface JobRow {
  /** Numeric Web3.career job id, e.g. `155626`. */
  id: string;
  title: string;
  company: string;
  /** Absolute job-detail URL. */
  url: string;
  location?: string;
  salary?: string;
  tags: string[];
  postedAt?: string;
}

/** The `JobPosting` structured data that accompanies each listing. */
interface JobPostingLd {
  description?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
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
 * The listing's `<time datetime="2026-11-12 02:11:02+07:00">` is ISO 8601 with
 * a space instead of `T`; normalising it keeps `Date.parse` portable.
 */
function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = value.trim().replace(/^(\d{4}-\d{2}-\d{2})[ ]/, "$1T");
  const time = Date.parse(candidate);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** `📍Remote` / `📍Hong Kong,` → `Remote` / `Hong Kong`. */
function cleanLocation(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const cleaned = text
    .replace(/📍/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/,\s*$/, "");
  return cleaned === "" ? undefined : cleaned;
}

/** The JSON-LD key joins title and company, matching a row to its description. */
function postingKey(title: string, company: string): string {
  return slug(`${title} ${company}`);
}

/**
 * Reads the `JobPosting` blocks the listing embeds next to its table rows.
 *
 * They carry the full description but no job id, so they are indexed by
 * title + company and used only to enrich a row that is already known.
 */
function parsePostings($: CheerioAPI): Map<string, JobPostingLd> {
  const postings = new Map<string, JobPostingLd>();

  $('script[type="application/ld+json"]').each((_, element) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse($(element).text());
    } catch {
      return;
    }

    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (!isRecord(entry) || entry["@type"] !== "JobPosting") continue;

      const title = textValue(entry.title);
      const hiringOrganization = isRecord(entry.hiringOrganization)
        ? entry.hiringOrganization
        : undefined;
      const company = textValue(hiringOrganization?.name);
      if (!title || !company) continue;

      postings.set(postingKey(title, company), {
        description: textValue(entry.description),
      });
    }
  });

  return postings;
}

/** Extracts the listing rows, skipping the sponsored rows that have no job id. */
function parseRows($: CheerioAPI): JobRow[] {
  const rows: JobRow[] = [];

  $("tr[data-jobid]").each((_, element) => {
    const row = $(element);
    const id = (row.attr("data-jobid") ?? "").trim();
    if (!/^\d+$/.test(id)) return;

    const title = row.find("td.cell-main h2").first().text().replace(/\s+/g, " ").trim();
    const company = row.find("td.cell-main h3").first().text().replace(/\s+/g, " ").trim();
    const href = row.find("td.cell-main a[href]").first().attr("href")?.trim();
    if (!title || !company || !href) return;

    let url: string;
    try {
      url = new URL(href, LISTING_URL).toString();
    } catch {
      return;
    }

    const tags = uniqueStrings(
      row
        .find("td.cell-tags a")
        .map((_, tag) => $(tag).text().replace(/\s+/g, " ").trim())
        .get(),
    );

    rows.push({
      id,
      title,
      company,
      url,
      location: cleanLocation(row.find(".job-location-mobile").first().text()),
      salary: textValue(
        row.find("td.cell-salary p").first().text().replace(/\s+/g, " ").trim(),
      ),
      tags,
      postedAt: isoDate(row.find("td.cell-posted time").first().attr("datetime")),
    });
  });

  return rows;
}

/** Maps one listing row to a `Startup`, or `undefined` when it is not usable. */
function mapRow(
  row: JobRow,
  postings: Map<string, JobPostingLd>,
): Startup | undefined {
  // The board mixes engineering with sales, marketing, compliance and legal.
  if (!isTechRole(row.title)) return undefined;

  const posting = postings.get(postingKey(row.title, row.company));
  const location = row.location;
  // The JSON-LD marks every posting as TELECOMMUTE, so only the listing's own
  // location and tags are trusted to say whether a role is remote.
  const remote =
    /remote|anywhere/i.test(location ?? "") ||
    row.tags.some((tag) => /^remote$/i.test(tag));

  const description = [
    row.salary ? `Compensation: ${row.salary}` : "",
    posting?.description ? htmlToText(posting.description) : "",
  ]
    .filter((part) => part !== "")
    .join("\n\n")
    .slice(0, 4000);

  return {
    id: `${sourceId}:${row.id}`,
    name: row.company,
    oneLiner: row.title,
    description: description || undefined,
    url: row.url,
    locations: location ? [location] : ["Remote"],
    remote: remote || undefined,
    industry: row.tags.filter((tag) => !/^remote$/i.test(tag)),
    source: sourceId,
    signals: [
      {
        type: "hiring",
        date: row.postedAt,
        text: `${row.company} — ${row.title}${location ? ` (${location})` : ""}`,
        url: row.url,
      },
    ],
  };
}

function parsePage(html: string): Startup[] {
  const $ = load(html);
  const postings = parsePostings($);

  return parseRows($)
    .map((row) => mapRow(row, postings))
    .filter((startup): startup is Startup => startup !== undefined);
}

function freshness(startup: Startup): number {
  const date = startup.signals[0]?.date;
  const time = date ? Date.parse(date) : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

/** Page 1 is the bare listing; later pages use the site's `?page=N` pagination. */
function pageUrl(page: number): string {
  return page === 1 ? LISTING_URL : `${LISTING_URL}?page=${page}`;
}

/**
 * Web3.career — a crypto/web3 job board with a server-rendered listing.
 *
 * Each `tr[data-jobid]` row carries the numeric job id, role, company,
 * location, salary, tags and a posted timestamp, and the page's
 * `JobPosting` JSON-LD blocks add the full description. The homepage is
 * paginated with `?page=N`, so this source walks the newest-first pages until
 * it has enough technical roles for `limit`.
 *
 * Pages fail soft: a failed page is logged and skipped, so the remaining pages
 * still contribute. The board is not tech-only (it lists sales, marketing,
 * compliance and community roles), so `isTechRole` filters the rows.
 */
export async function fetchWeb3Career(
  config: Web3CareerConfig = {},
  _context?: SourceContext,
): Promise<Startup[]> {
  const limit = config.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) return [];

  // One spare page covers rows that the tech filter drops.
  const pages = Math.min(MAX_PAGES, Math.ceil(limit / JOBS_PER_PAGE) + 1);
  const seen = new Set<string>();
  const out: Startup[] = [];

  for (let page = 1; page <= pages; page += 1) {
    if (out.length >= limit) break;

    let html: string;
    try {
      html = await fetchText(pageUrl(page), {
        headers: {
          "user-agent": BROWSER_UA,
          accept: "text/html,application/xhtml+xml",
        },
      });
    } catch (error) {
      logger.warn(
        `web3_career: page ${page} failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    for (const startup of parsePage(html)) {
      if (seen.has(startup.id)) continue;
      seen.add(startup.id);
      out.push(startup);
    }
  }

  out.sort((left, right) => freshness(right) - freshness(left));

  logger.debug(`web3_career: kept ${out.length} tech role(s)`);

  return out.slice(0, limit);
}
