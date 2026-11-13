import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "../lib/log.js";
import type { Match, SourceId, Startup } from "../types.js";
import { hubConfigured, sendToHub } from "./client.js";
import { domainFromUrl } from "./domain.js";

/**
 * Job payload accepted by `POST /api/ingest/jobs` (see jobhub/README.md):
 *
 * {
 *   "source": "FINDER",
 *   "sourceId": "finder-job-8842",
 *   "companyDomain": "acme.com",
 *   "companyName": "Acme",
 *   "title": "Senior Platform Engineer",
 *   "location": "Remote (EU)",
 *   "remote": true,
 *   "url": "https://acme.com/jobs/senior-platform-engineer",
 *   "discoveredVia": "job_board",
 *   "jobBoard": "Greenhouse",
 *   "score": 88,
 *   "scoreBreakdown": { "reasons": ["..."], "penalties": [], "relevant": true },
 *   "postedAt": "2026-11-02T09:00:00.000Z",
 *   "discoveredAt": "2026-11-05T09:00:00.000Z",
 *   "sourceUrl": null
 * }
 */
export type HubJobPayload = {
  source: "FINDER";
  sourceId: string;
  companyDomain: string;
  companyName?: string;
  title: string;
  location: string | null;
  remote: boolean;
  url: string;
  discoveredVia: "yc" | "newsfeed" | "job_board" | "google" | "other";
  /** Display name of the board when `discoveredVia` is "job_board", else null. */
  jobBoard: string | null;
  score: number;
  scoreBreakdown: Record<string, unknown>;
  postedAt: string | null;
  discoveredAt: string;
  sourceUrl: string | null;
};

/** Hub accepts arrays, so send changed jobs in the same batch size as backfill. */
export const HUB_BATCH_SIZE = 50;

const DISCOVERED_VIA: Record<SourceId, HubJobPayload["discoveredVia"]> = {
  yc: "yc",
  funding: "newsfeed",
  producthunt: "newsfeed",
  hn: "job_board",
  remoteok: "job_board",
  remotive: "job_board",
  arbeitnow: "job_board",
  internshala: "job_board",
  unstop: "job_board",
  google: "google",

  wellfound: "job_board",
  otta: "job_board",
  workatastartup: "job_board",
  himalayas: "job_board",
  weworkremotely: "job_board",
  remoteco: "job_board",
  jobspresso: "job_board",
  ai_jobs_net: "job_board",
  climatebase: "job_board",
  web3_career: "job_board",
  devrel_careers: "job_board",
  naukri: "job_board",
  cutshort: "job_board",
  greenhouse: "job_board",
  lever: "job_board",
  ashby: "job_board",

  // Newsletter/digest sources.
  tldr_jobs: "newsfeed",
  bytebytego: "newsfeed",
  indiehackers: "newsfeed",
};

/**
 * Board display names shown in Hub's "Found via" column. Only job-board
 * discoveries have a board; every other source sends null.
 *
 * These are intentionally literals: Hub must never receive a URL, "job_board",
 * or "jobboard" as the board name.
 */
const JOB_BOARD: Record<SourceId, string | null> = {
  yc: null,
  funding: null,
  producthunt: null,
  google: null,
  tldr_jobs: null,
  bytebytego: null,
  indiehackers: null,

  hn: "Hacker News",
  remoteok: "Remote OK",
  remotive: "Remotive",
  arbeitnow: "Arbeitnow",
  internshala: "Internshala",
  unstop: "Unstop",
  wellfound: "Wellfound",
  otta: "Otta",
  workatastartup: "Work at a Startup",
  himalayas: "Himalayas",
  weworkremotely: "We Work Remotely",
  remoteco: "Remote.co",
  jobspresso: "Jobspresso",
  ai_jobs_net: "AI Jobs",
  climatebase: "Climatebase",
  web3_career: "Web3.career",
  devrel_careers: "DevRel Careers",
  naukri: "Naukri",
  cutshort: "Cutshort",
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
};

interface HubState {
  version: 1;
  jobs: Record<string, { fingerprint: string; sentAt: string }>;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function httpUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function latestSignalDate(startup: Startup): string | null {
  let latest: number | undefined;

  for (const signal of startup.signals) {
    if (!signal.date) continue;
    const parsed = Date.parse(signal.date);
    if (Number.isNaN(parsed)) continue;
    if (latest === undefined || parsed > latest) latest = parsed;
  }

  return latest === undefined ? null : new Date(latest).toISOString();
}

/**
 * Hosts that belong to job boards, aggregators, and ATS vendors rather than to
 * the hiring company.
 *
 * A posting URL is almost always one of these, so using it as `companyDomain`
 * would create junk companies in Hub. Entries are matched against the hostname
 * and every subdomain of it (`boards.greenhouse.io` also covers
 * `job-boards.greenhouse.io`).
 */
export const BOARD_HOSTS: readonly string[] = [
  "news.ycombinator.com",
  "ycombinator.com",
  "hn.algolia.com",
  "internshala.com",
  "unstop.com",
  "linkedin.com",
  "remoteok.com",
  "remotive.com",
  "arbeitnow.com",
  "wellfound.com",
  "otta.com",
  "workatastartup.com",
  "himalayas.app",
  "weworkremotely.com",
  "remote.co",
  "jobspresso.co",
  "web3.career",
  "naukri.com",
  "cutshort.io",
  "jooble.org",
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "greenhouse.io",
  "jobs.lever.co",
  "lever.co",
  "jobs.ashbyhq.com",
  "ashbyhq.com",
  "producthunt.com",
  "mercurynews.com",
  "archive.ph",
  "applytojob.com",
  "arbeitnow.ch",
  "foorilla.com",
  "ai-jobs.net",
];

/** True when `domain` is a board host or a subdomain of one. */
function isBoardDomain(domain: string): boolean {
  return BOARD_HOSTS.some(
    (host) => domain === host || domain.endsWith(`.${host}`),
  );
}

/** Normalized domain for `raw`, unless it is missing or a board host. */
function employerDomainFrom(raw: string | undefined): string | undefined {
  const domain = domainFromUrl(raw);
  return domain && !isBoardDomain(domain) ? domain : undefined;
}

/**
 * Matches `http(s)://` URLs and email addresses in free text. URLs come first
 * so a `mailto:`-style token is read once, as a URL.
 */
const DESCRIPTION_LINK =
  /https?:\/\/[^\s<>"'`]+|[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

/** Trailing punctuation that ends a sentence rather than a link. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/**
 * Domains mentioned in a posting's description, in order of appearance.
 *
 * Board postings keep the employer's own site or email in the body while
 * `url` only points at the listing, so this is where a real company domain is
 * usually found.
 */
function descriptionDomains(description: string | undefined): string[] {
  if (!description) return [];

  const domains: string[] = [];
  for (const match of description.matchAll(DESCRIPTION_LINK)) {
    const token = match[0].replace(TRAILING_PUNCTUATION, "");
    if (!token) continue;

    // Keep only the host part of an email; leave URLs untouched so userinfo
    // (`https://user@host`) is not mistaken for an address.
    const raw = /^https?:\/\//i.test(token)
      ? token
      : token.slice(token.lastIndexOf("@") + 1);

    const domain = domainFromUrl(raw);
    if (domain) domains.push(domain);
  }

  return domains;
}

/**
 * Pick the hiring company's own domain for the Hub payload.
 *
 * Order: an explicit domain from the source, then links/emails in the
 * description, then the posting URL, then signal URLs. Board hosts are
 * rejected at every step; when nothing survives the job is skipped rather
 * than attributed to the board or an invented domain.
 */
function companyDomainFor(startup: Startup): string | undefined {
  const explicit = employerDomainFrom(startup.companyDomain);
  if (explicit) return explicit;

  for (const domain of descriptionDomains(startup.description)) {
    if (!isBoardDomain(domain)) return domain;
  }

  for (const candidate of [
    startup.url,
    ...startup.signals.map((signal) => signal.url),
  ]) {
    const domain = employerDomainFrom(candidate);
    if (domain) return domain;
  }

  return undefined;
}

/**
 * A single role written in title case, e.g. "Senior Backend Engineer".
 *
 * The optional prefix and the short run of capitals keep the match to a
 * phrase rather than swallowing a whole sentence, and only `Engineer`,
 * `Developer`, and similar nouns count as the role itself.
 */
const ROLE_PHRASE =
  /((?:Senior|Staff|Principal|Lead|Junior|Founding|Sr\.?|Jr\.?)\s+)?([A-Z][\w/&+.-]*(?:\s+[\w/&+.-]+){0,2}?\s+(?:Engineer|Developer|Designer|Manager|Scientist|Analyst|Architect|Researcher|Specialist|Programmer))/g;

const ROLE_WORD =
  /\b(engineer|developer|designer|manager|scientist|analyst|architect|researcher|specialist|programmer)\b/i;

/** Words that describe where a job is, not what it is. */
const LOCATION_FLAG = /\b(remote|hybrid|on-?site|in[- ]person|wfh|work from home)\b/i;

/** "Philadelphia / NYC / Toronto" — a list of places, not a role. */
const CITY_LIST = /^[A-Z][A-Za-z .'-]+(?:\s*\/\s*[A-Z][A-Za-z .'-]+)+$/;

/** "Tokyo, Japan" is a place; "Security, Machine Learning" is not. */
const CITY_COUNTRY = /^[A-Z][A-Za-z .'-]+,\s*([A-Za-z ]+?)(?:\s*\([^)]*\))?$/;
const COUNTRY_HINTS = new Set([
  "usa", "us", "uk", "united kingdom", "united states", "canada", "india",
  "germany", "france", "netherlands", "spain", "italy", "portugal", "poland",
  "sweden", "norway", "denmark", "finland", "switzerland", "austria",
  "belgium", "ireland", "israel", "japan", "china", "singapore", "australia",
  "new zealand", "brazil", "mexico", "argentina", "chile", "colombia",
  "czech republic", "czechia", "hungary", "romania", "bulgaria", "greece",
  "turkey", "uae", "united arab emirates", "south korea", "korea", "taiwan",
  "hong kong", "indonesia", "malaysia", "philippines", "vietnam", "thailand",
  "south africa", "nigeria", "kenya", "egypt", "saudi arabia", "qatar",
]);

/** True when a "City, Country" title names a place instead of a role. */
function isCityCountry(title: string): boolean {
  const match = title.match(CITY_COUNTRY);
  return Boolean(match?.[1] && COUNTRY_HINTS.has(match[1].trim().toLowerCase()));
}

/** True when the subject line can be sent as a Hub `title` unchanged. */
function isUsableTitle(value: string, startup: Startup): boolean {
  const title = value.trim();
  if (!title || title.length > 100) return false;
  if (/\b(multiple|various|all|several)\s+roles\b/i.test(title)) return false;
  if (LOCATION_FLAG.test(title) && !ROLE_WORD.test(title)) return false;
  if (CITY_LIST.test(title)) return false;
  if (isCityCountry(title)) return false;

  return !startup.locations.some(
    (location) => location.trim().toLowerCase() === title.toLowerCase(),
  );
}

/** First role-shaped phrase in a description, e.g. from "• Senior SRE". */
function roleFromDescription(description: string | undefined): string | undefined {
  if (!description) return undefined;

  for (const segment of description.slice(0, 6000).split(/[|\n•]+/)) {
    for (const match of segment.matchAll(ROLE_PHRASE)) {
      const title = `${match[1] ?? ""}${match[2] ?? ""}`
        .replace(/^[\s\-*–—]+/, "")
        .replace(/[\s,;:.\-–—]+$/, "")
        .trim();

      if (!title || title.length > 100) continue;
      if (/^(the|a|an|our|we|this|your|their|its)\b/i.test(title)) continue;
      // "Staff SWEs in NYC. Engineer" is a sentence fragment, not a role.
      if (/[.!?]\s/.test(title)) continue;
      if (/\b(in|at|for|with|and|to|of|is|are|we|our|you|your|on|via)\b/.test(match[2] ?? "")) continue;
      return title;
    }
  }

  return undefined;
}

/**
 * Hub shows `title` as the role, so a location, a paragraph, or "Multiple
 * roles" must not reach it. Fall back to the first role named in the
 * description, then to the company name when the posting names no single role.
 */
function hubTitle(startup: Startup): string | undefined {
  const raw = (startup.oneLiner ?? "").trim();
  if (raw && isUsableTitle(raw, startup)) return truncate(raw, 300);

  const fromDescription = roleFromDescription(startup.description);
  if (fromDescription) return truncate(fromDescription, 300);

  const name = startup.name.trim();
  return name ? truncate(name, 300) : undefined;
}

/**
 * Map one scored match to the Hub jobs payload.
 *
 * Returns `undefined` when the record cannot be represented safely (missing
 * id, title, apply URL, or a usable company domain). In that case the reason
 * is logged and the job is skipped rather than sending an invalid batch.
 */
export function toHubJob(
  match: Match,
  discoveredAt: string = new Date().toISOString(),
): HubJobPayload | undefined {
  const startup = match.startup;
  const rawId = startup.id?.trim();
  if (!rawId) {
    logger.warn("hub: skipping job without an id");
    return undefined;
  }

  const companyDomain = companyDomainFor(startup);
  if (!companyDomain) {
    logger.warn(
      `hub: skipping ${rawId} — could not derive a company domain from the company website or job URL`,
    );
    return undefined;
  }

  const title = hubTitle(startup);
  if (!title) {
    logger.warn(`hub: skipping ${rawId} — no job title`);
    return undefined;
  }

  const url =
    httpUrl(startup.url) ??
    startup.signals.map((signal) => httpUrl(signal.url)).find(Boolean);
  if (!url) {
    logger.warn(`hub: skipping ${rawId} — no absolute job URL`);
    return undefined;
  }

  const sourceId = truncate(rawId, 200);
  const location = startup.locations.join(", ").trim();
  const rawScore = match.llm?.score ?? match.score;
  const effectiveScore = Number.isFinite(rawScore) ? rawScore : match.score;
  const discoveredVia = DISCOVERED_VIA[startup.source] ?? "other";
  const jobBoard =
    discoveredVia === "job_board" ? (JOB_BOARD[startup.source] ?? null) : null;

  return {
    source: "FINDER",
    sourceId,
    companyDomain,
    companyName: startup.name.trim() ? truncate(startup.name.trim(), 300) : undefined,
    title,
    location: location ? truncate(location, 300) : null,
    remote: Boolean(startup.remote),
    url,
    discoveredVia: DISCOVERED_VIA[startup.source] ?? "other",
    jobBoard: jobBoard ? truncate(jobBoard, 120) : null,
    score: Math.max(0, Math.min(100, Math.round(effectiveScore))),
    scoreBreakdown: {
      score: match.score,
      reasons: match.reasons,
      penalties: match.penalties,
      relevant: match.relevant,
      ...(match.llm ? { llm: match.llm } : {}),
    },
    postedAt: latestSignalDate(startup),
    discoveredAt,
    // Hub opens `url`; Finder has no web UI, so there is no browser-openable
    // record page and a `finder://` deep link must never be sent.
    sourceUrl: null,
  };
}

function statePath(root: string): string {
  return resolve(root, "data", "hub-state.json");
}

function loadState(root: string): HubState {
  const path = statePath(root);
  if (!existsSync(path)) return { version: 1, jobs: {} };

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HubState>;
    return { version: 1, jobs: parsed.jobs ?? {} };
  } catch (err) {
    logger.warn(`hub: could not read ${path} — ${(err as Error).message}`);
    return { version: 1, jobs: {} };
  }
}

function saveState(root: string, state: HubState): void {
  const path = statePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

/** Ignore the send time; everything else is part of the change check. */
function fingerprint(payload: HubJobPayload): string {
  const { discoveredAt: _ignored, ...rest } = payload;
  return createHash("sha1").update(JSON.stringify(rest)).digest("hex");
}

/**
 * Serialize syncs so overlapping runs cannot read stale fingerprints and send
 * the same job twice.
 */
let queue: Promise<void> = Promise.resolve();

async function runSync(
  root: string,
  matches: Match[],
  discoveredAt: string,
): Promise<void> {
  const state = loadState(root);
  const pending: Array<{
    id: string;
    payload: HubJobPayload;
    fingerprint: string;
  }> = [];

  for (const match of matches) {
    const payload = toHubJob(match, discoveredAt);
    if (!payload) continue;

    const nextFingerprint = fingerprint(payload);
    if (state.jobs[payload.sourceId]?.fingerprint === nextFingerprint) {
      continue;
    }

    pending.push({
      id: payload.sourceId,
      payload,
      fingerprint: nextFingerprint,
    });
  }

  if (pending.length === 0) return;

  let sent = 0;

  for (let index = 0; index < pending.length; index += HUB_BATCH_SIZE) {
    const batch = pending.slice(index, index + HUB_BATCH_SIZE);
    const ok = await sendToHub(
      "jobs",
      batch.map((item) => item.payload),
    );
    if (!ok) continue;

    const sentAt = new Date().toISOString();
    for (const item of batch) {
      state.jobs[item.id] = { fingerprint: item.fingerprint, sentAt };
    }
    sent += batch.length;
  }

  if (sent > 0) {
    saveState(root, state);
    logger.info(`hub: synced ${sent} job(s)`);
  }
}

/**
 * Send the scored jobs to Hub, skipping any whose payload has not changed since
 * the last successful send. Safe to call without awaiting: it never throws and
 * a Hub outage never blocks the matcher.
 */
export function syncMatchesToHub(
  root: string,
  matches: Match[],
  discoveredAt: string = new Date().toISOString(),
): Promise<void> {
  // Missing configuration is a silent no-op, including no state file writes.
  if (!hubConfigured()) return Promise.resolve();

  queue = queue
    .then(() => runSync(root, matches, discoveredAt))
    .catch((err) => {
      logger.error(`hub: sync failed — ${(err as Error).message}`);
    });

  return queue;
}
