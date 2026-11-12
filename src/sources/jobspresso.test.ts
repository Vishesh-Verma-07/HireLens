import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { assertValidStartups } from "../../test/contract.js";
import { withFixtureFetch } from "../../test/fixtures.js";
import { isTechRole } from "../lib/text.js";
import type { Profile } from "../types.js";
import { collectStartups, discoverSources, loadSourceConfig } from "./index.js";
import { planSources } from "./registry.js";
import { DEFAULT_FEED_URL, fetchJobspresso } from "./jobspresso.js";

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

test("jobspresso: recorded fixture parses into valid Startups", async () => {
  const startups = await withFixtureFetch("jobspresso", () =>
    fetchJobspresso({ limit: 10 }),
  );

  assert.ok(startups.length > 0, "fixture should contain at least one tech role");
  assertValidStartups(startups, "jobspresso");

  const first = startups[0];
  assert.equal(first?.source, "jobspresso");
  assert.equal(first?.remote, true);
  assert.equal(first?.signals[0]?.type, "hiring");
  assert.ok(first?.name, "company name is mapped from the feed");
  assert.match(first?.id ?? "", /^jobspresso:[a-z0-9-]+$/);
  assert.ok(first?.signals[0]?.date, "RSS dates are normalized");
  assert.match(first?.signals[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("jobspresso: keeps tech roles only and honours the limit", async () => {
  const { all, limited } = await withFixtureFetch("jobspresso", async () => ({
    all: await fetchJobspresso({ limit: 100 }),
    limited: await fetchJobspresso({ limit: 1 }),
  }));

  for (const startup of all) {
    assert.ok(
      isTechRole(startup.oneLiner ?? ""),
      `"${startup.oneLiner}" should be a tech role`,
    );
  }

  assert.ok(
    !all.some((startup) => /account executive/i.test(startup.oneLiner ?? "")),
    "non-technical feed items must be filtered out",
  );
  assert.ok(limited.length <= 1, "limit caps the number of returned startups");
});

test("jobspresso: requests the feedUrl from config", async () => {
  const customUrl = "https://example.test/jobspresso.rss";
  const requested: string[] = [];

  const startups = await withFixtureFetch("jobspresso", async () => {
    const replay = globalThis.fetch;
    globalThis.fetch = ((input, init) => {
      requested.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );
      return replay(input, init);
    }) as typeof fetch;

    try {
      return await fetchJobspresso({ limit: 10, feedUrl: customUrl });
    } finally {
      globalThis.fetch = replay;
    }
  });

  assert.deepEqual(requested, [customUrl]);
  assertValidStartups(startups, "jobspresso");
});

test("jobspresso: falls back to the public feed URL", async () => {
  const requested: string[] = [];

  await withFixtureFetch("jobspresso", async () => {
    const replay = globalThis.fetch;
    globalThis.fetch = ((input, init) => {
      requested.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );
      return replay(input, init);
    }) as typeof fetch;

    try {
      return await fetchJobspresso({ limit: 1 });
    } finally {
      globalThis.fetch = replay;
    }
  });

  assert.deepEqual(requested, [DEFAULT_FEED_URL]);
});

test("jobspresso: is discovered, planned, and collected when enabled in YAML", async () => {
  const sources = await discoverSources();
  const discovered = sources.filter((source) => source.id === "jobspresso");
  assert.equal(discovered.length, 1, "the source module is auto-discovered");

  const config = loadSourceConfig(CONFIG_PATH);
  const plan = planSources(config, discovered);

  assert.equal(plan.run[0]?.source.id, "jobspresso");
  assert.equal(plan.run[0]?.settings.limit, 100);
  assert.equal(plan.run[0]?.settings.feedUrl, DEFAULT_FEED_URL);
  assert.ok(
    !plan.warnings.some((warning) => warning.includes('"jobspresso"')),
    "jobspresso is implemented, so it must not warn",
  );

  const startups = await withFixtureFetch("jobspresso", () =>
    collectStartups(
      config,
      {
        only: new Set(["jobspresso"]),
        profile,
        runId: "jobspresso-test",
      },
      discovered,
    ),
  );

  assert.ok(startups.length > 0, "the collection run should return Jobspresso jobs");
  assertValidStartups(startups, "jobspresso");
  assert.ok(startups.every((startup) => startup.source === "jobspresso"));
});
