// Shared domain types for the matcher.
//
// Vocabulary (kept deliberately small — see README):
//   Signal   — a public event that says a startup is worth looking at
//              (raised a round, launched, started hiring, was in the news).
//   Startup  — a company, plus the signals attached to it.
//   Profile  — one person's background + preferences. This is the "for me
//              only" side of the matcher.
//   Match    — a startup with a fit score and human-readable reasons.

export type SourceId =
  | "yc"
  | "hn"
  | "funding"
  | "producthunt"
  | "remoteok"
  | "remotive"
  | "arbeitnow"
  | "internshala"
  | "unstop"
  | "google";

export type SignalType = "raised" | "launched" | "hiring" | "news";

export interface Signal {
  type: SignalType;
  /** ISO 8601 date of the event, if known. */
  date?: string;
  /** Short human-readable description of the event. */
  text?: string;
  url?: string;
  /** Funding amount in USD, when the signal is a raise. */
  amountUsd?: number;
}

export interface Startup {
  /** Stable id, e.g. "hn:acme". Used to dedupe across daily runs. */
  id: string;
  name: string;
  oneLiner?: string;
  /** Long-form text (job description, company blurb) used for matching only. */
  description?: string;
  url?: string;
  locations: string[];
  remote?: boolean;
  /** Normalized: "pre-seed" | "seed" | "series-a" | "series-b" | ... */
  stage?: string;
  industry: string[];
  employees?: string;
  batch?: string;
  source: SourceId;
  signals: Signal[];
}

export interface Preferences {
  stages: string[];
  remote: boolean;
  locations: string[];
  minEmployees?: number;
  maxEmployees?: number;
  visaStatus?: string;
  needsSponsorship?: boolean;
  excludeCompanies: string[];
  excludeKeywords: string[];
  /**
   * Hard cap on a posting's stated years-of-experience requirement. Postings
   * asking for more are dropped for early-career profiles.
   */
  maxRequiredYears?: number;
  /**
   * Only keep opportunities whose most recent signal is at most this many days
   * old. Undated opportunities are dropped when this is set, because their
   * freshness cannot be verified.
   */
  maxAgeDays?: number;
}

export interface ProjectLink {
  live?: string;
  github?: string;
}

export interface ProfileLinks {
  portfolio?: string;
  github?: string;
  linkedin?: string;
  leetcode?: string;
  email?: string;
  resume?: string;
  projects: Record<string, ProjectLink>;
  openSource: Record<string, string>;
}

export interface Education {
  school: string;
  degree?: string;
  start?: string;
  end?: string;
  location?: string;
  score?: string;
}

export interface Profile {
  name: string;
  headline: string;
  summary: string;
  skills: string[];
  domains: string[];
  seniority: string;
  yearsExperience: number;
  roles: string[];
  highlights: string[];
  preferences: Preferences;
  /** Identity + proof links. Not used for scoring; used by the outreach step. */
  links?: ProfileLinks;
  education: Education[];
}

export interface ScoreBreakdown {
  score: number;
  reasons: string[];
  penalties: string[];
  /** True when at least one profile skill/domain/role matched. */
  relevant: boolean;
}

export interface Match extends ScoreBreakdown {
  startup: Startup;
  /** Optional LLM re-rank, only present when the llm layer is enabled. */
  llm?: { score: number; reason: string };
}
