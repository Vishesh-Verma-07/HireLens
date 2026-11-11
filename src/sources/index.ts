import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { dedupeStartups, seenKey } from "../lib/dedupe.js";
import { logger } from "../lib/log.js";
import {
  emitCollectionMetrics,
  measureSourceRun,
  type SourceRunTelemetry,
} from "../lib/metrics.js";
import {
  isSeen,
  loadStore,
  markSeen,
  pruneSeen,
  saveStore,
  SEEN_TTL_DAYS,
} from "../store/db.js";
import type { Profile, Startup } from "../types.js";
import {
  loadSourceRegistry,
  planSources,
  type SourceConfig,
} from "./registry.js";
import type { DiscoveredSource } from "./types.js";

export { discoverSources, loadSourceRegistry, planSources, resetSourceRegistry } from "./registry.js";
export type { SourceConfig, SourceSettings } from "./registry.js";
export { normalizeSourceSettings, SOURCE_DEFAULTS } from "./config.js";
export type {
  AiJobsNetConfig,
  AshbyConfig,
  ByteByteGoConfig,
  ClimatebaseConfig,
  CompanyAggregatorConfig,
  CutshortConfig,
  DevRelCareersConfig,
  FeedSourceConfig,
  GreenhouseConfig,
  HimalayasConfig,
  IndieHackersConfig,
  JobspressoConfig,
  LeverConfig,
  LimitedSourceConfig,
  NaukriConfig,
  OttaConfig,
  RemoteCoConfig,
  SourceSettingsMap,
  TldrJobsConfig,
  Web3CareerConfig,
  WellfoundConfig,
  WeWorkRemotelyConfig,
  WorkAtAStartupConfig,
} from "./config.js";
export type {
  BaseSourceConfig,
  DiscoveredSource,
  SourceContext,
  SourceFetch,
} from "./types.js";

export type { SourceErrorType, SourceRunTelemetry } from "../lib/metrics.js";

export interface CollectOptions {
  /** Only run these sources, if set. */
  only?: Set<string>;
  /** The matcher profile; Google compiles its query from this. */
  profile: Profile;
  /** Correlates every metric sample from one collection. Generated when omitted. */
  runId?: string;
  /** Called once per source after it settles. Errors here never sink the run. */
  onSourceRun?: (telemetry: SourceRunTelemetry) => void;
  /**
   * Path to `data/store.json`. When set, ids seen within `seenTtlDays` are
   * filtered out of the result and the ids returned by this run are recorded
   * there, which is what makes a second run on the same day a no-op.
   */
  storePath?: string;
  /** How long a seen id suppresses a role. Defaults to 30 days. */
  seenTtlDays?: number;
  /** Clock override, for deterministic TTL tests. */
  now?: () => Date;
}

export function loadSourceConfig(path: string): SourceConfig {
  const parsed = parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`sources config at ${path} must be a YAML mapping`);
  }
  return parsed as SourceConfig;
}

/**
 * Runs every registered, enabled source in parallel; one failing source never
 * sinks the run. Registry entries come from `src/sources/*.ts`, so adding a
 * source does not require editing this file.
 *
 * Each call is wrapped in `measureSourceRun`, which emits `source.*` metrics
 * (jobs found, duration, success/failure, rate limits) and `collection.*`
 * summaries tagged with `source_id`, `run_id`, and `error_type`.
 */
export async function collectStartups(
  config: SourceConfig,
  opts: CollectOptions,
  registry?: DiscoveredSource[],
): Promise<Startup[]> {
  const startedAt = performance.now();
  const runId = opts.runId ?? randomUUID();
  const sources = registry ?? (await loadSourceRegistry());
  if (sources.length === 0) {
    logger.warn("sources: no source modules discovered");
    emitCollectionMetrics(runId, [], Math.round(performance.now() - startedAt));
    return [];
  }

  const { run, warnings } = planSources(config, sources, opts.only);
  for (const warning of warnings) logger.warn(`sources: ${warning}`);

  if (run.length === 0) {
    logger.warn("sources: no sources selected");
    emitCollectionMetrics(runId, [], Math.round(performance.now() - startedAt));
    return [];
  }
  const outcomes = await Promise.all(
    run.map(({ source, settings }) =>
      measureSourceRun(source.id, runId, () =>
        source.fetch(settings, { profile: opts.profile }),
      ),
    ),
  );

  const all: Startup[] = [];
  const runs: SourceRunTelemetry[] = [];

  for (const { result, telemetry } of outcomes) {
    runs.push(telemetry);

    try {
      opts.onSourceRun?.(telemetry);
    } catch (error) {
      logger.debug(`sources: onSourceRun failed for ${telemetry.sourceId}: ${String(error)}`);
    }

    if (result.status === "fulfilled") {
      logger.info(`${telemetry.sourceId}: ${result.value.length} startups in ${telemetry.durationMs}ms`);
      all.push(...result.value);
    } else {
      logger.warn(
        `${telemetry.sourceId}: failed [${telemetry.errorType}] in ${telemetry.durationMs}ms — ${result.reason?.message ?? result.reason}`,
      );
    }
  }

  const durationMs = Math.round(performance.now() - startedAt);
  const { startups: deduped, removed } = dedupeStartups(all);
  const dedupedStartups = applySeenFilter(deduped, opts);
  emitCollectionMetrics(runId, runs, durationMs, removed);

  const failed = runs.filter((source) => !source.ok).length;
  logger.info(
    `sources: ${runs.length - failed}/${runs.length} ok, ${all.length} startups` +
      `${removed > 0 ? ` → ${deduped.length} after dedupe` : ""}` +
      `${dedupedStartups.length < deduped.length ? ` → ${dedupedStartups.length} new` : ""}` +
      ` in ${durationMs}ms (run ${runId})`,
  );

  return dedupedStartups;
}

/**
 * Cross-run dedupe. Loads the seen-store, drops expired entries, removes roles
 * seen within the TTL, then records everything this run returns. Recording all
 * returned ids (not just the digest slice) is what makes a second run on the
 * same day return nothing new.
 */
function applySeenFilter(startups: Startup[], opts: CollectOptions): Startup[] {
  if (!opts.storePath) return startups;

  const ttlDays = opts.seenTtlDays ?? SEEN_TTL_DAYS;
  const now = opts.now?.() ?? new Date();
  const nowMs = now.getTime();
  const store = loadStore(opts.storePath);

  const pruned = pruneSeen(store, ttlDays, nowMs);
  if (pruned > 0) logger.debug(`store: pruned ${pruned} expired seen ids`);

  const fresh = startups.filter((startup) => {
    const keys = [startup.id, seenKey(startup)].filter(Boolean);
    return !keys.some((key) => isSeen(store, key, ttlDays, nowMs));
  });

  const keys: string[] = [];
  for (const startup of fresh) {
    keys.push(startup.id, seenKey(startup));
  }
  markSeen(store, keys.filter(Boolean), now);
  saveStore(opts.storePath, store);

  return fresh;
}
