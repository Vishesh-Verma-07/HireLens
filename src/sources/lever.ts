import { fetchJson, HttpError } from "../lib/http.js";
import { logger } from "../lib/log.js";
import { isTechRole } from "../lib/text.js";
import type { SourceId, Startup } from "../types.js";
import type { LeverConfig } from "./config.js";
import type { SourceContext } from "./types.js";

export const sourceId = "lever" as const satisfies SourceId;

/** Lever's public postings API. `/{slug}` is a company's board. */
export const LEVER_API_URL = "https://api.lever.co/v0/postings";

const DEFAULT_LIMIT = 50;
const DESCRIPTION_LIMIT = 4000;

/**
 * Real Lever slugs are lowercase and contain no spaces. Enforcing the shape
 * keeps a pasted URL or a typo from becoming an id component, and lowercasing
 * keeps `lever:Acme:1` and `lever:acme:1` from duplicating the same posting
 * across daily runs.
 */
const COMPANY_SLUG = /^[a-z0-9][a-z0-9._-]*$/;

interface LeverPostingCategories {
  location?: string;
  team?: string;
  department?: string;
  commitment?: string;
  allLocations?: string[];
}

interface LeverPosting {
  id?: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  /** Epoch milliseconds; the contract wants ISO 8601, so this is converted. */
  createdAt?: number;
  workplaceType?: string;
  country?: string;
  descriptionPlain?: string;
  categories?: LeverPostingCategories;
}

function postingsUrl(company: string): string {
  return `${LEVER_API_URL}/${encodeURIComponent(company)}`;
}

/** `allLocations` is the multi-office list; `location` is the primary desk. */
function locationsFor(posting: LeverPosting): string[] {
  const categories = posting.categories;
  if (typeof categories !== "object" || categories === null) return [];

  const all = (Array.isArray(categories.allLocations) ? categories.allLocations : [])
    .filter((location): location is string => typeof location === "string")
    .map((location) => location.trim())
    .filter(Boolean);
  if (all.length > 0) return all;

  const primary = typeof categories.location === "string" ? categories.location.trim() : "";
  return primary ? [primary] : [];
}

/** Department and team are the closest thing Lever has to industry tags. */
function industryFor(posting: LeverPosting): string[] {
  const categories = posting.categories;
  if (typeof categories !== "object" || categories === null) return [];

  const labels = [categories.department, categories.team]
    .map((label) => (typeof label === "string" ? label.trim() : ""))
    .filter(Boolean);
  return [...new Set(labels)];
}

/** Epoch milliseconds to the ISO 8601 the contract requires; junk is dropped. */
function isoDate(createdAt: unknown): string | undefined {
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return undefined;
  const time = new Date(createdAt);
  // `new Date(1e18)` is Invalid Date and `toISOString` throws a RangeError.
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString();
}

/**
 * Maps one posting to a Startup, or `undefined` when it is not a technical role
 * or lacks the id/title the dedupe key depends on.
 *
 * Lever's API has no company display name, so the board slug doubles as `name`;
 * it is also what makes the id (`lever:{company}:{job-id}`) stable across runs.
 */
function toStartup(raw: unknown, company: string): Startup | undefined {
  // A malformed element must not sink the rest of the board.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;

  const posting = raw as LeverPosting;
  const title = posting.text?.trim();
  if (!title || !isTechRole(title)) return undefined;

  const jobId = posting.id?.trim();
  if (!jobId) return undefined;

  const url = posting.hostedUrl?.trim() || posting.applyUrl?.trim();
  const description = posting.descriptionPlain?.trim();

  return {
    id: `${sourceId}:${company}:${jobId}`,
    name: company,
    oneLiner: title,
    description: description ? description.slice(0, DESCRIPTION_LIMIT) : undefined,
    url,
    locations: locationsFor(posting),
    remote: posting.workplaceType === "remote",
    industry: industryFor(posting),
    source: sourceId,
    signals: [
      {
        type: "hiring",
        date: isoDate(posting.createdAt),
        text: `${company} — ${title}`,
        url,
      },
    ],
  };
}

/**
 * Lever job boards for a configured list of company slugs.
 *
 * Each company is fetched independently: a slug that 404s (board renamed or
 * guessed wrong) only logs a warning, because one dead company must not hide
 * the postings of the rest. `limit` caps the total across companies.
 */
export async function fetchLever(
  config: LeverConfig = {},
  _context?: SourceContext,
): Promise<Startup[]> {
  const requested = config.limit ?? DEFAULT_LIMIT;
  const limit = Number.isFinite(requested)
    ? Math.max(0, Math.floor(requested))
    : DEFAULT_LIMIT;
  if (limit <= 0) return [];

  const companies: string[] = [];
  for (const raw of config.companies ?? []) {
    const company = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!company) continue;
    if (!COMPANY_SLUG.test(company)) {
      logger.warn(`lever: ignoring invalid company slug "${company}"`);
      continue;
    }
    if (!companies.includes(company)) companies.push(company);
  }
  if (companies.length === 0) return [];

  const seen = new Set<string>();
  const out: Startup[] = [];

  for (const company of companies) {
    if (out.length >= limit) break;

    let body: unknown;
    try {
      body = await fetchJson<unknown>(postingsUrl(company), {
        headers: { accept: "application/json" },
      });
    } catch (error) {
      const reason =
        error instanceof HttpError && error.status > 0
          ? `HTTP ${error.status}`
          : error instanceof Error
            ? error.message
            : String(error);
      logger.warn(`lever: skipping company "${company}" — ${reason}`);
      continue;
    }

    if (!Array.isArray(body)) {
      logger.warn(`lever: company "${company}" returned no posting list — skipping`);
      continue;
    }

    for (const raw of body) {
      const startup = toStartup(raw, company);
      if (!startup || seen.has(startup.id)) continue;

      seen.add(startup.id);
      out.push(startup);
      if (out.length >= limit) break;
    }
  }

  return out;
}
