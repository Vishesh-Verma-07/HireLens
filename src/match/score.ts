import { daysSince, normalizeWhitespace, termPattern } from "../lib/text.js";
import type { Profile, ScoreBreakdown, Startup } from "../types.js";

const SENIOR_TITLES =
  /(?<![a-z])(senior|staff|principal|lead|manager|director|head of|vp|architect)(?![a-z])/i;
const EARLY_TITLES =
  /(?<![a-z])(founding engineer|new grad|new graduate|junior|entry[- ]level|graduate engineer|internship|intern)(?![a-z])/i;

/**
 * Deterministic fit score (0-100) plus human-readable reasons.
 *
 * This is the transparent core of the matcher: every point a startup earns is
 * explained. An optional LLM layer (src/match/llm.ts) can re-rank the top
 * slice afterwards, but the ranking never depends on a black box.
 */
export function scoreStartup(
  startup: Startup,
  profile: Profile,
  now: number = Date.now(),
): ScoreBreakdown {
  const reasons: string[] = [];
  const penalties: string[] = [];
  const prefs = profile.preferences;

  const titleBlob = normalizeWhitespace(
    [
      startup.name,
      startup.oneLiner ?? "",
      ...startup.signals.map((x) => x.text ?? ""),
    ].join(" "),
  ).toLowerCase();

  const blob = normalizeWhitespace(
    [
      titleBlob,
      startup.industry.join(" "),
      startup.description ?? "",
      startup.batch ? `batch ${startup.batch}` : "",
    ].join(" "),
  ).toLowerCase();

  // --- hard exclusions -------------------------------------------------------
  const nameLower = startup.name.toLowerCase();
  if (prefs.excludeCompanies.some((c) => c && nameLower === c)) {
    return { score: 0, reasons: ["Excluded company (profile.preferences.excludeCompanies)"], penalties: ["excluded"], relevant: false };
  }
  const badKeyword = prefs.excludeKeywords.find((k) => k && termPattern(k).test(blob));
  if (badKeyword) {
    return { score: 0, reasons: [`Excluded keyword "${badKeyword}"`], penalties: ["excluded"], relevant: false };
  }

  let score = 0;

  // --- role / skill overlap (max 40) ----------------------------------------
  const terms = [...new Set([...profile.skills, ...profile.domains, ...profile.roles])];
  const matched = terms.filter((t) => termPattern(t).test(blob));
  const termScale = Math.max(1, Math.min(terms.length, 8));
  const rolePoints = Math.round(Math.min(1, matched.length / termScale) * 40);
  score += rolePoints;
  if (matched.length) {
    reasons.push(`Matches your terms: ${matched.slice(0, 6).join(", ")}`);
  }

  // --- industry / domain overlap (max 8) ------------------------------------
  const domainHits = profile.domains.filter((d) => termPattern(d).test(blob));
  if (domainHits.length) {
    score += 8;
    reasons.push(`In your target space: ${domainHits.join(", ")}`);
  }

  // --- signal strength (max 12) ---------------------------------------------
  const signalPoints: Record<string, number> = { raised: 12, hiring: 10, launched: 6, news: 3 };
  const best = startup.signals.reduce(
    (max, sig) => Math.max(max, signalPoints[sig.type] ?? 0),
    0,
  );
  score += best;
  const topSignal = startup.signals.find((x) => (signalPoints[x.type] ?? 0) === best);
  if (topSignal) {
    reasons.push(
      `Signal: ${topSignal.type}${topSignal.amountUsd ? ` ($${Math.round(topSignal.amountUsd / 1e6)}M)` : ""}`,
    );
  }

  // --- recency (max 15) ------------------------------------------------------
  const mostRecent = startup.signals
    .map((x) => daysSince(x.date, now))
    .filter((d): d is number => d !== undefined)
    .sort((a, b) => a - b)[0];
  if (mostRecent !== undefined) {
    const recency =
      mostRecent <= 1
        ? 15
        : mostRecent <= 3
          ? 13
          : mostRecent <= 7
            ? 9
            : mostRecent <= 14
              ? 6
              : mostRecent <= 30
                ? 3
                : 0;
    score += recency;
    if (recency) reasons.push(`Fresh: ${mostRecent}d ago`);
  }

  // --- seniority fit ---------------------------------------------------------
  const earlyCareer = profile.seniority === "junior" || profile.seniority === "mid";
  if (earlyCareer && SENIOR_TITLES.test(titleBlob)) {
    score -= 12;
    penalties.push("Reads as a senior/lead role");
  }
  if (earlyCareer && EARLY_TITLES.test(titleBlob)) {
    score += 8;
    reasons.push("Early-career friendly");
  }

  // --- stage fit (max 18, or penalty) ---------------------------------------
  if (prefs.stages.length) {
    if (startup.stage && prefs.stages.includes(startup.stage)) {
      score += 18;
      reasons.push(`Stage match: ${startup.stage}`);
    } else if (startup.stage) {
      score -= 10;
      penalties.push(`Stage ${startup.stage} is outside your preferred set`);
    }
  }

  // --- location / remote (max 22) -------------------------------------------
  if (prefs.remote && startup.remote) {
    score += 10;
    reasons.push("Remote-friendly");
  }
  // "Remote" is already rewarded above; don't count it twice as a location.
  const namedLocations = prefs.locations.filter((l) => !/^remote$/i.test(l));
  const locHit = namedLocations.find((l) =>
    startup.locations.some((sl) => sl.toLowerCase().includes(l.toLowerCase())),
  );
  if (locHit) {
    score += 12;
    reasons.push(`Location: ${locHit}`);
  } else if (!startup.remote && startup.locations.length && prefs.locations.length) {
    penalties.push(`Outside your locations (${startup.locations.join(", ")})`);
  }

  // --- size window (soft) ----------------------------------------------------
  if (startup.employees && (prefs.minEmployees || prefs.maxEmployees)) {
    const n = Number.parseInt(startup.employees.replace(/[^\d]/g, ""), 10);
    if (!Number.isNaN(n)) {
      if (prefs.minEmployees && n < prefs.minEmployees) {
        score -= 5;
        penalties.push(`Smaller than your window (${n})`);
      }
      if (prefs.maxEmployees && n > prefs.maxEmployees) {
        score -= 5;
        penalties.push(`Larger than your window (${n})`);
      }
    }
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
    penalties,
    relevant: matched.length > 0 || domainHits.length > 0,
  };
}
