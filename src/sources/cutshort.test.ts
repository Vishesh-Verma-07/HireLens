import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { isTechRole } from "../lib/text.js";
import type { Profile } from "../types.js";
import type { Fixture, FixtureResponse } from "../../test/fixtures.js";
import { assertValidStartups } from "../../test/contract.js";
import { loadFixture, withFixtureFetch } from "../../test/fixtures.js";
import { fetchCutshort } from "./cutshort.js";
import {
  collectStartups,
  discoverSources,
  loadSourceConfig,
  planSources,
  type SourceConfig,
} from "./index.js";

const CONFIG_PATH = resolve(import.meta.dirname, "../../config/sources.yaml");

const profile: Profile = {
  name: "Test Person",
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

/** The ten newest technical postings in the recorded listing, newest first. */
const EXPECTED_IDS = [
  "cutshort:6af43a582314d4816995b734",
  "cutshort:6af43a2d71fdf46a78cb5e2d",
  "cutshort:6af4382acdbce28139083fbe",
  "cutshort:6af42a0ecdbce28139efbabd",
  "cutshort:6af426c3ec51908eb9ecbaac",
  "cutshort:6af421618ba69179a5b1bfee",
  "cutshort:6af41ed9d3d446b2e9e64ec1",
  "cutshort:6af416ba2314d48169ee48eb",
  "cutshort:6af412c3f1a6477c57dcd7bd",
  "cutshort:6af4119735d2a412656f0828",
];

/**
 * Postings from the recorded pages whose titles are clearly not technical.
 * They must never reach the batch, even though the listing mixes them in.
 */
const NON_TECH_IDS = [
  "cutshort:6ae07b0e3c24cf8626be57d9", // B2B Sales Partner – Digital Marketing
  "cutshort:6af32ebc98cb9cb7eac99ab4", // Tour Operator
  "cutshort:6af32aab69860d2862d58349", // Performance Marketer
  "cutshort:6af30cb8de67ab1e01e5e6f7", // Customer Success Manager
  "cutshort:6af2c8edd514533304ad74bf", // Sales and Marketing Internship
];

function fixture(responses: FixtureResponse[]): Fixture {
  return { source: "cutshort", recordedAt: "2026-11-12T00:00:00Z", responses };
}

/** Runs `run` with `fetch` replaced by a stub that fails on any request. */
async function withBlockedFetch<T>(
  run: () => Promise<T>,
): Promise<{ result: T; calls: number }> {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("unexpected network call");
  }) as typeof fetch;

  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("cutshort: recorded fixture parses into valid Startups", async () => {
  const startups = await withFixtureFetch("cutshort", () =>
    fetchCutshort({ limit: 10 }),
  );

  assert.ok(startups.length > 0, "fixture should contain at least one tech role");
  assertValidStartups(startups, "cutshort");

  for (const startup of startups) {
    assert.match(startup.id, /^cutshort:[a-f0-9]{24}$/);
    assert.equal(startup.source, "cutshort");
    assert.equal(startup.signals[0]?.type, "hiring");
    assert.match(startup.signals[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(isTechRole(startup.oneLiner ?? ""), `${startup.oneLiner} should be technical`);
    assert.ok(startup.locations.includes("India"), "the India board always keeps its country");
    assert.match(startup.url ?? "", /^https:\/\/cutshort\.io\/job\//);
    assert.equal(startup.industry.length, 0, "the listing has no industry taxonomy");
  }
});

test("cutshort: maps company, location, salary, experience and remote metadata", async () => {
  const startups = await withFixtureFetch("cutshort", () =>
    fetchCutshort({ limit: 60 }),
  );

  const mern = startups.find((startup) => startup.id === EXPECTED_IDS[0]);
  assert.ok(mern, "the newest posting should be kept");
  assert.equal(mern.name, "Euphoric Thought Technologies");
  assert.equal(mern.oneLiner, "MERN Developer (Contract Base Immediate joiner )");
  assert.deepEqual(mern.locations, ["Bengaluru (Bangalore)", "Noida", "India"]);
  assert.equal(mern.remote, undefined, "remote_not_okay stays on-site");
  assert.equal(mern.employees, "20-100");
  assert.equal(mern.companyDomain, "euphoricthought.com");
  assert.equal(
    mern.url,
    "https://cutshort.io/job/MERN-Developer-Contract-Base-Immediate-joiner-Bengaluru-Bangalore-Noida-Euphoric-Thought-Technologies-IGxTMLzy",
  );
  assert.equal(mern.signals[0]?.date, "2026-11-11T09:50:16.814Z");
  assert.match(mern.description ?? "", /Compensation: ₹8L - ₹12L \/ yr/);
  assert.match(mern.description ?? "", /Experience: 3 - 5 years/);
  assert.match(mern.description ?? "", /Skills: NodeJS \(Node\.js\), React\.js, MongoDB/);
  assert.ok((mern.description ?? "").length <= 4000);

  const cloud = startups.find((startup) => startup.id === EXPECTED_IDS[5]);
  assert.ok(cloud, "the remote-only posting should be kept");
  assert.equal(cloud.oneLiner, "Cloud Engineer");
  assert.equal(cloud.remote, true, 'remoteType "remote_only" maps to remote: true');
  assert.deepEqual(cloud.locations, ["Remote", "India"]);
  assert.equal(cloud.signals[0]?.text, "Improving — Cloud Engineer (Remote)");
});

test("cutshort: drops non-technical postings and de-duplicates overlapping pages", async () => {
  const startups = await withFixtureFetch("cutshort", () =>
    fetchCutshort({ limit: 60 }),
  );

  const ids = startups.map((startup) => startup.id);
  for (const nonTech of NON_TECH_IDS) {
    assert.ok(!ids.includes(nonTech), `${nonTech} is not a technical role`);
  }

  assert.equal(new Set(ids).size, ids.length, "a reposted job must appear once");
  assert.ok(startups.length <= 60, "the listing cap is respected");
  assert.ok(startups.length > 0);
});

test("cutshort: respects the limit and keeps the newest postings", async () => {
  const startups = await withFixtureFetch("cutshort", () =>
    fetchCutshort({ limit: 5 }),
  );

  assert.equal(startups.length, 5);
  assertValidStartups(startups, "cutshort");
  assert.deepEqual(
    startups.map((startup) => startup.id),
    EXPECTED_IDS.slice(0, 5),
  );

  const dates = startups.map((startup) => Date.parse(startup.signals[0]?.date ?? ""));
  assert.deepEqual(
    dates,
    [...dates].sort((left, right) => right - left),
    "postings should be ordered newest first",
  );
});

test("cutshort: a non-positive limit skips the network entirely", async () => {
  // No fixture replay: a network call here would fail loudly.
  const { result, calls } = await withBlockedFetch(() => fetchCutshort({ limit: 0 }));

  assert.deepEqual(result, []);
  assert.equal(calls, 0);
});

test("cutshort: a failed page does not sink the source", async () => {
  const recorded = loadFixture("cutshort");
  const [first, ...rest] = recorded.responses;
  assert.ok(first && rest.length > 0, "fixture should hold several listing pages");

  // Page 1 is a deterministic 404; pages 2 and 3 still contribute.
  const broken: Fixture = fixture([
    {
      url: first.url,
      status: 404,
      headers: { "content-type": "application/json" },
      body: { success: false },
    },
    ...rest,
  ]);

  const startups = await withFixtureFetch(
    "cutshort",
    () => fetchCutshort({ limit: 60 }),
    broken,
  );

  assert.ok(startups.length > 0, "later pages should still return jobs");
  assertValidStartups(startups, "cutshort");
  assert.ok(
    !startups.some((startup) => startup.id === EXPECTED_IDS[0]),
    "the page-1 job is gone, but the rest of the batch survives",
  );
});

test("cutshort: disabled by default in sources.yaml, enabled through an override", async () => {
  const sources = await discoverSources();
  const discovered = sources.filter((source) => source.id === "cutshort");

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.file, "cutshort.ts");

  const fileConfig = loadSourceConfig(CONFIG_PATH);
  assert.equal(fileConfig.sources?.cutshort?.enabled, false, "the board is opt-in");
  assert.equal(
    planSources(fileConfig, discovered).run.some((entry) => entry.source.id === "cutshort"),
    false,
    "the shipped config keeps Cutshort off",
  );
  assert.ok(
    !planSources(fileConfig, sources).warnings.some((warning) =>
      warning.includes('"cutshort"'),
    ),
    "cutshort is implemented, so it must not warn",
  );

  const disabled: SourceConfig = { sources: { cutshort: { enabled: false } } };
  assert.equal(planSources(disabled, discovered).run.length, 0);

  const enabled: SourceConfig = { sources: { cutshort: { enabled: true } } };
  const planned = planSources(enabled, discovered);

  assert.equal(planned.run[0]?.source.id, "cutshort");
  assert.equal(planned.run[0]?.settings.enabled, true);
  assert.equal(planned.run[0]?.settings.limit, 60, "the shared default limit applies");

  const startups = await withFixtureFetch("cutshort", () =>
    collectStartups(
      enabled,
      { only: new Set(["cutshort"]), profile, runId: "cutshort-test" },
      discovered,
    ),
  );

  assert.ok(startups.length > 0, "the collection run should return Cutshort jobs");
  assertValidStartups(startups, "cutshort");
  assert.ok(startups.every((startup) => startup.source === "cutshort"));
});
