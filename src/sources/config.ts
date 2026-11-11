/**
 * Typed schema for `config/sources.yaml`.
 *
 * Each source owns one block under `sources:`. Every field is optional, so a
 * block can be as small as `enabled: false`; the defaults below (and each
 * source module's own fallbacks) fill in the rest. Unknown ids and malformed
 * values are reported by `planSources()` as warnings instead of crashing a run.
 *
 * Source modules land in their own tickets; this file is the contract they
 * import their config type from, so the YAML and the implementation cannot
 * drift apart.
 */

import type { SourceId } from "../types.js";
import type { ArbeitnowConfig } from "./arbeitnow.js";
import type { FundingConfig } from "./funding.js";
import type { GoogleSourceConfig } from "./google.js";
import type { HnConfig } from "./hn.js";
import type { InternshalaConfig } from "./internshala.js";
import type { OttaConfig } from "./otta.js";
import type { ProductHuntConfig } from "./producthunt.js";
import type { RemoteOkConfig } from "./remoteok.js";
import type { RemotiveConfig } from "./remotive.js";
import type { BaseSourceConfig } from "./types.js";
import type { UnstopConfig } from "./unstop.js";
import type { WorkAtAStartupConfig } from "./workatastartup.js";
import type { YcConfig } from "./yc.js";

/** Fields every source block accepts. */
export interface SourceSettings {
  enabled?: boolean;
  [key: string]: unknown;
}

/** Sources that return at most `limit` records. */
export interface LimitedSourceConfig extends BaseSourceConfig {
  limit?: number;
}

/** A source backed by a single RSS/Atom feed. */
export interface FeedSourceConfig extends LimitedSourceConfig {
  feedUrl?: string;
}

/** Career-page aggregators, which scan a list of company slugs. */
export interface CompanyAggregatorConfig extends LimitedSourceConfig {
  companies?: string[];
}

export interface WellfoundConfig extends LimitedSourceConfig {
  /** Optional key for a higher API quota. */
  apiKey?: string;
  categories?: string[];
}

export type { OttaConfig };

export type { WorkAtAStartupConfig };

export interface HimalayasConfig extends LimitedSourceConfig {
  remoteOnly?: boolean;
}

export type WeWorkRemotelyConfig = FeedSourceConfig;
export type RemoteCoConfig = FeedSourceConfig;
export type JobspressoConfig = FeedSourceConfig;
export type TldrJobsConfig = FeedSourceConfig;
export type ByteByteGoConfig = FeedSourceConfig;
export type IndieHackersConfig = FeedSourceConfig;

export type AiJobsNetConfig = LimitedSourceConfig;
export type ClimatebaseConfig = LimitedSourceConfig;
export type Web3CareerConfig = LimitedSourceConfig;
export type DevRelCareersConfig = LimitedSourceConfig;
export type CutshortConfig = LimitedSourceConfig;

export interface NaukriConfig extends LimitedSourceConfig {
  categories?: string[];
}

export type GreenhouseConfig = CompanyAggregatorConfig;
export type LeverConfig = CompanyAggregatorConfig;
export type AshbyConfig = CompanyAggregatorConfig;

/** The `sources.yaml` block for each known source id. */
export interface SourceSettingsMap {
  hn: HnConfig;
  funding: FundingConfig;
  producthunt: ProductHuntConfig;
  remoteok: RemoteOkConfig;
  remotive: RemotiveConfig;
  arbeitnow: ArbeitnowConfig;
  internshala: InternshalaConfig;
  unstop: UnstopConfig;
  yc: YcConfig;
  google: GoogleSourceConfig;

  wellfound: WellfoundConfig;
  otta: OttaConfig;
  workatastartup: WorkAtAStartupConfig;
  himalayas: HimalayasConfig;

  weworkremotely: WeWorkRemotelyConfig;
  remoteco: RemoteCoConfig;
  jobspresso: JobspressoConfig;
  tldr_jobs: TldrJobsConfig;
  bytebytego: ByteByteGoConfig;
  indiehackers: IndieHackersConfig;

  ai_jobs_net: AiJobsNetConfig;
  climatebase: ClimatebaseConfig;
  web3_career: Web3CareerConfig;
  devrel_careers: DevRelCareersConfig;

  naukri: NaukriConfig;
  cutshort: CutshortConfig;

  greenhouse: GreenhouseConfig;
  lever: LeverConfig;
  ashby: AshbyConfig;
}

/**
 * Sensible starting values for the newer sources. Only ids listed here get
 * defaults injected; older sources keep their module-level fallbacks.
 *
 * Feed URLs are the public ones named in the source tickets, so a minimal
 * `weworkremotely: { enabled: true }` block still works.
 */
export const SOURCE_DEFAULTS: Partial<Record<SourceId, SourceSettings>> = {
  wellfound: { limit: 100, categories: ["engineering", "product", "design"] },
  otta: { limit: 100 },
  workatastartup: { limit: 100 },
  himalayas: { limit: 100, remoteOnly: true },

  weworkremotely: {
    limit: 100,
    feedUrl: "https://weworkremotely.com/categories/remote-programming-jobs.rss",
  },
  remoteco: { limit: 100, feedUrl: "https://remote.co/remote-jobs/feed/" },
  jobspresso: { limit: 100, feedUrl: "https://jobspresso.co/?feed=job_feed" },
  tldr_jobs: { limit: 50, feedUrl: "https://tldr.tech/jobs/rss" },
  bytebytego: { limit: 50 },
  indiehackers: { limit: 50 },

  ai_jobs_net: { limit: 60 },
  climatebase: { limit: 60 },
  web3_career: { limit: 60 },
  devrel_careers: { limit: 60 },

  naukri: { limit: 100, categories: ["it-software", "engineering"] },
  cutshort: { limit: 60 },

  greenhouse: { limit: 50, companies: ["stripe", "airtable", "notion"] },
  lever: { limit: 50, companies: [] },
  ashby: { limit: 50, companies: [] },
};

const POSITIVE_INTEGER_KEYS = new Set(["limit", "pages", "enrichLimit", "siteQueries", "jobsLimit", "scanLimit"]);
const NON_NEGATIVE_NUMBER_KEYS = new Set(["salaryMin"]);
const STRING_ARRAY_KEYS = new Set(["feeds", "companies", "categories", "roles"]);
const BOOLEAN_KEYS = new Set(["remoteOnly", "enrich", "jobs", "variants", "sponsored", "hiringOnly"]);
const URL_KEYS = new Set(["feedUrl", "searchUrl", "url", "sitemapUrl"]);

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "");
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function fallBack(
  settings: SourceSettings,
  key: string,
  defaults: SourceSettings | undefined,
): void {
  const fallback = defaults?.[key];
  if (fallback === undefined) delete settings[key];
  else settings[key] = fallback;
}

/**
 * Merges defaults into a source block and validates the shared setting shapes.
 *
 * Invalid values warn and fall back to the default (or are removed so the
 * source module's own fallback applies). Extra, source-specific keys are kept
 * as-is so a source can add settings without touching this file.
 */
export function normalizeSourceSettings(
  sourceId: SourceId,
  settings: SourceSettings,
): { settings: SourceSettings; warnings: string[] } {
  const defaults = SOURCE_DEFAULTS[sourceId];
  const normalized: SourceSettings = { ...defaults, ...settings };
  const warnings: string[] = [];

  if (normalized.enabled !== undefined && typeof normalized.enabled !== "boolean") {
    warnings.push(`source "${sourceId}" enabled must be true or false — enabling it`);
    delete normalized.enabled;
  }

  for (const key of POSITIVE_INTEGER_KEYS) {
    if (normalized[key] === undefined) {
      if (defaults?.[key] !== undefined) normalized[key] = defaults[key];
      continue;
    }
    if (!isPositiveInteger(normalized[key])) {
      warnings.push(`source "${sourceId}" ${key} must be a positive integer — using the default`);
      fallBack(normalized, key, defaults);
    }
  }

  for (const key of NON_NEGATIVE_NUMBER_KEYS) {
    if (normalized[key] !== undefined && !isNonNegativeNumber(normalized[key])) {
      warnings.push(`source "${sourceId}" ${key} must be a non-negative number — using the default`);
      fallBack(normalized, key, defaults);
    }
  }

  for (const key of STRING_ARRAY_KEYS) {
    if (normalized[key] !== undefined && !isStringArray(normalized[key])) {
      warnings.push(`source "${sourceId}" ${key} must be a list of strings — using the default`);
      fallBack(normalized, key, defaults);
    }
  }

  for (const key of BOOLEAN_KEYS) {
    if (normalized[key] !== undefined && typeof normalized[key] !== "boolean") {
      warnings.push(`source "${sourceId}" ${key} must be true or false — using the default`);
      fallBack(normalized, key, defaults);
    }
  }

  for (const key of URL_KEYS) {
    if (normalized[key] !== undefined && !isHttpUrl(normalized[key])) {
      warnings.push(`source "${sourceId}" ${key} must be an http(s) URL — using the default`);
      fallBack(normalized, key, defaults);
    }
  }

  return { settings: normalized, warnings };
}
