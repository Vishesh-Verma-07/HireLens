/**
 * Source-health metrics.
 *
 * One collection run wraps every source call in {@link measureSourceRun}, which
 * times it, classifies any failure, and emits the metric set below. Samples go
 * to Vercel Custom Metrics through `metric()` from `@vercel/functions`; that
 * helper is a no-op outside a Vercel Function, so local and Docker/Render runs
 * do not need any configuration.
 *
 * For a log-based dashboard (Render, Docker, systemd) set `METRICS_LOG=1` to
 * also write one JSON line per sample. See `docs/observability.md`.
 *
 * Metric names are stable API. Add a new one here rather than at a call site.
 */

import { metric } from "@vercel/functions";
import { isCircuitOpenError } from "./circuit-breaker.js";
import { HttpError } from "./http.js";
import { logger } from "./log.js";

export const SOURCE_METRICS = {
  /** Jobs returned by one source run. Summed. */
  jobsFound: "source.jobs_found",
  /** Wall-clock duration of one source run, in milliseconds. */
  durationMs: "source.duration_ms",
  /** One successful source run. */
  success: "source.success",
  /** One failed source run, tagged with `error_type`. */
  failure: "source.failure",
  /** One source run that gave up because of HTTP 429. */
  rateLimited: "source.rate_limited",
  /** Jobs collected by the whole run. */
  collectionJobsFound: "collection.jobs_found",
  /** Sources attempted in the whole run. */
  collectionSourcesTotal: "collection.sources_total",
  /** Sources that failed in the whole run. */
  collectionSourcesFailed: "collection.sources_failed",
  /** Records folded into another record by cross-source dedupe. */
  collectionDuplicatesRemoved: "collection.duplicates_removed",
  /** Wall-clock duration of the whole collection, in milliseconds. */
  collectionDurationMs: "collection.duration_ms",
} as const;

export type MetricTags = Record<string, string>;

/** Receives one numeric sample. Must not throw; `emitMetric` guards anyway. */
export type MetricSink = (name: string, value: number, tags: MetricTags) => void;

function logSink(name: string, value: number, tags: MetricTags): void {
  // One JSON object per line: easy to parse from a log drain.
  logger.info(`metric ${JSON.stringify({ name, value, tags })}`);
}

const defaultSink: MetricSink = (name, value, tags) => {
  try {
    metric(name, value, tags);
  } catch (error) {
    // Observability must never take down a collection run.
    logger.debug(`metrics: metric() failed for ${name}: ${String(error)}`);
  }

  if (process.env.METRICS_LOG === "1" || process.env.METRICS_LOG === "true") {
    logSink(name, value, tags);
  }
};

let sink: MetricSink = defaultSink;

/** Emits one sample through the active sink. Swallows sink failures. */
export function emitMetric(name: string, value: number, tags: MetricTags = {}): void {
  try {
    sink(name, value, tags);
  } catch (error) {
    logger.debug(`metrics: sink failed for ${name}: ${String(error)}`);
  }
}

/**
 * Replaces the sink (tests, or an alternative backend). Returns a restore
 * function so a test cannot leak its sink into later cases.
 */
export function setMetricSink(next: MetricSink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

/** Why a source run failed. Kept low-cardinality for grouping. */
export type SourceErrorType =
  | "rate_limited"
  | "timeout"
  | "network"
  | "http_4xx"
  | "http_5xx"
  | "circuit_open"
  | "parse"
  | "unknown";

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function isAbortCause(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (isAbortError(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Maps an arbitrary source error onto a bounded `error_type` value. */
export function classifySourceError(error: unknown): SourceErrorType {
  if (isCircuitOpenError(error)) return "circuit_open";

  if (error instanceof HttpError) {
    if (error.status === 429) return "rate_limited";
    if (error.status >= 500) return "http_5xx";
    if (error.status >= 400) return "http_4xx";
    // Status 0 is a network/timeout failure from the shared HTTP client.
    return isAbortCause(error) ? "timeout" : "network";
  }

  if (error instanceof SyntaxError) return "parse";
  if (isAbortError(error)) return "timeout";
  return "unknown";
}

/** What one source call did, independent of whether it threw. */
export interface SourceRunTelemetry {
  sourceId: string;
  runId: string;
  durationMs: number;
  jobsFound: number;
  ok: boolean;
  errorType?: SourceErrorType;
}

/** Emits the per-source sample set for one finished run. */
export function emitSourceMetrics(telemetry: SourceRunTelemetry): void {
  const baseTags: MetricTags = {
    source_id: telemetry.sourceId,
    run_id: telemetry.runId,
  };

  if (telemetry.ok) {
    emitMetric(SOURCE_METRICS.jobsFound, telemetry.jobsFound, baseTags);
    emitMetric(SOURCE_METRICS.success, 1, baseTags);
    emitMetric(SOURCE_METRICS.durationMs, telemetry.durationMs, {
      ...baseTags,
      outcome: "success",
    });
    return;
  }

  const errorType = telemetry.errorType ?? "unknown";
  const failureTags: MetricTags = { ...baseTags, error_type: errorType };
  emitMetric(SOURCE_METRICS.failure, 1, failureTags);
  emitMetric(SOURCE_METRICS.durationMs, telemetry.durationMs, {
    ...failureTags,
    outcome: "failure",
  });

  if (errorType === "rate_limited") {
    emitMetric(SOURCE_METRICS.rateLimited, 1, failureTags);
  }
}

/**
 * Runs a source, captures success/failure without throwing, and emits metrics.
 *
 * The returned `PromiseSettledResult` preserves `collectStartups`'s isolation
 * semantics: one rejection never stops the other sources.
 */
export async function measureSourceRun<T>(
  sourceId: string,
  runId: string,
  run: () => Promise<T[]>,
): Promise<{ result: PromiseSettledResult<T[]>; telemetry: SourceRunTelemetry }> {
  const startedAt = performance.now();
  let result: PromiseSettledResult<T[]>;

  try {
    result = { status: "fulfilled", value: await run() };
  } catch (error) {
    result = { status: "rejected", reason: error };
  }

  const durationMs = Math.round(performance.now() - startedAt);
  const telemetry: SourceRunTelemetry = {
    sourceId,
    runId,
    durationMs,
    jobsFound: result.status === "fulfilled" ? result.value.length : 0,
    ok: result.status === "fulfilled",
    ...(result.status === "rejected"
      ? { errorType: classifySourceError(result.reason) }
      : {}),
  };

  emitSourceMetrics(telemetry);
  return { result, telemetry };
}

/** Emits one summary sample set for a whole collection run. */
export function emitCollectionMetrics(
  runId: string,
  telemetry: SourceRunTelemetry[],
  durationMs: number,
  duplicatesRemoved = 0,
): void {
  const tags: MetricTags = { run_id: runId };
  const jobsFound = telemetry.reduce((total, source) => total + source.jobsFound, 0);
  const failed = telemetry.filter((source) => !source.ok).length;

  emitMetric(SOURCE_METRICS.collectionJobsFound, jobsFound, tags);
  emitMetric(SOURCE_METRICS.collectionSourcesTotal, telemetry.length, tags);
  emitMetric(SOURCE_METRICS.collectionSourcesFailed, failed, tags);
  emitMetric(SOURCE_METRICS.collectionDuplicatesRemoved, duplicatesRemoved, tags);
  emitMetric(SOURCE_METRICS.collectionDurationMs, durationMs, tags);
}
