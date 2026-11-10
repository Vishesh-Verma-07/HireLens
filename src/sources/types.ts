import type { Profile, SourceId, Startup } from "../types.js";

/**
 * Everything a source may need that is not source-specific configuration.
 * Today that is the matcher profile (Google compiles queries from it); future
 * sources can ignore it.
 */
export interface SourceContext {
  profile: Profile;
}

/** Fields every `sources.yaml` entry supports. */
export interface BaseSourceConfig {
  enabled?: boolean;
}

/**
 * A discovered source module's fetch function.
 *
 * Modules declare their own richer config type; the registry passes the raw
 * `sources.yaml` mapping for that source, so implementations only need to read
 * the keys they care about.
 */
export type SourceFetch = (
  config: Record<string, unknown>,
  context: SourceContext,
) => Promise<Startup[]>;

/** One `src/sources/*.ts` module that exports `sourceId` + a `fetch{Name}`. */
export interface DiscoveredSource {
  id: SourceId;
  fetch: SourceFetch;
  /** Module filename, used for diagnostics. */
  file: string;
}
