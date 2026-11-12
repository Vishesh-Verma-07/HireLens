import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { isTechRole } from "../lib/text.js";
import type { Profile } from "../types.js";
import type { Fixture } from "../../test/fixtures.js";
import { assertValidStartups } from "../../test/contract.js";
import { withFixtureFetch } from "../../test/fixtures.js";
import {
  collectStartups,
  discoverSources,
  loadSourceConfig,
  planSources,
} from "./index.js";
import { DEFAULT_FEED_URL, fetchRemoteCo } from "./remoteco.js";

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
 * The recorded fixture holds nine unique technical postings, four non-technical
 * ones, and one repost of an existing listing. These ids are what survives the
 * filters, newest first.
 */
const EXPECTED_IDS = [
  "remoteco:senior-software-engineer-gitlab",
  "remoteco:frontend-developer-buffer",
  "remoteco:devops-engineer-zapier",
  "remoteco:data-scientist-automattic",
  "remoteco:machine-learning-engineer-doist",
  "remoteco:backend-engineer-toggl",
  "remoteco:full-stack-developer-ghost",
  "remoteco:mobile-engineer-basecamp",
  "remoteco:security-engineer-mattermost",
];

/** A small WP Job Manager feed that exercises the feedUrl override. */
const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:job_listing="https://remote.co">
  <channel>
    <title>Remote.co: test feed</title>
    <item>
      <title>Staff Platform Engineer</title>
      <link>https://remote.co/remote-jobs/staff-platform-engineer-acme/</link>
      <pubDate>Mon, 12 Oct 2026 10:00:00 +0000</pubDate>
      <guid isPermaLink="false">https://remote.co/remote-jobs/staff-platform-engineer-acme/</guid>
      <description><![CDATA[<p>Run the platform.</p>]]></description>
      <job_listing:location><![CDATA[Anywhere in the World]]></job_listing:location>
      <job_listing:job_type><![CDATA[Engineer]]></job_listing:job_type>
      <job_listing:job_category><![CDATA[Full Time]]></job_listing:job_category>
      <job_listing:company><![CDATA[Acme]]></job_listing:company>
    </item>
    <item>
      <title>Sales Development Representative</title>
      <link>https://remote.co/remote-jobs/sales-development-representative-acme/</link>
      <pubDate>Mon, 12 Oct 2026 09:00:00 +0000</pubDate>
      <guid isPermaLink="false">https://remote.co/remote-jobs/sales-development-representative-acme/</guid>
      <description>Not a technical role.</description>
      <job_listing:location><![CDATA[United States]]></job_listing:location>
      <job_listing:job_type><![CDATA[Sales]]></job_listing:job_type>
      <job_listing:job_category><![CDATA[Full Time]]></job_listing:job_category>
      <job_listing:company><![CDATA[Acme]]></job_listing:company>
    </item>
  </channel>
</rss>`;

function fixtureWith(body: string, url: string): Fixture {
  return {
    source: "remoteco",
    recordedAt: "2026-11-12T00:00:00Z",
    responses: [
      { url, status: 200, headers: { "content-type": "application/rss+xml" }, body },
    ],
  };
}

test("remoteco: recorded fixture parses into valid Startups", async () => {
  const startups = await withFixtureFetch("remoteco", () =>
    fetchRemoteCo({ limit: 10 }),
  );

  assert.ok(startups.length > 0, "fixture should contain at least one tech role");
  assertValidStartups(startups, "remoteco");

  for (const startup of startups) {
    assert.match(startup.id, /^remoteco:[a-z0-9-]+$/);
    assert.equal(startup.source, "remoteco");
    assert.equal(startup.remote, true);
    assert.equal(startup.signals[0]?.type, "hiring");
    assert.match(startup.signals[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(startup.name.length > 0);
    assert.ok(isTechRole(startup.oneLiner ?? ""), `${startup.oneLiner} should be technical`);
    assert.ok(startup.locations.length > 0, "every Remote.co job has a location");
  }
});

test("remoteco: maps company, location, industry, and RFC 2822 date", async () => {
  const startups = await withFixtureFetch("remoteco", () =>
    fetchRemoteCo({ limit: 10 }),
  );

  const gitlab = startups.find(
    (startup) => startup.id === "remoteco:senior-software-engineer-gitlab",
  );
  assert.ok(gitlab, "the GitLab posting should be kept");
  assert.equal(gitlab.name, "GitLab");
  assert.equal(gitlab.oneLiner, "Senior Software Engineer");
  assert.deepEqual(gitlab.locations, ["Anywhere in the World"]);
  assert.deepEqual(gitlab.industry, ["Engineer"], "employment type is not an industry tag");
  assert.equal(
    gitlab.url,
    "https://remote.co/remote-jobs/senior-software-engineer-gitlab/",
  );
  assert.equal(gitlab.signals[0]?.date, "2026-11-11T22:41:00.000Z");
  assert.match(gitlab.description ?? "", /GitLab DevOps platform/);

  // `dc:creator` is "Company<br>⚲ Location" when `job_listing:company` is absent.
  const buffer = startups.find(
    (startup) => startup.id === "remoteco:frontend-developer-buffer",
  );
  assert.ok(buffer, "a posting without job_listing:company still gets its employer");
  assert.equal(buffer.name, "Buffer");
  assert.deepEqual(buffer.locations, ["Europe"]);

  const basecamp = startups.find(
    (startup) => startup.id === "remoteco:mobile-engineer-basecamp",
  );
  assert.deepEqual(basecamp?.locations, ["United States", "Canada"]);

  // "Full Time, Contract" is split and dropped as employment type labels.
  const doist = startups.find(
    (startup) => startup.id === "remoteco:machine-learning-engineer-doist",
  );
  assert.deepEqual(doist?.industry, ["Engineer"]);
});

test("remoteco: drops non-technical postings and de-duplicates reposts", async () => {
  const startups = await withFixtureFetch("remoteco", () =>
    fetchRemoteCo({ limit: 100 }),
  );

  const ids = startups.map((startup) => startup.id);
  for (const nonTech of [
    "remoteco:account-executive-brightcove",
    "remoteco:customer-support-specialist-help-scout",
    "remoteco:product-designer-invision",
    "remoteco:marketing-manager-buffer",
  ]) {
    assert.ok(!ids.includes(nonTech), `${nonTech} is not a technical role`);
  }

  assert.equal(
    ids.filter((id) => id === "remoteco:senior-software-engineer-gitlab").length,
    1,
    "a reposted listing must appear once",
  );
  assert.deepEqual(ids, EXPECTED_IDS);
});

test("remoteco: respects the limit and keeps the newest postings", async () => {
  const startups = await withFixtureFetch("remoteco", () =>
    fetchRemoteCo({ limit: 3 }),
  );

  assert.equal(startups.length, 3);
  assertValidStartups(startups, "remoteco");
  assert.deepEqual(
    startups.map((startup) => startup.id),
    EXPECTED_IDS.slice(0, 3),
  );

  const dates = startups.map((startup) => Date.parse(startup.signals[0]?.date ?? ""));
  assert.deepEqual(
    dates,
    [...dates].sort((left, right) => right - left),
    "postings should be ordered newest first",
  );
});

test("remoteco: a non-positive limit skips the network entirely", async () => {
  // No fixture replay: a network call here would fail loudly.
  assert.deepEqual(await fetchRemoteCo({ limit: 0 }), []);
});

test("remoteco: feedUrl from config is the URL requested", async () => {
  const customUrl = "https://feeds.test/remoteco/remote-jobs.rss";
  const fixture = fixtureWith(SAMPLE_FEED, customUrl);

  // A second response makes the fixture reject any other URL, so this fails
  // unless the source actually used the configured feedUrl.
  fixture.responses.push({
    url: "https://feeds.test/remoteco/not-this-one.rss",
    status: 200,
    headers: { "content-type": "application/rss+xml" },
    body: "<rss><channel></channel></rss>",
  });

  const startups = await withFixtureFetch(
    "remoteco",
    () => fetchRemoteCo({ limit: 10, feedUrl: customUrl }),
    fixture,
  );

  assert.deepEqual(
    startups.map((startup) => startup.id),
    ["remoteco:staff-platform-engineer-acme"],
  );
});

test("remoteco: enabled in sources.yaml and collected through the registry", async () => {
  const sources = await discoverSources();
  const discovered = sources.filter((source) => source.id === "remoteco");

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.file, "remoteco.ts");

  const config = loadSourceConfig(CONFIG_PATH);
  const planned = planSources(config, discovered);

  assert.equal(planned.run[0]?.source.id, "remoteco");
  assert.equal(planned.run[0]?.settings.limit, 100);
  assert.equal(planned.run[0]?.settings.feedUrl, DEFAULT_FEED_URL);
  assert.ok(
    !planSources(config, sources).warnings.some((warning) =>
      warning.includes('"remoteco"'),
    ),
    "remoteco is implemented, so it must not warn",
  );

  const startups = await withFixtureFetch("remoteco", () =>
    collectStartups(
      config,
      {
        only: new Set(["remoteco"]),
        profile,
        runId: "remoteco-test",
      },
      discovered,
    ),
  );

  assert.ok(startups.length > 0, "the collection run should return Remote.co jobs");
  assertValidStartups(startups, "remoteco");
  assert.ok(startups.every((startup) => startup.source === "remoteco"));
});
