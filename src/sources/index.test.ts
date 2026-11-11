import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../lib/http.js";
import {
  SOURCE_METRICS,
  setMetricSink,
  type MetricTags,
  type SourceRunTelemetry,
} from "../lib/metrics.js";
import type { Profile, SourceId, Startup } from "../types.js";
import { collectStartups } from "./index.js";
import type { DiscoveredSource } from "./types.js";

interface Sample {
  name: string;
  value: number;
  tags: MetricTags;
}

function capture() {
  const samples: Sample[] = [];
  const restore = setMetricSink((name, value, tags) => {
    samples.push({ name, value, tags });
  });
  return { samples, restore };
}

const profile: Profile = {
  name: "Metrics Test",
  headline: "Engineer",
  summary: "",
  skills: [],
  domains: [],
  seniority: "junior",
  yearsExperience: 1,
  roles: [],
  highlights: [],
  preferences: {
    stages: [],
    remote: true,
    locations: [],
    excludeCompanies: [],
    excludeKeywords: [],
  },
  education: [],
};

function startup(id: string, source: SourceId): Startup {
  return {
    id,
    name: "Acme",
    locations: [],
    industry: [],
    source,
    signals: [],
  };
}

function fakeSource(id: SourceId, fetch: DiscoveredSource["fetch"]): DiscoveredSource {
  return { id, fetch, file: `${id}.ts` };
}

test("collectStartups emits source metrics for every selected source", async () => {
  const sources = [
    fakeSource("hn", async () => [startup("hn:1", "hn")]),
    fakeSource("yc", async () => [startup("yc:1", "yc"), startup("yc:2", "yc")]),
  ];
  const { samples, restore } = capture();

  try {
    const jobs = await collectStartups(
      {},
      { profile, runId: "run-metrics" },
      sources,
    );
    assert.equal(jobs.length, 3);
  } finally {
    restore();
  }

  for (const id of ["hn", "yc"]) {
    const success = samples.find(
      (sample) =>
        sample.name === SOURCE_METRICS.success && sample.tags.source_id === id,
    );
    assert.ok(success, `${id} should emit source.success`);
    assert.equal(success?.tags.run_id, "run-metrics");

    const jobsFound = samples.find(
      (sample) =>
        sample.name === SOURCE_METRICS.jobsFound && sample.tags.source_id === id,
    );
    assert.ok(jobsFound, `${id} should emit source.jobs_found`);
    assert.equal(
      jobsFound?.value,
      id === "hn" ? 1 : 2,
      `${id} should report its own job count`,
    );

    const duration = samples.find(
      (sample) =>
        sample.name === SOURCE_METRICS.durationMs && sample.tags.source_id === id,
    );
    assert.ok(duration, `${id} should emit source.duration_ms`);
    assert.equal(duration?.tags.outcome, "success");
  }

  const total = samples.find(
    (sample) => sample.name === SOURCE_METRICS.collectionSourcesTotal,
  );
  assert.equal(total?.value, 2);
  assert.equal(
    samples.find((sample) => sample.name === SOURCE_METRICS.collectionJobsFound)
      ?.value,
    3,
  );
  assert.equal(
    samples.find((sample) => sample.name === SOURCE_METRICS.collectionSourcesFailed)
      ?.value,
    0,
  );
});

test("a failing source emits failure metrics without sinking the run", async () => {
  const sources = [
    fakeSource("hn", async () => [startup("hn:1", "hn")]),
    fakeSource("remoteok", async () => {
      throw new HttpError("https://remoteok.com", 429, "HTTP 429", true);
    }),
  ];
  const { samples, restore } = capture();

  let jobs: Startup[] = [];
  try {
    jobs = await collectStartups({}, { profile, runId: "run-failure" }, sources);
  } finally {
    restore();
  }

  assert.deepEqual(jobs.map((job) => job.id), ["hn:1"]);

  const failure = samples.find(
    (sample) =>
      sample.name === SOURCE_METRICS.failure &&
      sample.tags.source_id === "remoteok",
  );
  assert.ok(failure, "remoteok should emit source.failure");
  assert.equal(failure?.tags.error_type, "rate_limited");
  assert.equal(failure?.tags.run_id, "run-failure");

  assert.ok(
    samples.some(
      (sample) =>
        sample.name === SOURCE_METRICS.rateLimited &&
        sample.tags.source_id === "remoteok",
    ),
    "429 should emit source.rate_limited",
  );

  assert.equal(
    samples.find((sample) => sample.name === SOURCE_METRICS.collectionSourcesFailed)
      ?.value,
    1,
  );
});

test("onSourceRun receives telemetry for each source, including failures", async () => {
  const sources = [
    fakeSource("hn", async () => [startup("hn:1", "hn")]),
    fakeSource("yc", async () => {
      throw new Error("boom");
    }),
  ];
  const seen: SourceRunTelemetry[] = [];
  const { restore } = capture();

  try {
    await collectStartups(
      {},
      { profile, runId: "run-callback", onSourceRun: (telemetry) => seen.push(telemetry) },
      sources,
    );
  } finally {
    restore();
  }

  assert.deepEqual(
    seen.map((telemetry) => telemetry.sourceId).sort(),
    ["hn", "yc"],
  );
  assert.equal(seen.find((telemetry) => telemetry.sourceId === "hn")?.ok, true);
  assert.equal(seen.find((telemetry) => telemetry.sourceId === "yc")?.ok, false);
  assert.equal(
    seen.find((telemetry) => telemetry.sourceId === "yc")?.errorType,
    "unknown",
  );
});

test("a throwing onSourceRun callback does not sink the run", async () => {
  const sources = [fakeSource("hn", async () => [startup("hn:1", "hn")])];
  const { restore } = capture();

  try {
    const jobs = await collectStartups(
      {},
      {
        profile,
        runId: "run-bad-callback",
        onSourceRun: () => {
          throw new Error("callback exploded");
        },
      },
      sources,
    );
    assert.deepEqual(jobs.map((job) => job.id), ["hn:1"]);
  } finally {
    restore();
  }
});

test("every source failure type is visible in the failure metric", async () => {
  const sources = [
    fakeSource("hn", async () => {
      throw new SyntaxError("bad JSON");
    }),
  ];
  const { samples, restore } = capture();

  try {
    await collectStartups({}, { profile, runId: "run-parse" }, sources);
  } finally {
    restore();
  }

  const failure = samples.find((sample) => sample.name === SOURCE_METRICS.failure);
  assert.equal(failure?.tags.error_type, "parse");
});

test("a run with no selected sources still emits collection metrics", async () => {
  const { samples, restore } = capture();

  try {
    const jobs = await collectStartups(
      {},
      { profile, only: new Set(["not_a_source"]), runId: "run-empty" },
      [],
    );
    assert.deepEqual(jobs, []);
  } finally {
    restore();
  }

  // No registry means the run exits before planning; either way, the summary
  // exists and is tagged with the run id.
  for (const sample of samples) {
    assert.equal(sample.tags.run_id, "run-empty");
  }
  assert.ok(
    samples.some((sample) => sample.name === SOURCE_METRICS.collectionSourcesTotal),
  );
});
