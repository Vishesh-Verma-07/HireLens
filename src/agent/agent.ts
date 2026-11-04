import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../lib/log.js";
import { localDate } from "../lib/date.js";
import { rankStartups } from "../match/rank.js";
import { selectForDigest } from "../match/select.js";
import { loadProfile } from "../profile.js";
import {
  renderDigestHtml,
  renderDigestText,
  renderMatchDetailHtml,
  renderMatchDetailText,
} from "../report/digest.js";
import { collectStartups, loadSourceConfig } from "../sources/index.js";
import type { Match, Profile } from "../types.js";

// The agent core is transport-agnostic: it knows nothing about email or
// WhatsApp. A channel adapter feeds it text and delivers what it returns.

const PAGE_SIZE = 10;
const SNAPSHOT_LIMIT = 60;
/** No employer may take more than this many slots in one digest. */
const PER_COMPANY = 2;

/**
 * The full digest list for today: newest, highest-fit rows first, minus jobs
 * already emailed in an earlier digest and minus a company's 3rd+ row.
 *
 * Both the daily email and the "matches"/"more" replies go through here, so
 * what you read in the email is exactly what the bot pages through.
 */
function digestList(matches: Match[], excludeUrls?: Set<string>): Match[] {
  return selectForDigest(matches, {
    excludeUrls,
    limit: Number.POSITIVE_INFINITY,
    perCompany: PER_COMPANY,
  });
}

export interface Snapshot {
  generatedAt: string;
  matches: Match[];
}

export interface Reply {
  subject: string;
  text: string;
  html: string;
}

interface EmailState {
  lastSentDate?: string;
  snapshotDate?: string;
  offset?: number;
}

function dataDir(root: string): string {
  return resolve(root, "data");
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dataDir(resolve(path, "..")), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function today(): string {
  return localDate();
}

// --- profile + exclusions --------------------------------------------------

export function loadProfileWithExclusions(root: string): Profile {
  const profile = loadProfile(resolve(root, "profile", "profile.yaml"));
  const exclusions = readJson<string[]>(resolve(dataDir(root), "exclusions.json")) ?? [];
  const merged = new Set(profile.preferences.excludeCompanies);
  for (const e of exclusions) merged.add(e.toLowerCase());
  profile.preferences.excludeCompanies = [...merged];
  return profile;
}

export function addExclusion(root: string, name: string): void {
  const path = resolve(dataDir(root), "exclusions.json");
  const list = readJson<string[]>(path) ?? [];
  const clean = name.trim().toLowerCase();
  if (clean && !list.includes(clean)) list.push(clean);
  writeJson(path, list);
}

// --- matcher run + daily snapshot -----------------------------------------

async function runMatcher(root: string, profile: Profile): Promise<Match[]> {
  const sourceConfig = loadSourceConfig(resolve(root, "config", "sources.yaml"));
  const startups = await collectStartups(sourceConfig, { profile });
  logger.info(`Collected ${startups.length} raw startup records`);
  return rankStartups(startups, profile);
}

export async function getSnapshot(root: string, force = false): Promise<Snapshot> {
  const path = resolve(dataDir(root), `snapshot-${today()}.json`);
  if (!force) {
    const cached = readJson<Snapshot>(path);
    if (cached) return cached;
  }

  const profile = loadProfileWithExclusions(root);
  const ranked = (await runMatcher(root, profile)).slice(0, SNAPSHOT_LIMIT);
  const snapshot: Snapshot = { generatedAt: new Date().toISOString(), matches: ranked };
  writeJson(path, snapshot);
  logger.info(`Snapshot: ${ranked.length} matches`);
  return snapshot;
}

// --- state -----------------------------------------------------------------

export function readState(root: string): EmailState {
  const state = readJson<EmailState>(resolve(dataDir(root), "email-state.json")) ?? {};
  if (state.snapshotDate && state.snapshotDate !== today()) state.offset = 0;
  return state;
}

export function writeState(root: string, state: EmailState): void {
  writeJson(resolve(dataDir(root), "email-state.json"), state);
}

export function shouldSendDaily(root: string, hour: number): boolean {
  const state = readState(root);
  if (state.lastSentDate === today()) return false;
  return new Date().getHours() >= hour;
}

export function markDailySent(root: string): void {
  const state = readState(root);
  state.lastSentDate = today();
  state.snapshotDate = today();
  state.offset = 0;
  writeState(root, state);
}

// --- command handling ------------------------------------------------------

const HELP = [
  "jobfinder — your startup-job matcher, by email.",
  "",
  "Commands (just reply):",
  "  matches        today's matches",
  "  more           next batch",
  "  <number>       full details for that match",
  "  refresh        re-run the search now",
  "  exclude <name> never show that company again",
  "  help           this message",
].join("\n");

function reply(subject: string, text: string, html: string): Reply {
  return { subject, text, html };
}

export interface CommandOptions {
  /** Job URLs already emailed in an earlier digest, so replies stay consistent. */
  excludeUrls?: Set<string>;
}

export async function handleCommand(
  root: string,
  raw: string,
  opts: CommandOptions = {},
): Promise<Reply> {
  const text = raw.trim().toLowerCase();
  const state = readState(root);

  const showPage = async (force: boolean, subject: string): Promise<Reply> => {
    const snapshot = await getSnapshot(root, force);
    const list = digestList(snapshot.matches, opts.excludeUrls);
    const offset = state.offset ?? 0;
    const page = list.slice(offset, offset + PAGE_SIZE);
    if (page.length === 0) {
      return reply(
        subject,
        `No more matches. Reply "refresh" to run a fresh search.`,
        `<p style="font-family:sans-serif">No more matches. Reply <strong>refresh</strong> to run a fresh search.</p>`,
      );
    }
    const renderOpts = { startIndex: offset };
    return reply(
      subject,
      renderDigestText(loadProfileWithExclusions(root), page, renderOpts),
      renderDigestHtml(loadProfileWithExclusions(root), page, renderOpts),
    );
  };

  // "exclude <name>"
  const excludeMatch = raw.match(/^(?:exclude|block)\s+(.+)$/i);
  if (excludeMatch?.[1]) {
    const name = excludeMatch[1].trim();
    addExclusion(root, name);
    return reply(
      `[jobfinder] excluded ${name}`,
      `Got it — "${name}" won't appear again.`,
      `<p style="font-family:sans-serif">Got it — <strong>${name}</strong> won't appear again.</p>`,
    );
  }

  if (text === "refresh" || text === "rerun") {
    state.offset = 0;
    state.snapshotDate = today();
    writeState(root, state);
    return showPage(true, `[jobfinder] ${today()}`);
  }

  if (text === "more" || text === "next") {
    const latest = await getSnapshot(root, false);
    const list = digestList(latest.matches, opts.excludeUrls);
    state.offset = Math.min((state.offset ?? 0) + PAGE_SIZE, Math.max(0, list.length - 1));
    state.snapshotDate = today();
    writeState(root, state);
    return showPage(false, `[jobfinder] more`);
  }

  if (text === "help" || text === "") {
    return reply("[jobfinder] help", HELP, `<pre style="font-family:monospace">${HELP}</pre>`);
  }

  if (/^\d+$/.test(text)) {
    const n = Number.parseInt(text, 10);
    const snapshot = await getSnapshot(root, false);
    const match = digestList(snapshot.matches, opts.excludeUrls)[n - 1];
    if (!match) {
      return reply(
        `[jobfinder] no match #${n}`,
        `There's no match #${n}. Reply "matches" to see the list.`,
        `<p style="font-family:sans-serif">There's no match #${n}. Reply <strong>matches</strong> to see the list.</p>`,
      );
    }
    return reply(
      `[jobfinder] ${match.startup.name}`,
      renderMatchDetailText(match, n),
      renderMatchDetailHtml(match, n),
    );
  }

  if (text === "matches" || text === "new" || text === "latest") {
    state.offset = 0;
    writeState(root, state);
    return showPage(false, `[jobfinder] ${today()}`);
  }

  return reply(
    "[jobfinder] help",
    `I didn't understand "${raw.trim()}".\n\n${HELP}`,
    `<p style="font-family:sans-serif">I didn't understand that.</p><pre style="font-family:monospace">${HELP}</pre>`,
  );
}
