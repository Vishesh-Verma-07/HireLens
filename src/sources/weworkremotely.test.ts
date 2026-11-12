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
import {
  DEFAULT_FEED_URL,
  fetchWeWorkRemotely,
  isProgrammingCategory,
  parseWwrTitle,
} from "./weworkremotely.js";

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

/** A small feed that exercises every mapping rule without the live fixture. */
const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>We Work Remotely: test feed</title>
    <item>
      <title>Acme: Senior Software Engineer</title>
      <region>Anywhere in the World</region>
      <category>Full-Stack Programming</category>
      <description><![CDATA[<p>Build things with React and Node.</p>]]></description>
      <pubDate>Mon, 19 Oct 2026 10:01:21 +0000</pubDate>
      <guid>https://weworkremotely.com/remote-jobs/acme-senior-software-engineer</guid>
      <link>https://weworkremotely.com/remote-jobs/acme-senior-software-engineer</link>
    </item>
    <item>
      <title>Acme: Senior Software Engineer</title>
      <region>Europe Only</region>
      <category>Design</category>
      <description>Not a programming role.</description>
      <pubDate>Mon, 19 Oct 2026 09:00:00 +0000</pubDate>
      <guid>https://weworkremotely.com/remote-jobs/acme-designer</guid>
      <link>https://weworkremotely.com/remote-jobs/acme-designer</link>
    </item>
    <item>
      <title>Acme: SAP Berater FI/CO</title>
      <region>Anywhere in the World</region>
      <category>Full-Stack Programming</category>
      <description>A non-technical title in a programming category.</description>
      <pubDate>Mon, 19 Oct 2026 08:00:00 +0000</pubDate>
      <guid>https://weworkremotely.com/remote-jobs/acme-sap-berater</guid>
      <link>https://weworkremotely.com/remote-jobs/acme-sap-berater</link>
    </item>
    <item>
      <title>Beta: Backend Developer</title>
      <region>Anywhere in the World</region>
      <description>A feed variant that omits the category.</description>
      <pubDate>Sun, 18 Oct 2026 10:01:21 +0000</pubDate>
      <guid>https://weworkremotely.com/remote-jobs/beta-backend-developer</guid>
      <link>https://weworkremotely.com/remote-jobs/beta-backend-developer</link>
    </item>
  </channel>
</rss>`;

function fixtureWith(body: string, url: string): Fixture {
  return {
    source: "weworkremotely",
    recordedAt: "2026-11-12T00:00:00Z",
    responses: [
      { url, status: 200, headers: { "content-type": "application/rss+xml" }, body },
    ],
  };
}

test("weworkremotely: recorded fixture parses into valid Startups", async () => {
  const startups = await withFixtureFetch("weworkremotely", () =>
    fetchWeWorkRemotely({ limit: 10 }),
  );

  assert.ok(startups.length > 0, "fixture should contain at least one tech role");
  assertValidStartups(startups, "weworkremotely");

  for (const startup of startups) {
    assert.match(startup.id, /^weworkremotely:[a-z0-9-]+$/);
    assert.equal(startup.source, "weworkremotely");
    assert.equal(startup.remote, true);
    assert.equal(startup.signals[0]?.type, "hiring");
    assert.match(startup.signals[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(startup.name.length > 0);
    assert.ok(isTechRole(startup.oneLiner ?? ""), `${startup.oneLiner} should be technical`);
    assert.ok(startup.locations.length > 0, "every WWR job has a region");
  }
});

test("weworkremotely: respects the limit and keeps the newest postings", async () => {
  const startups = await withFixtureFetch("weworkremotely", () =>
    fetchWeWorkRemotely({ limit: 3 }),
  );

  assert.equal(startups.length, 3);
  assertValidStartups(startups, "weworkremotely");

  const dates = startups.map((startup) => Date.parse(startup.signals[0]?.date ?? ""));
  assert.deepEqual(
    dates,
    [...dates].sort((left, right) => right - left),
    "postings should be ordered newest first",
  );
});

test("weworkremotely: a non-positive limit skips the network entirely", async () => {
  // No fixture replay: a network call here would fail loudly.
  assert.deepEqual(await fetchWeWorkRemotely({ limit: 0 }), []);
});

test("weworkremotely: feedUrl from config is the URL requested", async () => {
  const customUrl = "https://feeds.test/weworkremotely/all-jobs.rss";
  const fixture = fixtureWith(SAMPLE_FEED, customUrl);

  // A second response makes the fixture reject any other URL, so this fails
  // unless the source actually used the configured feedUrl.
  fixture.responses.push({
    url: "https://feeds.test/weworkremotely/not-this-one.rss",
    status: 200,
    headers: { "content-type": "application/rss+xml" },
    body: "<rss><channel></channel></rss>",
  });

  const startups = await withFixtureFetch(
    "weworkremotely",
    () => fetchWeWorkRemotely({ limit: 10, feedUrl: customUrl }),
    fixture,
  );

  assert.deepEqual(
    startups.map((startup) => startup.id).sort(),
    [
      "weworkremotely:acme-senior-software-engineer",
      "weworkremotely:beta-backend-developer",
    ],
  );
});

test("weworkremotely: maps title, region, category, and RFC 2822 date", async () => {
  const startups = await withFixtureFetch(
    "weworkremotely",
    () => fetchWeWorkRemotely({ limit: 10 }),
    fixtureWith(SAMPLE_FEED, DEFAULT_FEED_URL),
  );

  const acme = startups.find(
    (startup) => startup.id === "weworkremotely:acme-senior-software-engineer",
  );
  assert.ok(acme, "programming-category tech role should be kept");
  assert.equal(acme.name, "Acme");
  assert.equal(acme.oneLiner, "Senior Software Engineer");
  assert.deepEqual(acme.locations, ["Anywhere in the World"]);
  assert.deepEqual(acme.industry, ["Full-Stack Programming"]);
  assert.equal(acme.url, "https://weworkremotely.com/remote-jobs/acme-senior-software-engineer");
  assert.equal(acme.signals[0]?.date, "2026-10-19T10:01:21.000Z");
  assert.match(acme.description ?? "", /Build things with React and Node/);

  const beta = startups.find(
    (startup) => startup.id === "weworkremotely:beta-backend-developer",
  );
  assert.ok(beta, "a tech role without a category is still kept");
  assert.deepEqual(beta.industry, []);
});

test("weworkremotely: drops non-programming categories and non-tech titles", async () => {
  const startups = await withFixtureFetch(
    "weworkremotely",
    () => fetchWeWorkRemotely({ limit: 10 }),
    fixtureWith(SAMPLE_FEED, DEFAULT_FEED_URL),
  );

  const ids = startups.map((startup) => startup.id);
  assert.ok(!ids.includes("weworkremotely:acme-designer"), "design category is not programming");
  assert.ok(!ids.includes("weworkremotely:acme-sap-berater"), "non-tech title is dropped");
});

test("parseWwrTitle splits company and role on the first colon", () => {
  assert.deepEqual(parseWwrTitle("Acme: Senior Engineer: Backend"), {
    company: "Acme",
    role: "Senior Engineer: Backend",
  });
  assert.deepEqual(parseWwrTitle("  Solo Founder  "), {
    company: "Solo Founder",
    role: "Solo Founder",
  });
});

test("isProgrammingCategory recognizes WWR programming categories only", () => {
  for (const category of [
    "Full-Stack Programming",
    "Back-End Programming",
    "DevOps and Sysadmin",
    "Data Analysis",
    "Machine Learning and AI",
  ]) {
    assert.equal(isProgrammingCategory(category), true, category);
  }

  for (const category of [
    "Design",
    "Marketing",
    "Sales and Marketing",
    "Customer Support",
    "Finance and Legal",
  ]) {
    assert.equal(isProgrammingCategory(category), false, category);
  }
});

test("weworkremotely: enabled in sources.yaml and collected through the registry", async () => {
  const sources = await discoverSources();
  const discovered = sources.filter((source) => source.id === "weworkremotely");

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.file, "weworkremotely.ts");

  const config = loadSourceConfig(CONFIG_PATH);
  const planned = planSources(config, discovered);

  assert.equal(planned.run[0]?.source.id, "weworkremotely");
  assert.equal(planned.run[0]?.settings.limit, 100);
  assert.equal(planned.run[0]?.settings.feedUrl, DEFAULT_FEED_URL);

  const startups = await withFixtureFetch("weworkremotely", () =>
    collectStartups(
      config,
      {
        only: new Set(["weworkremotely"]),
        profile,
        runId: "weworkremotely-test",
      },
      discovered,
    ),
  );

  assert.ok(startups.length > 0, "the collection run should return WWR jobs");
  assertValidStartups(startups, "weworkremotely");
  assert.ok(startups.every((startup) => startup.source === "weworkremotely"));
});
