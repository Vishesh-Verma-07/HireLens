import { daysSince } from "../lib/text.js";
import type { Match, Profile, Startup } from "../types.js";
import { scoreStartup } from "./score.js";

function normName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Job postings are distinct opportunities, even at the same company. */
const JOB_SOURCES = new Set(["remoteok", "remotive", "arbeitnow", "internshala", "unstop", "hn"]);

function dedupeKey(s: Startup): string {
  const company = normName(s.name);
  if (!company) return "";
  if (JOB_SOURCES.has(s.source)) {
    const role = normName(s.oneLiner ?? "");
    return role ? `${company}|${role}` : company;
  }
  return company;
}

/**
 * Score every startup, merge duplicate job postings (same company + role across
 * boards), then sort by fit. Company-level signals (funding, launches) stay as
 * their own rows so they never erase a distinct role.
 */
export function rankStartups(
  startups: Startup[],
  profile: Profile,
  now: number = Date.now(),
): Match[] {
  const byName = new Map<string, Startup>();

  for (const s of startups) {
    const key = dedupeKey(s);
    if (!key) continue;
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, s);
      continue;
    }
    // Merge signals and fill in missing fields from the duplicate.
    existing.signals.push(...s.signals);
    existing.locations = [...new Set([...existing.locations, ...s.locations])];
    existing.industry = [...new Set([...existing.industry, ...s.industry])];
    existing.stage ??= s.stage;
    existing.oneLiner ??= s.oneLiner;
    existing.url ??= s.url;
    existing.remote = existing.remote || s.remote;
  }

  const matches: Match[] = [...byName.values()].map((startup) => ({
    startup,
    ...scoreStartup(startup, profile, now),
  }));

  // Hard freshness gate: when maxAgeDays is set, keep only opportunities with
  // a verifiable, recent signal. Undated entries are dropped rather than
  // silently shown as "fresh".
  const maxAgeDays = profile.preferences.maxAgeDays;
  const fresh =
    maxAgeDays === undefined
      ? matches
      : matches.filter((m) => {
          const age = m.startup.signals
            .map((s) => daysSince(s.date, now))
            .filter((d): d is number => d !== undefined)
            .sort((a, b) => a - b)[0];
          return age !== undefined && age <= maxAgeDays;
        });

  return fresh
    .filter((m) => m.relevant && m.score > 0)
    .sort((a, b) => {
      const aScore = a.llm?.score ?? a.score;
      const bScore = b.llm?.score ?? b.score;
      return bScore - aScore;
    });
}
