/**
 * Source registry — discovers modules instead of importing them by hand.
 *
 * # Adding a source
 *
 * Drop one file into `src/sources/` (for example `newboard.ts`) that exports:
 *
 * ```ts
 * import type { SourceId, Startup } from "../types.js";
 * import type { BaseSourceConfig, SourceContext } from "./types.js";
 *
 * export const sourceId = "newboard" as const satisfies SourceId;
 *
 * export interface NewboardConfig extends BaseSourceConfig {
 *   limit?: number;
 * }
 *
 * export async function fetchNewboard(
 *   config: NewboardConfig = {},
 *   _context?: SourceContext,
 * ): Promise<Startup[]> {
 *   // fetch, parse, return Startup[] with `source: sourceId`
 * }
 * ```
 *
 * That is the whole registration step: `collectStartups` reads every module in
 * this directory and calls its `fetch{Name}`. Helpers (like `rss.ts`) are
 * ignored because they do not export `sourceId`; test files are never loaded.
 * Remember to add the new id to the `SourceId` union in `src/types.ts` and to
 * `config/sources.yaml` if it needs non-default settings.
 */

import { readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../lib/log.js";
import type { SourceId } from "../types.js";
import type { DiscoveredSource, SourceFetch } from "./types.js";

/** Source modules are TypeScript in dev and may be JS in a compiled checkout. */
const MODULE_EXTENSIONS = [".ts", ".js", ".mjs"] as const;

/** Non-source modules that live beside the sources. */
const SKIP_FILES = new Set(["index.ts", "registry.ts", "rss.ts", "types.ts"]);

function isSourceFile(name: string): boolean {
  if (name.endsWith(".d.ts")) return false;
  if (/\.test\.[cm]?[jt]s$/.test(name)) return false;
  if (SKIP_FILES.has(name)) return false;
  return MODULE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

type ModuleNamespace = Record<string, unknown>;

/**
 * Scans `directory` for source modules and loads them.
 *
 * A module is a source when it exports a non-empty string `sourceId` and at
 * least one exported `fetch{Name}` function. Modules that fail to load, omit
 * the fetch function, or duplicate an id are logged and skipped, so one bad
 * file cannot take down the whole run.
 */
export async function discoverSources(
  directory: string = import.meta.dirname,
): Promise<DiscoveredSource[]> {
  const files = readdirSync(directory)
    .filter(isSourceFile)
    .sort();

  const sources: DiscoveredSource[] = [];
  const seen = new Map<string, string>();

  for (const file of files) {
    const path = resolve(directory, file);
    let namespace: ModuleNamespace;

    try {
      namespace = (await import(pathToFileURL(path).href)) as ModuleNamespace;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`sources: could not load ${file} — ${message}`);
      continue;
    }

    const rawId = namespace.sourceId;
    if (typeof rawId !== "string" || rawId.trim() === "") {
      // A helper module (e.g. rss.ts) rather than a source.
      continue;
    }

    const id = rawId.trim();
    const fetchName = Object.entries(namespace).find(
      ([name, value]) => name.startsWith("fetch") && name.length > "fetch".length && typeof value === "function",
    )?.[0];

    if (!fetchName) {
      logger.warn(`sources: ${file} exports sourceId "${id}" but no fetch{Name} function — skipping`);
      continue;
    }

    const previous = seen.get(id);
    if (previous) {
      logger.warn(`sources: duplicate sourceId "${id}" in ${file} (already provided by ${previous}) — skipping`);
      continue;
    }

    seen.set(id, file);
    sources.push({
      id: id as SourceId,
      fetch: namespace[fetchName] as SourceFetch,
      file: basename(path),
    });
  }

  return sources;
}

let cachedRegistry: Promise<DiscoveredSource[]> | undefined;

/** Loads the registry once per process. */
export function loadSourceRegistry(): Promise<DiscoveredSource[]> {
  cachedRegistry ??= discoverSources();
  return cachedRegistry;
}

/** Clears the process cache. Exposed for tests. */
export function resetSourceRegistry(): void {
  cachedRegistry = undefined;
}

export interface SourceSettings {
  enabled?: boolean;
  [key: string]: unknown;
}

export interface SourceConfig {
  sources?: Record<string, SourceSettings | undefined>;
}

export interface PlannedSource {
  source: DiscoveredSource;
  settings: SourceSettings;
}

export interface SourcePlan {
  run: PlannedSource[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves config + registry into the set of sources to run.
 *
 * Unknown ids in `sources.yaml` or `only` produce warnings instead of throwing,
 * which keeps a typo from breaking a scheduled run. A source absent from the
 * config runs with defaults; `enabled: false` is the only opt-out.
 */
export function planSources(
  config: SourceConfig | undefined,
  sources: DiscoveredSource[],
  only?: Set<string>,
): SourcePlan {
  const warnings: string[] = [];
  const registered = new Map(sources.map((source) => [source.id as string, source]));

  const configured = config?.sources;
  if (configured !== undefined && !isRecord(configured)) {
    warnings.push("`sources` must be a mapping; ignoring the configured sources");
  }
  const settingsById = isRecord(configured) ? configured : {};

  for (const id of Object.keys(settingsById)) {
    if (!registered.has(id)) {
      warnings.push(`unknown source "${id}" in config — ignoring`);
    }
  }

  if (only) {
    for (const id of only) {
      if (!registered.has(id)) {
        warnings.push(`unknown source "${id}" in --source — ignoring`);
      }
    }
  }

  const run: PlannedSource[] = [];

  for (const source of sources) {
    if (only && !only.has(source.id)) continue;

    const rawSettings = settingsById[source.id];
    let settings: SourceSettings = {};

    if (rawSettings !== undefined) {
      if (isRecord(rawSettings)) {
        settings = rawSettings as SourceSettings;
      } else {
        warnings.push(`source "${source.id}" config must be a mapping — using defaults`);
      }
    }

    if (settings.enabled === false) continue;
    run.push({ source, settings });
  }

  return { run, warnings };
}
