import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { logger } from "../lib/log.js";
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

export interface CollectOptions {
  /** Only run these sources, if set. */
  only?: Set<string>;
  /** The matcher profile; Google compiles its query from this. */
  profile: Profile;
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
 */
export async function collectStartups(
  config: SourceConfig,
  opts: CollectOptions,
  registry?: DiscoveredSource[],
): Promise<Startup[]> {
  const sources = registry ?? (await loadSourceRegistry());
  if (sources.length === 0) {
    logger.warn("sources: no source modules discovered");
    return [];
  }

  const { run, warnings } = planSources(config, sources, opts.only);
  for (const warning of warnings) logger.warn(`sources: ${warning}`);

  if (run.length === 0) {
    logger.warn("sources: no sources selected");
    return [];
  }

  const settled = await Promise.allSettled(
    run.map(({ source, settings }) =>
      source.fetch(settings, { profile: opts.profile }),
    ),
  );

  const all: Startup[] = [];

  settled.forEach((result, i) => {
    const label = run[i]?.source.id ?? `source${i}`;
    if (result.status === "fulfilled") {
      logger.info(`${label}: ${result.value.length} startups`);
      all.push(...result.value);
    } else {
      logger.warn(`${label}: failed — ${result.reason?.message ?? result.reason}`);
    }
  });

  return all;
}
