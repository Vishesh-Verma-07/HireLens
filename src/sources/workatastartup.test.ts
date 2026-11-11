import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { isTechRole } from "../lib/text.js";
import type { Profile, Startup } from "../types.js";
import { assertValidStartups } from "../../test/contract.js";
import { withFixtureFetch, type Fixture } from "../../test/fixtures.js";
import { collectStartups, loadSourceConfig } from "./index.js";
import { discoverSources, planSources } from "./registry.js";
import { fetchWorkAtAStartup } from "./workatastartup.js";

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

/** The source keeps `roleType` as a tag, so check title + tag together. */
function isTechStartup(startup: Startup): boolean {
  return isTechRole(`${startup.oneLiner ?? ""} ${startup.industry.join(" ")}`);
}

test("workatastartup: recorded fixture parses into valid Startups", async () => {
  const startups = await withFixtureFetch("workatastartup", () =>
    fetchWorkAtAStartup({ limit: 10 }),
  );

  assert.equal(startups.length, 10);
  assertValidStartups(startups, "workatastartup");

  for (const startup of startups) {
    assert.match(startup.id, /^workatastartup:\d+$/);
    assert.equal(startup.source, "workatastartup");
    assert.equal(startup.signals[0]?.type, "hiring");
    assert.ok(isTechStartup(startup), `${startup.oneLiner} should be a tech role`);
  }

  assert.ok(
    startups.some((startup) => startup.batch),
    "YC company metadata (batch) should be preserved",
  );
});

test("workatastartup: respects the configured limit", async () => {
  const startups = await withFixtureFetch("workatastartup", () =>
    fetchWorkAtAStartup({ limit: 3 }),
  );

  assert.equal(startups.length, 3);
  assertValidStartups(startups, "workatastartup");
});

test("workatastartup: maps fields and drops non-tech roles", async () => {
  const fixture: Fixture = {
    source: "workatastartup",
    recordedAt: "2026-11-11T00:00:00Z",
    responses: [
      {
        url: "https://www.workatastartup.com/jobs/search?q=software%20engineer",
        status: 200,
        headers: { "content-type": "application/json" },
        body: {
          jobs: [
            {
              id: 42,
              title: "Founding Software Engineer",
              location: "Remote (US) / San Francisco, CA, US",
              roleType: "Full stack",
              companyName: " Acme ",
              companySlug: "acme",
              companyBatch: "W26",
              companyOneLiner: "Widgets for teams",
            },
            {
              id: 43,
              title: "Account Executive",
              location: "New York, NY, US",
              roleType: "Sales",
              companyName: "Acme",
              companyBatch: "W26",
            },
            {
              id: 44,
              title: "Member of Technical Staff",
              location: "London, England, GB",
              roleType: "Machine learning",
              companyName: "Beta",
              companyBatch: "S24",
            },
          ],
        },
      },
    ],
  };

  const startups = await withFixtureFetch(
    "workatastartup",
    () => fetchWorkAtAStartup({ limit: 2 }),
    fixture,
  );

  assert.deepEqual(
    startups.map((startup) => startup.id),
    ["workatastartup:42", "workatastartup:44"],
    "the sales role must be filtered out, while roleType rescues a generic title",
  );

  const [first, second] = startups;
  assert.equal(first?.name, "Acme");
  assert.equal(first?.oneLiner, "Founding Software Engineer");
  assert.equal(first?.description, "Widgets for teams");
  assert.equal(first?.url, "https://www.workatastartup.com/jobs/42");
  assert.deepEqual(first?.locations, ["Remote (US)", "San Francisco, CA, US"]);
  assert.equal(first?.remote, true);
  assert.deepEqual(first?.industry, ["Full stack"]);
  assert.equal(first?.batch, "W26");
  assert.equal(first?.signals[0]?.type, "hiring");

  assert.equal(second?.name, "Beta");
  assert.equal(second?.remote, undefined);
  assert.equal(second?.batch, "S24");
});

test("workatastartup: source is registered and obeys enabled/limit config", async () => {
  const sources = await discoverSources();
  const discovered = sources.filter((source) => source.id === "workatastartup");

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.file, "workatastartup.ts");

  const enabled = planSources(
    { sources: { workatastartup: { enabled: true, limit: 10 } } },
    discovered,
  );
  assert.equal(enabled.run[0]?.source.id, "workatastartup");
  assert.equal(enabled.run[0]?.settings.limit, 10);

  const disabled = planSources(
    { sources: { workatastartup: { enabled: false } } },
    discovered,
  );
  assert.deepEqual(disabled.run, []);
});

test("workatastartup: enabled in sources.yaml and collected through the registry", async () => {
  const sources = await discoverSources();
  const discovered = sources.filter((source) => source.id === "workatastartup");
  const config = loadSourceConfig(CONFIG_PATH);

  const planned = planSources(config, discovered);
  assert.equal(planned.run[0]?.source.id, "workatastartup");
  assert.equal(planned.run[0]?.settings.limit, 100);

  const startups = await withFixtureFetch("workatastartup", () =>
    collectStartups(
      config,
      {
        only: new Set(["workatastartup"]),
        profile,
        runId: "workatastartup-test",
      },
      discovered,
    ),
  );

  assert.ok(startups.length > 0, "the collection run should return YC jobs");
  assertValidStartups(startups, "workatastartup");
  assert.ok(startups.every((startup) => startup.source === "workatastartup"));
});
