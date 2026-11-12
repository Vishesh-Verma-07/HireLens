import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { isTechRole } from "../lib/text.js";
import type { Profile } from "../types.js";
import type { Fixture, FixtureResponse } from "../../test/fixtures.js";
import { assertValidStartups } from "../../test/contract.js";
import { loadFixture, withFixtureFetch } from "../../test/fixtures.js";
import {
  collectStartups,
  discoverSources,
  loadSourceConfig,
  planSources,
  type SourceConfig,
} from "./index.js";
import { fetchWeb3Career, LISTING_URL } from "./web3career.js";

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

/**
 * The recorded fixture holds five listing pages. These are the three newest
 * technical postings across them, after the tech filter and newest-first sort.
 */
const EXPECTED_IDS = [
  "web3_career:155626",
  "web3_career:156110",
  "web3_career:156109",
];

/** Roles the board lists but the source must drop as non-technical. */
const NON_TECH_IDS = [
  "web3_career:156108", // Junior Legal & Compliance Analyst
  "web3_career:156116", // Director / Senior Director of Communications
  "web3_career:156096", // Marketing Coordinator
  "web3_career:155983", // Junior Market Analyst
];

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

function fixture(responses: FixtureResponse[]): Fixture {
  return { source: "web3_career", recordedAt: "2026-11-12T00:00:00Z", responses };
}

test("web3_career: recorded fixture parses into valid Startups", async () => {
  const startups = await withFixtureFetch("web3_career", () =>
    fetchWeb3Career({ limit: 10 }),
  );

  assert.ok(startups.length > 0, "fixture should contain at least one tech role");
  assertValidStartups(startups, "web3_career");

  for (const startup of startups) {
    assert.equal(startup.source, "web3_career");
    assert.match(startup.id, /^web3_career:\d+$/);
    assert.ok(startup.name.length > 0);
    assert.ok(
      isTechRole(startup.oneLiner ?? ""),
      `${startup.oneLiner} should be technical`,
    );
    assert.ok(startup.locations.length > 0, "every posting has a location");
    assert.match(startup.url ?? "", /^https:\/\/web3\.career\//);
    assert.equal(startup.signals[0]?.type, "hiring");
    assert.match(startup.signals[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.ok((startup.description ?? "").length <= 4000);
  }
});

test("web3_career: maps the row, the location and the JSON-LD description", async () => {
  const startups = await withFixtureFetch("web3_career", () =>
    fetchWeb3Career({ limit: 10 }),
  );

  const ihsan = startups.find((startup) => startup.id === "web3_career:155626");
  assert.ok(ihsan, "the Ihsan posting should be kept");
  assert.equal(ihsan.name, "Ihsan");
  assert.equal(ihsan.oneLiner, "Senior Smart Contract Engineer — Ihsan Gold Token");
  assert.equal(
    ihsan.url,
    "https://web3.career/senior-smart-contract-engineer-ihsan-gold-token-ihsan/155626",
  );
  assert.deepEqual(ihsan.locations, ["Remote"]);
  assert.equal(ihsan.remote, true);
  assert.ok(ihsan.industry.includes("engineer"), "tags become industry labels");
  assert.equal(ihsan.signals[0]?.date, "2026-11-11T19:11:02.000Z");
  assert.match(ihsan.description ?? "", /^Compensation: \$120k - \$240k/);
  assert.match(ihsan.description ?? "", /Ihsan Gold Token/);

  // A city-specific posting keeps its location and is not marked remote just
  // because the board's JSON-LD says TELECOMMUTE for every listing.
  const etherFi = startups.find((startup) => startup.id === "web3_career:156110");
  assert.ok(etherFi, "the ether.fi posting should be kept");
  assert.deepEqual(etherFi.locations, ["Denver, CO, United States"]);
  assert.equal(etherFi.remote, undefined);
  assert.ok(etherFi.industry.includes("blockchain"));
});

test("web3_career: drops non-technical postings", async () => {
  const startups = await withFixtureFetch("web3_career", () =>
    fetchWeb3Career({ limit: 100 }),
  );

  const ids = startups.map((startup) => startup.id);
  for (const nonTech of NON_TECH_IDS) {
    assert.ok(!ids.includes(nonTech), `${nonTech} is not a technical role`);
  }

  assert.equal(new Set(ids).size, ids.length, "ids must be unique within a run");
});

test("web3_career: respects the limit and keeps the newest postings", async () => {
  const startups = await withFixtureFetch("web3_career", () =>
    fetchWeb3Career({ limit: 3 }),
  );

  assert.equal(startups.length, 3);
  assertValidStartups(startups, "web3_career");
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

test("web3_career: a non-positive limit skips the network entirely", async () => {
  for (const config of [{ limit: 0 }, { limit: -5 }]) {
    const { result, calls } = await withBlockedFetch(() => fetchWeb3Career(config));
    assert.deepEqual(result, []);
    assert.equal(calls, 0, "a non-positive limit must not hit the network");
  }
});

test("web3_career: a page without a listing is skipped, the next page still loads", async () => {
  const recorded = loadFixture("web3_career");
  const secondPage = recorded.responses[1];
  assert.ok(secondPage, "the fixture should hold a second listing page");

  const broken = fixture([
    {
      url: LISTING_URL,
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<html><body><p>No jobs here.</p></body></html>",
    },
    secondPage,
  ]);

  const startups = await withFixtureFetch(
    "web3_career",
    () => fetchWeb3Career({ limit: 10 }),
    broken,
  );

  assert.ok(startups.length > 0, "the second page should still contribute");
  assertValidStartups(startups, "web3_career");
});

test("web3_career: enabled in sources.yaml and collected through the registry", async () => {
  const sources = await discoverSources();
  const discovered = sources.filter((source) => source.id === "web3_career");

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.file, "web3career.ts");

  const config = loadSourceConfig(CONFIG_PATH);
  const planned = planSources(config, discovered);

  assert.equal(planned.run[0]?.source.id, "web3_career");
  assert.equal(planned.run[0]?.settings.enabled, true);
  assert.equal(planned.run[0]?.settings.limit, 60);
  assert.ok(
    !planSources(config, sources).warnings.some((warning) =>
      warning.includes('"web3_career"'),
    ),
    "web3_career is implemented, so it must not warn",
  );

  const startups = await withFixtureFetch("web3_career", () =>
    collectStartups(
      config,
      { only: new Set(["web3_career"]), profile, runId: "web3-career-test" },
      discovered,
    ),
  );

  assert.ok(startups.length > 0, "the collection run should return Web3.career jobs");
  assertValidStartups(startups, "web3_career");
  assert.ok(startups.every((startup) => startup.source === "web3_career"));
});

test("web3_career: enabled:false removes the source from the plan", async () => {
  const disabled: SourceConfig = {
    sources: { web3_career: { enabled: false } },
  };

  const sources = await discoverSources();
  const plan = planSources(disabled, sources);
  assert.equal(
    plan.run.some((entry) => entry.source.id === "web3_career"),
    false,
  );
});
