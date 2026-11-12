import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { isTechRole } from "../lib/text.js";
import type { Profile } from "../types.js";
import type { Fixture } from "../../test/fixtures.js";
import { assertValidStartups } from "../../test/contract.js";
import { loadFixture, withFixtureFetch } from "../../test/fixtures.js";
import {
  collectStartups,
  discoverSources,
  loadSourceConfig,
  planSources,
  type SourceConfig,
} from "./index.js";
import { boardUrl, fetchGreenhouse } from "./greenhouse.js";

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
 * The recording holds the Airtable and Discord boards. Airtable has one
 * technical posting; Discord has thirteen. These ids are what survives the
 * tech-role filter, in board order.
 */
const EXPECTED_IDS = [
  "greenhouse:airtable:8498915002",
  "greenhouse:discord:8722538002",
  "greenhouse:discord:8649856002",
  "greenhouse:discord:8847080002",
  "greenhouse:discord:8703614002",
  "greenhouse:discord:8299493002",
  "greenhouse:discord:8910013002",
  "greenhouse:discord:8769799002",
  "greenhouse:discord:8460791002",
  "greenhouse:discord:8691572002",
  "greenhouse:discord:8652853002",
  "greenhouse:discord:8675185002",
  "greenhouse:discord:8802354002",
  "greenhouse:discord:8214127002",
];

/** Replays the recorded boards as if they were two live requests. */
function recordedStartups(config: Parameters<typeof fetchGreenhouse>[0]) {
  return withFixtureFetch("greenhouse", () => fetchGreenhouse(config));
}

test("greenhouse: recorded fixture parses into valid Startups", async () => {
  const startups = await recordedStartups({ limit: 10, companies: ["airtable"] });

  assert.ok(startups.length > 0, "the recorded board should contain a tech role");
  assertValidStartups(startups, "greenhouse");

  for (const startup of startups) {
    assert.match(startup.id, /^greenhouse:airtable:[a-z0-9-]+$/i);
    assert.equal(startup.source, "greenhouse");
    assert.equal(startup.name, "Airtable");
    assert.ok(isTechRole(startup.oneLiner ?? ""), `${startup.oneLiner} should be technical`);
    assert.equal(startup.signals.length, 1);
    assert.equal(startup.signals[0]?.type, "hiring");
    assert.match(startup.signals[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof startup.remote, "boolean");
  }
});

test("greenhouse: maps location, remote, department, and offset date", async () => {
  const startups = await recordedStartups({ limit: 10, companies: ["airtable"] });
  const architect = startups.find(
    (startup) => startup.id === "greenhouse:airtable:8498915002",
  );

  assert.ok(architect, "the Senior Solutions Architect posting should be kept");
  assert.equal(architect.name, "Airtable");
  assert.equal(architect.oneLiner, "Senior Solutions Architect");
  // "Remote - US" is both the location and the office; it must appear once.
  assert.deepEqual(architect.locations, ["Remote - US"]);
  assert.equal(architect.remote, true);
  assert.deepEqual(architect.industry, ["Customer Success & Services"]);
  assert.equal(
    architect.url,
    "https://job-boards.greenhouse.io/airtable/jobs/8498915002",
  );
  // Greenhouse sends "2026-11-09T13:19:18-05:00"; the contract wants ISO 8601.
  assert.equal(architect.signals[0]?.date, "2026-11-09T18:19:18.000Z");
  assert.equal(architect.signals[0]?.text, "Airtable — Senior Solutions Architect");

  // `content` is HTML-escaped HTML: it must be decoded before tags are stripped.
  const description = architect.description ?? "";
  assert.ok(description.length > 0, "the posting body should be mapped");
  assert.ok(description.length <= 4000, "descriptions are capped at 4000 characters");
  assert.doesNotMatch(description, /<\/?[a-z]/i, "no HTML tags should survive");
  assert.doesNotMatch(description, /&lt;|&amp;lt;|&quot;/, "no HTML entities should survive");
});

test("greenhouse: only technical roles survive", async () => {
  const startups = await recordedStartups({
    limit: 100,
    companies: ["airtable", "discord"],
  });

  assert.deepEqual(
    startups.map((startup) => startup.id),
    EXPECTED_IDS,
  );
  // "Account Executive, Corporate" and "Associate Commercial Counsel" are real
  // postings on the recorded boards that the tech-role filter drops.
  const ids = startups.map((startup) => startup.id);
  assert.ok(!ids.includes("greenhouse:airtable:8403107002"));
  assert.ok(!ids.includes("greenhouse:discord:8917177002"));
  for (const startup of startups) {
    assert.ok(isTechRole(startup.oneLiner ?? ""), `${startup.oneLiner} should be technical`);
  }
});

test("greenhouse: supports several companies and de-duplicates ids", async () => {
  const startups = await recordedStartups({
    limit: 100,
    companies: ["airtable", "discord", "airtable"],
  });

  assert.deepEqual(new Set(startups.map((startup) => startup.name)), new Set(["Airtable", "Discord"]));
  assert.equal(new Set(startups.map((startup) => startup.id)).size, startups.length);
  assertValidStartups(startups, "greenhouse");
});

test("greenhouse: the run limit caps the total across companies", async () => {
  const startups = await recordedStartups({
    limit: 3,
    companies: ["airtable", "discord"],
  });

  assert.equal(startups.length, 3);
  assert.deepEqual(
    startups.map((startup) => startup.id),
    EXPECTED_IDS.slice(0, 3),
  );
  assert.equal(new Set(startups.map((startup) => startup.id)).size, 3);
  assertValidStartups(startups, "greenhouse");

  const single = await recordedStartups({ limit: 1, companies: ["airtable", "discord"] });
  assert.deepEqual(single.map((startup) => startup.id), [EXPECTED_IDS[0]]);
});

test("greenhouse: no companies means no network and no jobs", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("greenhouse must not touch the network without companies");
  }) as typeof fetch;

  try {
    assert.deepEqual(await fetchGreenhouse({}), []);
    assert.deepEqual(await fetchGreenhouse({ limit: 10 }), []);
    assert.deepEqual(await fetchGreenhouse({ limit: 10, companies: [] }), []);
    assert.deepEqual(await fetchGreenhouse({ limit: 0, companies: ["airtable"] }), []);
    // Junk slugs are skipped before any request is made.
    assert.deepEqual(await fetchGreenhouse({ limit: 10, companies: ["", "  ", "not a slug"] }), []);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls, 0, "the source should not have requested anything");
});

test("greenhouse: a failing company is skipped, the rest still return jobs", async () => {
  const recorded = loadFixture("greenhouse");
  const airtable = recorded.responses.find(
    (response) => response.url === boardUrl("airtable"),
  );
  assert.ok(airtable, "the fixture must contain the Airtable board");

  const fixture: Fixture = {
    source: "greenhouse",
    recordedAt: recorded.recordedAt,
    responses: [
      {
        url: boardUrl("broken"),
        status: 404,
        headers: { "content-type": "application/json" },
        body: { error: "Job board not found" },
      },
      airtable,
    ],
  };

  const startups = await withFixtureFetch(
    "greenhouse",
    () => fetchGreenhouse({ limit: 10, companies: ["broken", "airtable"] }),
    fixture,
  );

  assert.deepEqual(
    startups.map((startup) => startup.id),
    [EXPECTED_IDS[0]],
  );
  assertValidStartups(startups, "greenhouse");
});

test("greenhouse: malformed jobs, junk dates and empty urls are tolerated", async () => {
  const fixture: Fixture = {
    source: "greenhouse",
    recordedAt: "2026-11-12T00:00:00Z",
    responses: [
      {
        url: boardUrl("acme"),
        status: 200,
        headers: { "content-type": "application/json" },
        body: {
          jobs: [
            null,
            "not a job",
            { id: "1", title: 5 },
            { id: "2", title: "Backend Engineer", updated_at: "not a date", absolute_url: "" },
            {
              id: "3",
              title: "Platform Engineer",
              location: 5,
              offices: [null, { name: 7 }, { name: "Remote" }],
              departments: [{ name: 7 }],
            },
            { id: "3", title: "Platform Engineer" },
          ],
        },
      },
    ],
  };

  const startups = await withFixtureFetch(
    "greenhouse",
    () => fetchGreenhouse({ limit: 10, companies: ["acme"] }),
    fixture,
  );

  assert.deepEqual(
    startups.map((startup) => startup.id),
    ["greenhouse:acme:2", "greenhouse:acme:3"],
    "junk elements are dropped and duplicate ids collapse",
  );
  assertValidStartups(startups, "greenhouse");

  assert.equal(startups[0]?.name, "acme", "no company_name falls back to the slug");
  assert.equal(startups[0]?.signals[0]?.date, undefined, "junk dates are dropped");
  assert.equal(startups[0]?.url, undefined, "an empty absolute_url is omitted");
  assert.equal(startups[0]?.signals[0]?.url, undefined);
  assert.deepEqual(startups[1]?.locations, ["Remote"], "junk label objects are ignored");
});

test("greenhouse: registered and planned when enabled in config", async () => {
  const sources = await discoverSources();
  const discovered = sources.filter((source) => source.id === "greenhouse");

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.file, "greenhouse.ts");

  // The committed YAML ships the aggregators disabled, but the block must
  // already parse into the typed config the source reads.
  const yaml = loadSourceConfig(CONFIG_PATH);
  assert.equal(yaml.sources?.greenhouse?.enabled, false);
  assert.deepEqual(yaml.sources?.greenhouse?.companies, ["stripe", "airtable", "notion"]);

  assert.ok(
    !planSources(yaml, sources).warnings.some((warning) =>
      warning.includes('"greenhouse"'),
    ),
    "greenhouse is implemented, so it must not warn",
  );

  // The same YAML block, flipped on: what a user writes to run the aggregator.
  const config: SourceConfig = {
    sources: { greenhouse: { enabled: true, companies: ["airtable"], limit: 10 } },
  };

  const planned = planSources(config, sources);
  const plannedGreenhouse = planned.run.find(
    (entry) => entry.source.id === "greenhouse",
  );
  assert.ok(plannedGreenhouse, "greenhouse should be planned when enabled");
  assert.equal(plannedGreenhouse.settings.enabled, true);
  assert.equal(plannedGreenhouse.settings.limit, 10);
  assert.deepEqual(plannedGreenhouse.settings.companies, ["airtable"]);
  assert.ok(
    planned.warnings.every((warning) => !warning.includes('"greenhouse"')),
  );

  const startups = await withFixtureFetch("greenhouse", () =>
    collectStartups(
      config,
      {
        only: new Set(["greenhouse"]),
        profile,
        runId: "greenhouse-test",
      },
      discovered,
    ),
  );

  assert.ok(startups.length > 0, "the collection run should return Greenhouse jobs");
  assertValidStartups(startups, "greenhouse");
  assert.ok(startups.every((startup) => startup.source === "greenhouse"));
});
