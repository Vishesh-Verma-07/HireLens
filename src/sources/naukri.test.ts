import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { isTechRole } from "../lib/text.js";
import type { Profile } from "../types.js";
import type { Fixture, FixtureResponse } from "../../test/fixtures.js";
import { assertValidStartups } from "../../test/contract.js";
import { loadFixture, withFixtureFetch } from "../../test/fixtures.js";
import { fetchNaukri, postedAtFromId } from "./naukri.js";
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

/** The five newest technical postings in the recorded sitemap, newest first. */
const EXPECTED_IDS = [
  "naukri:051126036839",
  "naukri:051126027088",
  "naukri:051126026829",
  "naukri:051126014762",
  "naukri:051126012476",
];

/**
 * Postings from the recorded sitemap whose titles are clearly not technical.
 * The sitemap mixes every job family, so these must never reach the batch.
 */
const NON_TECH_IDS = [
  "naukri:021126014797", // IT Support Engineer
  "naukri:261026006876", // Desktop Support Engineer
  "naukri:081026013069", // IT Support Engineer
  "naukri:131026036854", // Marketing Engineer
  "naukri:301026027516", // Salesforce Support Engineer
];

function fixture(responses: FixtureResponse[]): Fixture {
  return { source: "naukri", recordedAt: "2026-11-12T00:00:00Z", responses };
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

test("naukri: recorded sitemap parses into valid Startups", async () => {
  const startups = await withFixtureFetch("naukri", () =>
    fetchNaukri({ limit: 10 }),
  );

  assert.ok(startups.length > 0, "fixture should contain at least one tech role");
  assertValidStartups(startups, "naukri");

  for (const startup of startups) {
    assert.match(startup.id, /^naukri:\d{10,12}$/);
    assert.equal(startup.source, "naukri");
    assert.equal(startup.signals[0]?.type, "hiring");
    assert.match(startup.signals[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(
      isTechRole(startup.oneLiner ?? ""),
      `${startup.oneLiner} should be technical`,
    );
    assert.ok(startup.locations.length > 0, "every posting carries a location");
    assert.match(startup.url ?? "", /^https:\/\/www\.naukri\.com\/job-listings-/);
    assert.equal(startup.industry.length, 0, "the sitemap has no industry taxonomy");
  }
});

test("naukri: maps company, title, locations and experience from the slug", async () => {
  const startups = await withFixtureFetch("naukri", () =>
    fetchNaukri({ limit: 500 }),
  );

  const java = startups.find((startup) => startup.id === EXPECTED_IDS[0]);
  assert.ok(java, "the newest posting should be kept");
  assert.equal(java.name, "Q3 Technologies");
  assert.equal(java.oneLiner, "Senior Java Developer");
  assert.deepEqual(java.locations, ["Bangalore", "Bengaluru"]);
  assert.equal(
    java.url,
    "https://www.naukri.com/job-listings-senior-java-developer-q3-technologies-bangalore-rural-bengaluru-5-to-7-years-051126036839",
  );
  assert.equal(java.signals[0]?.date, "2026-11-05T00:00:00.000Z");
  assert.equal(java.signals[0]?.text, "Q3 Technologies - Senior Java Developer");
  assert.match(java.description ?? "", /Experience: 5-7 years/);
  assert.match(java.description ?? "", /Location: Bangalore, Bengaluru/);

  const mechanical = startups.find((startup) => startup.id === "naukri:041126011957");
  assert.ok(mechanical, "the engineering category keeps this role");
  assert.equal(mechanical.name, "Tekskills");
  assert.equal(mechanical.oneLiner, "Mechanical Design Engineer");
});

test("naukri: drops non-technical postings", async () => {
  const startups = await withFixtureFetch("naukri", () =>
    fetchNaukri({ limit: 500 }),
  );

  const ids = new Set(startups.map((startup) => startup.id));
  for (const nonTech of NON_TECH_IDS) {
    assert.ok(!ids.has(nonTech), `${nonTech} is not a technical role`);
  }
  assert.equal(ids.size, startups.length, "a posting must appear once");
});

test("naukri: respects the limit and keeps the newest postings", async () => {
  const startups = await withFixtureFetch("naukri", () =>
    fetchNaukri({ limit: 5 }),
  );

  assert.equal(startups.length, 5);
  assertValidStartups(startups, "naukri");
  assert.deepEqual(
    startups.map((startup) => startup.id),
    EXPECTED_IDS,
  );

  const dates = startups.map((startup) => Date.parse(startup.signals[0]?.date ?? ""));
  assert.deepEqual(
    dates,
    [...dates].sort((left, right) => right - left),
    "postings should be ordered newest first",
  );
});

test("naukri: a non-positive limit skips the network entirely", async () => {
  // No fixture replay: a network call here would fail loudly.
  const { result, calls } = await withBlockedFetch(() => fetchNaukri({ limit: 0 }));

  assert.deepEqual(result, []);
  assert.equal(calls, 0);
});

test("naukri: categories select the job families", async () => {
  const itOnly = await withFixtureFetch("naukri", () =>
    fetchNaukri({ limit: 500, categories: ["it-software"] }),
  );
  const engineeringOnly = await withFixtureFetch("naukri", () =>
    fetchNaukri({ limit: 500, categories: ["engineering"] }),
  );

  const itIds = new Set(itOnly.map((startup) => startup.id));
  const engineeringIds = new Set(engineeringOnly.map((startup) => startup.id));

  assert.ok(itIds.has("naukri:051126036839"), "a Java developer is it-software");
  assert.ok(
    !engineeringIds.has("naukri:051126036839"),
    "a Java developer is not an engineering-category role",
  );

  assert.ok(
    engineeringIds.has("naukri:291026025646"),
    "a civil engineer is an engineering-category role",
  );
  assert.ok(
    !itIds.has("naukri:291026025646"),
    "a civil engineer is not it-software",
  );

  assert.ok(itOnly.length > 0 && engineeringOnly.length > 0);
});

test("naukri: a failed sitemap does not sink the source", async () => {
  const recorded = loadFixture("naukri");
  const good = recorded.responses[0];
  assert.ok(good);

  const brokenUrl = "https://www.naukri.com/sitemap/jobDescPagesDelhi.xml";
  const broken: Fixture = fixture([
    {
      url: brokenUrl,
      status: 500,
      headers: {},
      body: "sitemap unavailable",
    },
    good,
  ]);

  const startups = await withFixtureFetch(
    "naukri",
    () => fetchNaukri({ limit: 10, sitemaps: [brokenUrl, good.url] }),
    broken,
  );

  assert.ok(startups.length > 0, "the healthy sitemap should still contribute");
  assertValidStartups(startups, "naukri");
});

test("naukri: an empty sitemap returns no postings", async () => {
  const empty: Fixture = fixture([
    {
      url: "https://www.naukri.com/sitemap/jobDescPagesBangalore.xml",
      status: 200,
      headers: { "content-type": "application/xml" },
      body: '<?xml version="1.0" encoding="UTF-8"?><urlset></urlset>',
    },
  ]);

  const startups = await withFixtureFetch(
    "naukri",
    () => fetchNaukri({ limit: 10 }),
    empty,
  );

  assert.deepEqual(startups, []);
});

test("naukri: derives the posting date from the job id", () => {
  assert.equal(postedAtFromId("051126036839"), "2026-11-05T00:00:00.000Z");
  assert.equal(postedAtFromId("12345"), undefined, "short ids carry no date");
  assert.equal(postedAtFromId("991399999999"), undefined, "invalid month/day");
});

test("naukri: disabled by default in sources.yaml, enabled through an override", async () => {
  const sources = await discoverSources();
  const discovered = sources.filter((source) => source.id === "naukri");

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.file, "naukri.ts");

  const fileConfig = loadSourceConfig(CONFIG_PATH);
  assert.equal(fileConfig.sources?.naukri?.enabled, false, "the board is opt-in");
  assert.equal(
    planSources(fileConfig, discovered).run.some((entry) => entry.source.id === "naukri"),
    false,
    "the shipped config keeps Naukri off",
  );
  assert.ok(
    !planSources(fileConfig, sources).warnings.some((warning) =>
      warning.includes('"naukri"'),
    ),
    "naukri is implemented, so it must not warn",
  );

  const disabled: SourceConfig = { sources: { naukri: { enabled: false } } };
  assert.equal(planSources(disabled, discovered).run.length, 0);

  const enabled: SourceConfig = { sources: { naukri: { enabled: true } } };
  const planned = planSources(enabled, discovered);

  assert.equal(planned.run[0]?.source.id, "naukri");
  assert.equal(planned.run[0]?.settings.enabled, true);
  assert.equal(planned.run[0]?.settings.limit, 100, "the shared default limit applies");

  const startups = await withFixtureFetch("naukri", () =>
    collectStartups(
      enabled,
      { only: new Set(["naukri"]), profile, runId: "naukri-test" },
      discovered,
    ),
  );

  assert.ok(startups.length > 0, "the collection run should return Naukri jobs");
  assertValidStartups(startups, "naukri");
  assert.ok(startups.every((startup) => startup.source === "naukri"));
});
