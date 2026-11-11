import assert from "node:assert/strict";
import test from "node:test";
import { CircuitOpenError } from "./circuit-breaker.js";
import { HttpError } from "./http.js";
import {
  SOURCE_METRICS,
  classifySourceError,
  emitCollectionMetrics,
  emitMetric,
  emitSourceMetrics,
  measureSourceRun,
  setMetricSink,
  type MetricTags,
  type SourceRunTelemetry,
} from "./metrics.js";

interface Sample {
  name: string;
  value: number;
  tags: MetricTags;
}

function capture(): { samples: Sample[]; restore: () => void } {
  const samples: Sample[] = [];
  const restore = setMetricSink((name, value, tags) => {
    samples.push({ name, value, tags });
  });
  return { samples, restore };
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), {
    name: "AbortError",
  });
}

function successTelemetry(overrides: Partial<SourceRunTelemetry> = {}): SourceRunTelemetry {
  return {
    sourceId: "hn",
    runId: "run-1",
    durationMs: 12,
    jobsFound: 7,
    ok: true,
    ...overrides,
  };
}

test("classifySourceError maps transport failures to bounded error types", () => {
  const cases: Array<[unknown, string]> = [
    [new HttpError("https://x", 429, "HTTP 429", true), "rate_limited"],
    [new HttpError("https://x", 503, "HTTP 503", true), "http_5xx"],
    [new HttpError("https://x", 404, "HTTP 404", false), "http_4xx"],
    [new HttpError("https://x", 0, "fetch failed", true), "network"],
    [new HttpError("https://x", 0, "fetch failed", true, abortError()), "timeout"],
    [new CircuitOpenError(5000), "circuit_open"],
    [new SyntaxError("Unexpected token < in JSON"), "parse"],
    [abortError(), "timeout"],
    [new Error("boom"), "unknown"],
    ["not an error", "unknown"],
  ];

  for (const [error, expected] of cases) {
    assert.equal(classifySourceError(error), expected);
  }
});

test("successful runs emit jobs_found, success, and duration", () => {
  const { samples, restore } = capture();

  try {
    emitSourceMetrics(successTelemetry());
  } finally {
    restore();
  }

  const byName = new Map(samples.map((sample) => [sample.name, sample]));

  assert.equal(byName.get(SOURCE_METRICS.jobsFound)?.value, 7);
  assert.equal(byName.get(SOURCE_METRICS.success)?.value, 1);
  assert.equal(byName.get(SOURCE_METRICS.durationMs)?.value, 12);

  for (const sample of samples) {
    assert.equal(sample.tags.source_id, "hn");
    assert.equal(sample.tags.run_id, "run-1");
  }

  assert.equal(byName.get(SOURCE_METRICS.durationMs)?.tags.outcome, "success");
  assert.equal(samples.some((sample) => sample.name === SOURCE_METRICS.failure), false);
});

test("failed runs emit failure with error_type, never jobs_found", () => {
  const { samples, restore } = capture();

  try {
    emitSourceMetrics(
      successTelemetry({ ok: false, jobsFound: 0, errorType: "http_5xx" }),
    );
  } finally {
    restore();
  }

  const failure = samples.find((sample) => sample.name === SOURCE_METRICS.failure);
  assert.equal(failure?.value, 1);
  assert.equal(failure?.tags.error_type, "http_5xx");
  assert.equal(failure?.tags.source_id, "hn");
  assert.equal(failure?.tags.run_id, "run-1");

  assert.equal(
    samples.some((sample) => sample.name === SOURCE_METRICS.jobsFound),
    false,
  );
  assert.equal(
    samples.some((sample) => sample.name === SOURCE_METRICS.rateLimited),
    false,
  );
});

test("rate-limited runs also emit source.rate_limited", () => {
  const { samples, restore } = capture();

  try {
    emitSourceMetrics(
      successTelemetry({ ok: false, jobsFound: 0, errorType: "rate_limited" }),
    );
  } finally {
    restore();
  }

  const rateLimited = samples.find(
    (sample) => sample.name === SOURCE_METRICS.rateLimited,
  );
  assert.equal(rateLimited?.value, 1);
  assert.equal(rateLimited?.tags.error_type, "rate_limited");

  const duration = samples.find(
    (sample) => sample.name === SOURCE_METRICS.durationMs,
  );
  assert.equal(duration?.tags.outcome, "failure");
});

test("measureSourceRun records success without throwing", async () => {
  const { samples, restore } = capture();

  try {
    const { result, telemetry } = await measureSourceRun("hn", "run-2", async () => [
      "a",
      "b",
    ]);

    assert.equal(result.status, "fulfilled");
    assert.deepEqual(result.status === "fulfilled" ? result.value : [], ["a", "b"]);
    assert.equal(telemetry.sourceId, "hn");
    assert.equal(telemetry.runId, "run-2");
    assert.equal(telemetry.jobsFound, 2);
    assert.equal(telemetry.ok, true);
    assert.equal(telemetry.errorType, undefined);
  } finally {
    restore();
  }

  assert.ok(samples.some((sample) => sample.name === SOURCE_METRICS.success));
});

test("measureSourceRun captures a rejection and classifies it", async () => {
  const { samples, restore } = capture();

  try {
    const { result, telemetry } = await measureSourceRun("remoteok", "run-3", async () => {
      throw new HttpError("https://remoteok.com", 429, "HTTP 429", true);
    });

    assert.equal(result.status, "rejected");
    assert.equal(telemetry.ok, false);
    assert.equal(telemetry.jobsFound, 0);
    assert.equal(telemetry.errorType, "rate_limited");
  } finally {
    restore();
  }

  assert.ok(samples.some((sample) => sample.name === SOURCE_METRICS.failure));
  assert.ok(samples.some((sample) => sample.name === SOURCE_METRICS.rateLimited));
});

test("collection metrics summarise jobs, sources, and failures", () => {
  const { samples, restore } = capture();

  try {
    emitCollectionMetrics(
      "run-4",
      [
        successTelemetry({ sourceId: "hn", jobsFound: 5 }),
        successTelemetry({ sourceId: "yc", jobsFound: 3 }),
        successTelemetry({ sourceId: "unstop", ok: false, jobsFound: 0, errorType: "timeout" }),
      ],
      987,
    );
  } finally {
    restore();
  }

  const byName = new Map(samples.map((sample) => [sample.name, sample]));
  assert.equal(byName.get(SOURCE_METRICS.collectionJobsFound)?.value, 8);
  assert.equal(byName.get(SOURCE_METRICS.collectionSourcesTotal)?.value, 3);
  assert.equal(byName.get(SOURCE_METRICS.collectionSourcesFailed)?.value, 1);
  assert.equal(byName.get(SOURCE_METRICS.collectionDurationMs)?.value, 987);

  for (const sample of samples) {
    assert.equal(sample.tags.run_id, "run-4");
  }
});

test("a throwing sink never breaks metric emission", () => {
  const restore = setMetricSink(() => {
    throw new Error("sink exploded");
  });

  try {
    assert.doesNotThrow(() => emitMetric("source.success", 1, { source_id: "hn" }));
  } finally {
    restore();
  }
});
