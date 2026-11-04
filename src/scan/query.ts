// Pure Google query compiler for the "Board Scan" method.
//
// The idea is to turn a few preferences into a Google query like:
//
//   ("software engineer" OR "backend engineer") Remote
//   (-senior -staff -principal -director -manager)
//   (remote OR "work from home")
//   (site:job-boards.greenhouse.io OR site:jobs.lever.co OR ...)
//
// and split the sites into runs when the query would exceed Google's practical
// term limit. Nothing here performs a network request; the caller decides
// whether to print, save, search, or open the generated URLs.

import type { Profile } from "../types.js";
import { selectBoards, type Board } from "./boards.js";

export type TimeId =
  | "all"
  | "h1"
  | "h4"
  | "h8"
  | "h12"
  | "d1"
  | "d2"
  | "d3"
  | "w"
  | "m";

export const TIMES: ReadonlyArray<{ id: TimeId; label: string }> = [
  { id: "all", label: "Any time" },
  { id: "h1", label: "1 hour" },
  { id: "h4", label: "4 hours" },
  { id: "h8", label: "8 hours" },
  { id: "h12", label: "12 hours" },
  { id: "d1", label: "24 hours" },
  { id: "d2", label: "48 hours" },
  { id: "d3", label: "72 hours" },
  { id: "w", label: "1 week" },
  { id: "m", label: "1 month" },
];

export function isTimeId(value: string): value is TimeId {
  return TIMES.some((t) => t.id === value);
}

export function timeLabel(id: TimeId): string {
  return TIMES.find((t) => t.id === id)?.label ?? id;
}

export type LevelId =
  | "any"
  | "intern"
  | "entry"
  | "mid"
  | "senior"
  | "lead"
  | "staff"
  | "principal";

export const LEVELS: ReadonlyArray<{ id: LevelId; label: string }> = [
  { id: "any", label: "Any" },
  { id: "intern", label: "Internship" },
  { id: "entry", label: "Entry" },
  { id: "mid", label: "Mid" },
  { id: "senior", label: "Senior" },
  { id: "lead", label: "Lead" },
  { id: "staff", label: "Staff" },
  { id: "principal", label: "Principal" },
];

export function isLevelId(value: string): value is LevelId {
  return LEVELS.some((l) => l.id === value);
}

export type SetupId = "any" | "remote" | "onsite" | "hybrid";

export const SETUPS: ReadonlyArray<{ id: SetupId; label: string }> = [
  { id: "any", label: "Any" },
  { id: "remote", label: "Remote only" },
  { id: "onsite", label: "On-site only" },
  { id: "hybrid", label: "Hybrid" },
];

export function isSetupId(value: string): value is SetupId {
  return SETUPS.some((s) => s.id === value);
}

/** Google is the only search backend: its `tbs=qdr:*` filters are the best fit. */
export const GOOGLE = {
  name: "Google",
  url: "https://www.google.com/search",
} as const;

/** Google's time filter tokens. `h4`/`h8`/`h12`/`d2`/`d3` are what the app observed. */
const TBS: Partial<Record<TimeId, string>> = {
  h1: "qdr:h",
  h4: "qdr:h4",
  h8: "qdr:h8",
  h12: "qdr:h12",
  d1: "qdr:d",
  d2: "qdr:d2",
  d3: "qdr:d3",
  w: "qdr:w",
  m: "qdr:m",
};

/** Google's `dateRestrict` token for the Custom Search JSON API. */
export function dateRestrict(time: TimeId): string | undefined {
  if (time === "all") return undefined;
  if (time === "h1" || time === "h4" || time === "h8" || time === "h12" || time === "d1") {
    return "d1";
  }
  if (time === "d2") return "d2";
  if (time === "d3") return "d3";
  if (time === "w") return "w1";
  return "m1";
}

export function tbs(time: TimeId): string | undefined {
  return TBS[time];
}

interface TermSpec {
  pos?: string[];
  neg?: string[];
}

// Observed behaviour for any/intern/entry/mid/senior; the lead/staff/principal
// entries are a small extension so those flags do something useful.
export const LEVEL_TERMS: Record<LevelId, TermSpec | null> = {
  any: null,
  intern: { pos: ["intern", "internship"] },
  entry: { neg: ["senior", "staff", "principal", "director", "manager"] },
  mid: { neg: ["intern", "internship", "director", "vp"] },
  senior: { pos: ["senior", "staff", "principal", "lead"] },
  lead: { pos: ["lead", "manager", "head"] },
  staff: { pos: ["staff"] },
  principal: { pos: ["principal"] },
};

export const SETUP_TERMS: Record<SetupId, TermSpec | null> = {
  any: null,
  remote: { pos: ["remote", '"work from home"'] },
  onsite: { neg: ["remote", '"work from home"', "telecommute"] },
  hybrid: { pos: ["hybrid"] },
};

export const SWAPS: Record<string, string> = {
  engineer: "developer",
  developer: "engineer",
  programmer: "developer",
  devops: "sre",
  sre: "devops",
  pm: "product manager",
  "product manager": "pm",
  manager: "lead",
  lead: "manager",
  sr: "senior",
  senior: "sr",
  attorney: "lawyer",
  lawyer: "attorney",
  nurse: "rn",
  rn: "registered nurse",
  accountant: "accounting",
  recruiter: "talent acquisition",
  designer: "ux designer",
  analyst: "data analyst",
  teacher: "educator",
  rep: "representative",
  ae: "account executive",
  "account executive": "ae",
};

/** The search engine stops reading a query after roughly this many terms. */
export const TERM_BUDGET = 32;
/** More runs than this gets unwieldy, so the tail is dropped with a warning. */
export const MAX_RUNS = 4;

export interface ScanInput {
  titles: string[];
  location?: string;
  time: TimeId;
  level: LevelId;
  setup: SetupId;
  variants: boolean;
  boards: Board[];
}

export interface ScanRun {
  label: string;
  query: string;
  /** Board domains in this run, used for site-only discovery fallbacks. */
  domains: string[];
  url: string;
}

export interface ScanPlan {
  /** The query shared by every run (without the site clause). */
  prefix: string;
  /** Number of selected boards. */
  boards: number;
  /** Prefix terms + one term per site clause. */
  terms: number;
  runs: ScanRun[];
  ready: boolean;
  warning?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Quotes a value when it contains whitespace, matching Board Scan's output. */
export function phrase(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/** Splits titles, dedupes, optionally adds one title swap, caps at 4. */
export function titlePhrases(titles: string[], variants: boolean): string[] {
  const out: string[] = [];

  for (const title of titles.map((t) => t.trim()).filter(Boolean)) {
    if (!out.includes(title)) out.push(title);
    if (!variants) continue;

    const lower = title.toLowerCase();
    for (const [from, to] of Object.entries(SWAPS)) {
      const re = new RegExp(`\\b${escapeRegExp(from)}\\b`);
      if (!re.test(lower)) continue;
      const variant = lower.replace(re, to);
      if (!out.includes(variant)) out.push(variant);
      break;
    }
  }

  return out.slice(0, 4);
}

function orClause(items: string[]): string {
  const [only] = items;
  if (only !== undefined && items.length === 1) return only;
  return `(${items.join(" OR ")})`;
}

function countTerms(text: string): number {
  // A quoted phrase is one search term, even when it contains spaces, so this
  // walks the query instead of splitting on whitespace. Parentheses and OR
  // are syntax, not terms.
  let count = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (ch === undefined) break;
    if (ch === " " || ch === "(" || ch === ")") {
      i++;
      continue;
    }
    if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      count++;
      if (end === -1) break;
      i = end + 1;
      continue;
    }

    let end = i;
    while (end < text.length) {
      const c = text[end];
      if (c === undefined || c === " " || c === "(" || c === ")") break;
      end++;
    }
    if (text.slice(i, end) !== "OR") count++;
    i = end;
  }

  return count;
}

function siteClause(sites: string[]): string {
  // `*.example.com` documents "any subdomain" in the catalogue, but Google's
  // site: operator already includes subdomains and does not accept a wildcard.
  const host = (s: string) => (s.startsWith("*.") ? s.slice(2) : s);
  return `(${sites.map((s) => `site:${host(s)}`).join(" OR ")})`;
}

function buildUrl(query: string, time: TimeId): string {
  const params = new URLSearchParams({ q: query });
  const filter = tbs(time);
  if (filter) params.set("tbs", filter);
  return `${GOOGLE.url}?${params.toString()}`;
}

function chunkSites(sites: string[], preTerms: number): string[][] {
  const room = Math.max(1, TERM_BUDGET - preTerms);
  const chunks: string[][] = [];
  for (let i = 0; i < sites.length; i += room) {
    chunks.push(sites.slice(i, i + room));
  }
  return chunks.slice(0, MAX_RUNS);
}

/** Compiles preferences into one or more Google queries and search URLs. */
export function compileScan(input: ScanInput): ScanPlan {
  const titles = titlePhrases(input.titles, input.variants).map(phrase);
  const titleClause = titles.length > 0 ? orClause(titles) : "";

  // Google's parser is much more reliable when the site: group sits directly
  // after the title clause. Appending it after the location/level/setup terms
  // sometimes makes Google drop the site restriction and return aggregators.
  const tail: string[] = [];

  const location = input.location?.trim();
  if (location) tail.push(phrase(location));

  for (const spec of [LEVEL_TERMS[input.level], SETUP_TERMS[input.setup]]) {
    if (!spec) continue;
    if (spec.pos && spec.pos.length > 0) tail.push(orClause(spec.pos));
    if (spec.neg && spec.neg.length > 0) {
      tail.push(spec.neg.map((t) => `-${t}`).join(" "));
    }
  }

  const prefix = [titleClause, ...tail].filter(Boolean).join(" ");
  const preTerms = countTerms(prefix);
  const sites = input.boards.map((b) => b.domain);
  const chunks = sites.length > 0 ? chunkSites(sites, preTerms) : [];
  const terms = preTerms + sites.length;
  const ready = titles.length > 0 && sites.length > 0;

  const warnings: string[] = [];
  if (chunks.length > 1) {
    warnings.push(`Over the ${TERM_BUDGET}-term budget — splits into ${chunks.length} runs.`);
  }
  const covered = chunks.reduce((n, chunk) => n + chunk.length, 0);
  if (covered < sites.length) {
    warnings.push(
      `${sites.length - covered} board(s) dropped: only ${MAX_RUNS} runs are generated.`,
    );
  }

  const runs: ScanRun[] = ready
    ? chunks.map((chunk, i) => {
        const query = [titleClause, siteClause(chunk), ...tail]
          .filter(Boolean)
          .join(" ");
        return {
          label: `Run ${i + 1} of ${chunks.length}`,
          query,
          domains: chunk,
          url: buildUrl(query, input.time),
        };
      })
    : [];

  return {
    prefix,
    boards: sites.length,
    terms,
    runs,
    ready,
    warning: warnings.length > 0 ? warnings.join(" ") : undefined,
  };
}

export function levelFromProfile(profile: Profile): LevelId {
  const seniority = profile.seniority.toLowerCase();
  if (seniority.includes("intern")) return "intern";
  if (seniority.includes("junior") || seniority.includes("entry")) return "entry";
  if (seniority.includes("principal")) return "principal";
  if (seniority.includes("staff")) return "staff";
  if (seniority.includes("lead")) return "lead";
  if (seniority.includes("senior")) return "senior";
  return "mid";
}

export function defaultLocation(profile: Profile): string {
  return profile.preferences.remote ? "Remote" : (profile.preferences.locations[0] ?? "");
}

export function defaultSetup(profile: Profile): SetupId {
  return profile.preferences.remote ? "remote" : "any";
}

export interface ScanOptions {
  roles?: string[];
  location?: string;
  time?: TimeId;
  level?: LevelId;
  setup?: SetupId;
  boards?: string;
  variants?: boolean;
  sponsored?: boolean;
}

export interface ResolvedScan {
  roles: string[];
  location: string;
  time: TimeId;
  level: LevelId;
  setup: SetupId;
  boardsSpec: string;
  boards: Board[];
  plan: ScanPlan;
}

/**
 * Resolves profile defaults + overrides into the exact scan used by both the
 * CLI preview and the Google source that feeds the matcher/digest.
 */
export function scanForProfile(profile: Profile, opts: ScanOptions = {}): ResolvedScan {
  const roles = opts.roles && opts.roles.length > 0 ? opts.roles : profile.roles.slice(0, 4);
  const location = opts.location ?? defaultLocation(profile);
  const time = opts.time ?? "d1";
  const level = opts.level ?? levelFromProfile(profile);
  const setup = opts.setup ?? defaultSetup(profile);
  const boardsSpec = opts.boards ?? "core";
  const boards = selectBoards(boardsSpec, opts.sponsored ?? true);
  const plan = compileScan({
    titles: roles,
    location,
    time,
    level,
    setup,
    variants: opts.variants ?? false,
    boards,
  });

  return { roles, location, time, level, setup, boardsSpec, boards, plan };
}
