import { requiredYears } from "../lib/experience.js";
import { daysSince, normalizeWhitespace, termPattern } from "../lib/text.js";
import type { Profile, ScoreBreakdown, Startup } from "../types.js";

const SENIOR_TITLES =
  /(?<![a-z])(senior|sr\.?|staff|principal|lead|manager|director|head of|vp|architect)(?![a-z])/i;
const EARLY_TITLES =
  /(?<![a-z])(founding engineer|new grad|new graduate|junior|entry[- ]level|graduate|internship|intern|trainee|fresher|associate)(?![a-z])/i;

/** Sources where `oneLiner` is an actual job title, not a company tagline. */
const JOB_POSTING_SOURCES = new Set(["remoteok", "remotive", "arbeitnow", "internshala", "unstop", "hn"]);

/**
 * Skills that are too common to prove a fit on their own. They still add to the
 * score, but a posting needs at least one core skill to be relevant.
 */
const GENERIC_SKILLS = new Set([
  "git",
  "github",
  "docker",
  "aws",
  "open source",
  "data structures and algorithms",
]);

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
  const earlyCareer = profile.seniority === "junior" || profile.seniority === "mid";

  // For job postings the title is the authoritative role text; for company
  // signals (funding, launches, YC) the tagline/headline is the best we have.
  // Keeping the company name out of the role text stops "Senior Care Inc."
  // from looking like a senior engineering role.
  const roleText = normalizeWhitespace(
    JOB_POSTING_SOURCES.has(startup.source)
      ? (startup.oneLiner ?? "")
      : [startup.oneLiner ?? "", ...startup.signals.map((x) => x.text ?? "")].join(" "),
  ).toLowerCase();

  const blob = normalizeWhitespace(
    [
      startup.name,
      roleText,
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

  // --- experience-level gates (junior/mid profiles only) --------------------
  if (earlyCareer && JOB_POSTING_SOURCES.has(startup.source) && SENIOR_TITLES.test(roleText)) {
    return {
      score: 0,
      reasons: ["Senior/lead role — outside your experience level"],
      penalties: ["seniority gap"],
      relevant: false,
    };
  }

  const required = requiredYears(`${startup.oneLiner ?? ""} ${startup.description ?? ""}`);
  const maxRequired = prefs.maxRequiredYears ?? 2;
  if (earlyCareer && required !== undefined && required > maxRequired) {
    return {
      score: 0,
      reasons: [`Requires ~${required}+ years of experience (you have ${profile.yearsExperience})`],
      penalties: ["experience gap"],
      relevant: false,
    };
  }

  let score = 0;

  // --- role / skill overlap (max 40) ----------------------------------------
  const skillHits = profile.skills.filter((t) => termPattern(t).test(blob));
  const roleHits = profile.roles.filter((t) => termPattern(t).test(blob));
  const domainHits = profile.domains.filter((t) => termPattern(t).test(blob));
  const matched = [...new Set([...skillHits, ...roleHits, ...domainHits])];

  const termScale = Math.max(1, Math.min(profile.skills.length + profile.roles.length, 8));
  const rolePoints = Math.round(Math.min(1, matched.length / termScale) * 40);
  score += rolePoints;
  if (matched.length) {
    reasons.push(`Matches your terms: ${matched.slice(0, 6).join(", ")}`);
  }

  // --- industry / domain overlap (max 8) ------------------------------------
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
  if (earlyCareer && SENIOR_TITLES.test(roleText)) {
    score -= 20;
    penalties.push("Reads as a senior/lead role");
  }
  if (earlyCareer && EARLY_TITLES.test(roleText)) {
    score += 12;
    reasons.push("Early-career friendly");
  }
  if (earlyCareer && required !== undefined && required <= maxRequired) {
    score -= required === 2 ? 6 : 0;
    if (required === 2) penalties.push("Asks for ~2 years (you have ~1)");
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

  // A listing must actually overlap your stack. A role word alone (e.g.
  // "software developer" on an AutoCAD job) or a domain alone is not a match,
  // and a lone generic skill (GitHub, Docker) is not enough either.
  const coreHits = skillHits.filter((t) => !GENERIC_SKILLS.has(t.toLowerCase()));
  const relevant =
    coreHits.length >= 2 ||
    (roleHits.length >= 1 && coreHits.length >= 1) ||
    (domainHits.length >= 1 && coreHits.length >= 1);

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
    penalties,
    relevant,
  };
}
