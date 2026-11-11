import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { logger } from "../lib/log.js";
import {
  emitCollectionMetrics,
  measureSourceRun,
  type SourceRunTelemetry,
} from "../lib/metrics.js";
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
  emitCollectionMetrics(runId, runs, durationMs);
  const failed = runs.filter((source) => !source.ok).length;
  logger.info(
    `sources: ${runs.length - failed}/${runs.length} ok, ${all.length} startups in ${durationMs}ms (run ${runId})`,
  );

  return all;
}
