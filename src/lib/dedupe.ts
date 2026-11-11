/**
 * Cross-source deduplication.
 *
 * Job boards overlap: the same role is frequently posted to RemoteOK, Remotive,
 * and a company's own board at the same time. {@link dedupeStartups} collapses
 * those into one record so the digest does not show the same job twice.
 *
 * Two passes, in order:
 *
 * 1. Exact `id` match. Ids are source-prefixed (`remoteok:123`), so this only
 *    catches the same source publishing a record twice in one response.
 * 2. Fuzzy role match. Two records are the same role when their normalized
 *    company names are equal, their locations are compatible, and their title
 *    tokens are similar enough (default 0.85). Company-level records (funding,
 *    launches) never participate: a job posting and a funding round about the
 *    same company are different opportunities.
 *
 * The winning record keeps its own identity and fills in any missing fields
 * from the duplicates. `sources` lists every board that contributed, and
 * signals/industries/locations are unioned so scoring still sees all evidence.
 *
 * Cross-run suppression lives in `src/store/db.ts`: {@link seenKey} is the
 * stable, source-independent key persisted there, so a role seen via one board
 * stays suppressed even if it later arrives from another board.
 */

import type { Startup } from "../types.js";

/** Legal-form words that do not distinguish two companies. */
const COMPANY_SUFFIXES = new Set([
  "ab",
  "ag",
  "bv",
  "co",
  "company",
  "corp",
  "corporation",
  "gmbh",
  "inc",
  "incorporated",
  "limited",
  "llc",
  "ltd",
  "oy",
  "plc",
  "pty",
  "sa",
  "sas",
  "spa",
  "srl",
]);

/** Words that boards add to a title without changing the role. */
const TITLE_NOISE = new Set([
  "anywhere",
  "contract",
  "fmd",
  "fulltime",
  "hybrid",
  "mfd",
  "onsite",
  "parttime",
  "permanent",
  "remote",
  "wmd",
]);

/** Trailing level markers: "Engineer II" and "Engineer" are the same role. */
const TITLE_LEVELS = new Set(["i", "ii", "iii", "iv", "v", "1", "2", "3", "4", "5"]);

/** Location words that carry no discriminating signal. */
const LOCATION_NOISE = new Set([
  "anywhere",
  "flexible",
  "global",
  "hybrid",
  "onsite",
  "remote",
  "worldwide",
]);

const DEFAULT_TITLE_THRESHOLD = 0.85;

function words(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function abbreviations(word: string): string {
  if (word === "sr") return "senior";
  if (word === "jr") return "junior";
  return word;
}

/** "Acme, Inc." and "ACME" both normalize to "acme". */
export function normalizeCompany(name: string): string {
  return words(name)
    .filter((word) => !COMPANY_SUFFIXES.has(word))
    .join(" ");
}

/**
 * Normalizes a job title: drops board noise ("Remote", "Full-time"), legal
 * gender markers, and trailing level numbers, and expands sr/jr.
 */
export function normalizeTitle(title: string): string {
  const cleaned = title
    .replace(/\b(?:fully\s+)?remote\b/gi, " ")
    .replace(/\bhybrid\b/gi, " ")
    .replace(/\bon[- ]site\b/gi, " ")
    .replace(/\banywhere\b/gi, " ")
    .replace(/\b(?:full|part)[- ]?time\b/gi, " ")
    .replace(/\b[mfw]\s*\/\s*[mfw]\s*\/\s*[dx]\b/gi, " ");

  const tokens = words(cleaned);
  return tokens
    .filter(
      (word, index) =>
        !TITLE_NOISE.has(word) &&
        !(index === tokens.length - 1 && TITLE_LEVELS.has(word)),
    )
    .map(abbreviations)
    .join(" ");
}

/** Location tokens with board noise removed. */
function locationWords(locations: string[]): string[] {
  const out: string[] = [];
  for (const location of locations) {
    for (const word of words(location)) {
      if (!LOCATION_NOISE.has(word)) out.push(word);
    }
  }
  return out;
}

/** Stable, order-independent location string used in dedupe keys. */
export function normalizeLocation(locations: string[]): string {
  return [...new Set(locationWords(locations))].sort().join(" ");
}

/** Unknown (empty) location matches anything; otherwise the tokens must overlap. */
function locationsCompatible(a: string[], b: string[]): boolean {
  const left = new Set(locationWords(a));
  const right = new Set(locationWords(b));
  if (left.size === 0 || right.size === 0) return true;
  for (const token of left) if (right.has(token)) return true;
  return false;
}

/** Jaccard similarity over normalized title tokens, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const left = new Set(normalizeTitle(a).split(" ").filter(Boolean));
  const right = new Set(normalizeTitle(b).split(" ").filter(Boolean));
  if (left.size === 0 || right.size === 0) {
    return left.size === right.size ? 1 : 0;
  }

  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * A record is a job posting when it has a role title and a hiring signal. YC
 * companies also carry taglines, but they only merge with another record for
 * the same company whose title is nearly identical, which does not happen for
 * company-level records.
 */
function isJobPosting(startup: Startup): boolean {
  return Boolean(startup.oneLiner?.trim()) &&
    startup.signals.some((signal) => signal.type === "hiring");
}

/** Canonical key for one record, ignoring which board it came from. */
export function dedupeKey(startup: Startup): string {
  const company = normalizeCompany(startup.name);
  if (!company) return "";
  return `${company}|${normalizeTitle(startup.oneLiner ?? "")}|${normalizeLocation(startup.locations)}`;
}

/**
 * Key persisted in `data/store.json` for cross-run suppression. It is stable
 * across boards, so the same role does not reappear when a different source
 * wins the merge next run.
 */
export function seenKey(startup: Startup): string {
  const key = dedupeKey(startup);
  return key ? `dedupe:${key}` : "";
}

function cloneStartup(startup: Startup): Startup {
  return {
    ...startup,
    locations: [...startup.locations],
    industry: [...startup.industry],
    signals: [...startup.signals],
    sources: startup.sources?.length ? [...startup.sources] : [startup.source],
  };
}

function signalKey(signal: Startup["signals"][number]): string {
  return `${signal.type}|${signal.url ?? ""}|${signal.date ?? ""}|${signal.text ?? ""}`;
}

function mergeSources(winner: Startup, extra: Startup): void {
  const sources = (winner.sources ??= [winner.source]);
  for (const source of extra.sources ?? [extra.source]) {
    if (!sources.includes(source)) sources.push(source);
  }
}

function mergeStartup(winner: Startup, extra: Startup): void {
  mergeSources(winner, extra);

  const signals = new Set(winner.signals.map(signalKey));
  for (const signal of extra.signals) {
    const key = signalKey(signal);
    if (signals.has(key)) continue;
    signals.add(key);
    winner.signals.push(signal);
  }

  winner.locations = [...new Set([...winner.locations, ...extra.locations])];
  winner.industry = [...new Set([...winner.industry, ...extra.industry])];
  winner.remote = winner.remote || extra.remote;

  winner.oneLiner ??= extra.oneLiner;
  winner.url ??= extra.url;
  winner.stage ??= extra.stage;
  winner.employees ??= extra.employees;
  winner.batch ??= extra.batch;
  winner.companyDomain ??= extra.companyDomain;

  // Keep the longer description: scoring reads it, so the most complete copy
  // from any board wins.
  if (
    !winner.description ||
    (extra.description?.length ?? 0) > winner.description.length
  ) {
    winner.description = extra.description ?? winner.description;
  }
}

export interface DedupeOptions {
  /** Title similarity at or above which two records are the same role. */
  titleThreshold?: number;
}

export interface DedupeResult {
  /** One record per role, in first-seen order. */
  startups: Startup[];
  /** How many input records were folded into another one. */
  removed: number;
}

/**
 * Collapses duplicate roles within one collection run. Safe to call again on
 * its own output (merged records no longer match each other).
 */
export function dedupeStartups(
  items: Startup[],
  options: DedupeOptions = {},
): DedupeResult {
  const threshold = options.titleThreshold ?? DEFAULT_TITLE_THRESHOLD;
  const winners: Startup[] = [];
  const byId = new Map<string, Startup>();
  const byCompany = new Map<string, Startup[]>();

  for (const item of items) {
    const candidate = cloneStartup(item);

    const sameId = byId.get(candidate.id);
    if (sameId) {
      mergeStartup(sameId, candidate);
      continue;
    }

    const company = normalizeCompany(candidate.name);
    const sameRole =
      company && isJobPosting(candidate)
        ? byCompany
            .get(company)
            ?.find(
              (winner) =>
                isJobPosting(winner) &&
                locationsCompatible(winner.locations, candidate.locations) &&
                titleSimilarity(winner.oneLiner ?? "", candidate.oneLiner ?? "") >=
                  threshold,
            )
        : undefined;

    if (sameRole) {
      mergeStartup(sameRole, candidate);
      continue;
    }

    winners.push(candidate);
    byId.set(candidate.id, candidate);
    if (company) {
      byCompany.set(company, [...(byCompany.get(company) ?? []), candidate]);
    }
  }

  return { startups: winners, removed: items.length - winners.length };
}
