import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { isTechRole } from "../lib/text.js";
import type { Profile } from "../types.js";
import { assertValidStartups } from "../../test/contract.js";
import {
  loadFixture,
  withFixtureFetch,
  type Fixture,
  type FixtureResponse,
} from "../../test/fixtures.js";
import {
  collectStartups,
  discoverSources,
  loadSourceConfig,
  planSources,
} from "./index.js";
import { fetchAshby } from "./ashby.js";

const CONFIG_PATH = resolve(import.meta.dirname, "../../config/sources.yaml");
const BOARD = "https://api.ashbyhq.com/posting-api/job-board";

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
 * The PostHog board currently lists ten postings; three titles pass
 * `isTechRole`. "Product Manager, Observability (ex-founder or ex-product
 * engineer)" survives because the shared matcher keys off the word
 * "engineer" — the title really does name engineering work.
 */
const EXPECTED_IDS = [
  "ashby:posthog:8dc3f33a-b930-4c54-b4c4-3e6bd2ff28d3",
  "ashby:posthog:1464036f-94d5-4dbd-aef8-fe99246a26d4",
  "ashby:posthog:3c592b84-8b34-4ae4-ae23-cadce8f2212d",
];

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A second board, so multi-company behaviour is not asserted against one slug. */
const ACME_URL = `${BOARD}/acme`;

const ACME_BOARD = {
  apiVersion: "1",
  jobs: [
    {
      id: "11111111-1111-1111-1111-111111111111",
      title: "Backend Engineer",
      location: "Berlin",
      // Repeated location plus postal city/region must collapse to one entry.
      secondaryLocations: [{ location: "Berlin" }, { location: "Remote (EU)" }],
      department: "Engineering",
      team: "Platform",
      isListed: true,
      isRemote: false,
      workplaceType: "Hybrid",
      employmentType: "FullTime",
      jobUrl: "https://jobs.ashbyhq.com/acme/11111111",
      applyUrl: "https://jobs.ashbyhq.com/acme/11111111/application",
      publishedAt: "2026-10-01T10:00:00.000+00:00",
      // No descriptionPlain: the HTML fallback has to produce the text.
      descriptionHtml: "<p>Build the <strong>API</strong></p>",
      address: {
        postalAddress: { addressLocality: "Berlin", addressRegion: "Berlin" },
      },
    },
    {
      id: "22222222-2222-2222-2222-222222222222",
      title: "Site Reliability Engineer",
      isListed: true,
      isRemote: false,
      // Remote is inferred from the workplace type when isRemote is false.
      workplaceType: "Remote",
      department: "Engineering",
      jobUrl: "https://jobs.ashbyhq.com/acme/22222222",
      publishedAt: "2026-09-15T08:30:00.000+00:00",
      descriptionPlain: "Keep the site up.",
      secondaryLocations: [{ location: "United States" }],
      address: {
        postalAddress: {
          addressLocality: "San Francisco",
          addressRegion: "California",
          addressCountry: "US",
        },
      },
    },
    {
      id: "33333333-3333-3333-3333-333333333333",
      title: "Product Designer",
      isListed: true,
      location: "Remote",
      department: "Design",
      jobUrl: "https://jobs.ashbyhq.com/acme/33333333",
      publishedAt: "2026-09-01T08:30:00.000+00:00",
      descriptionPlain: "Design things.",
    },
    {
      // Technical title, but the posting is hidden from the public board.
      id: "44444444-4444-4444-4444-444444444444",
      title: "Staff Software Engineer",
      isListed: false,
      location: "Remote",
      department: "Engineering",
      jobUrl: "https://jobs.ashbyhq.com/acme/44444444",
      publishedAt: "2026-08-20T08:30:00.000+00:00",
    },
    { id: "", title: "Platform Engineer", isListed: true },
    { title: "Platform Engineer", isListed: true },
    { id: "55555555-5555-5555-5555-555555555555", title: "  ", isListed: true },
  ],
};

function fixtureWith(responses: FixtureResponse[]): Fixture {
  return { source: "ashby", recordedAt: "2026-11-12T00:00:00Z", responses };
}

function jsonResponse(url: string, body: unknown): FixtureResponse {
  return { url, status: 200, headers: { "content-type": "application/json" }, body };
}

/** The recorded PostHog response, reused by the hand-written fixtures. */
function recordedPosthogResponse(): FixtureResponse {
  const recorded = loadFixture("ashby").responses.find(
    (response) => response.url === `${BOARD}/posthog`,
  );
  assert.ok(recorded, "the recorded fixture should hold the posthog board");
  return recorded;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

test("ashby: recorded fixture parses into valid Startups", async () => {
  const startups = await withFixtureFetch("ashby", () =>
    fetchAshby({ limit: 50, companies: ["posthog"] }),
  );

  assert.ok(startups.length > 0, "fixture should contain at least one tech role");
  assertValidStartups(startups, "ashby");
  assert.deepEqual(
    startups.map((startup) => startup.id),
    EXPECTED_IDS,
  );
});

test("ashby: keeps tech roles, names the company, and dates the signal", async () => {
  const startups = await withFixtureFetch("ashby", () =>
    fetchAshby({ limit: 50, companies: ["posthog"] }),
  );

  for (const startup of startups) {
    assert.match(startup.id, /^ashby:posthog:[a-z0-9-]+$/i);
    assert.equal(startup.name, "posthog");
    assert.equal(startup.source, "ashby");
    assert.ok(startup.oneLiner && isTechRole(startup.oneLiner));
    assert.equal(startup.remote, true);
    assert.ok(startup.locations.length > 0, "every Ashby posting carries a location");
    assert.ok(startup.industry.length > 0, "department/team become industry tags");
    assert.match(startup.url ?? "", /^https:\/\/jobs\.ashbyhq\.com\//);
    assert.ok((startup.description ?? "").length > 0);
    assert.ok((startup.description ?? "").length <= 4000, "descriptions are capped");

    assert.equal(startup.signals.length, 1);
    assert.equal(startup.signals[0]?.type, "hiring");
    assert.match(startup.signals[0]?.date ?? "", ISO_DATETIME);
    assert.equal(startup.signals[0]?.text, `posthog — ${startup.oneLiner}`);
    assert.equal(startup.signals[0]?.url, startup.url);
  }

  // Non-technical postings on the same board must not leak through.
  const titles = startups.map((startup) => startup.oneLiner);
  for (const nonTech of [
    "Technical Support Engineer",
    "Technical Customer Success Manager - EMEA",
    "Strategic Finance Analyst",
    "Developer Marketer - Sales",
    "Animator & Motion Graphics Designer",
  ]) {
    assert.ok(!titles.includes(nonTech), `${nonTech} is not a technical role`);
  }
});

test("ashby: respects the total limit", async () => {
  const startups = await withFixtureFetch("ashby", () =>
    fetchAshby({ limit: 2, companies: ["posthog"] }),
  );

  assert.deepEqual(
    startups.map((startup) => startup.id),
    EXPECTED_IDS.slice(0, 2),
  );
  assertValidStartups(startups, "ashby");

  const all = await withFixtureFetch("ashby", () =>
    fetchAshby({ limit: 100, companies: ["posthog"] }),
  );
  assert.equal(all.length, EXPECTED_IDS.length, "posthog only has three tech roles");
  assert.equal(new Set(all.map((startup) => startup.id)).size, all.length);
});

test("ashby: an empty company list skips the network entirely", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(requestUrl(input));
    throw new Error("ashby: unexpected network call");
  }) as typeof fetch;

  try {
    assert.deepEqual(await fetchAshby({ limit: 10, companies: [] }), []);
    assert.deepEqual(await fetchAshby({ limit: 10 }), []);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, []);
});

test("ashby: an invalid slug is skipped without a request", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const body = JSON.stringify(recordedPosthogResponse().body);

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(requestUrl(input));
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    // "PostHog" is normalized to the board's lowercase slug.
    const startups = await fetchAshby({
      limit: 10,
      companies: ["not a slug", "", "PostHog"],
    });

    assert.deepEqual(
      startups.map((startup) => startup.id),
      EXPECTED_IDS,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [`${BOARD}/posthog`]);
});

test("ashby: a failing company is skipped while the good one still returns", async () => {
  const fixture = fixtureWith([
    {
      url: `${BOARD}/broken`,
      status: 404,
      headers: { "content-type": "text/plain" },
      body: "Not Found",
    },
    recordedPosthogResponse(),
  ]);

  const startups = await withFixtureFetch(
    "ashby",
    () => fetchAshby({ limit: 10, companies: ["broken", "posthog"] }),
    fixture,
  );

  assert.deepEqual(
    startups.map((startup) => startup.id),
    EXPECTED_IDS,
  );
  assertValidStartups(startups, "ashby");
});

test("ashby: maps a second board and stops at the limit across companies", async () => {
  const fixture = fixtureWith([recordedPosthogResponse(), jsonResponse(ACME_URL, ACME_BOARD)]);

  const startups = await withFixtureFetch(
    "ashby",
    () => fetchAshby({ limit: 4, companies: ["posthog", "acme"] }),
    fixture,
  );

  assert.deepEqual(
    startups.map((startup) => startup.id),
    [...EXPECTED_IDS, "ashby:acme:11111111-1111-1111-1111-111111111111"].slice(0, 4),
    "the limit is shared across companies",
  );
  assertValidStartups(startups, "ashby");
});

test("ashby: maps locations, remote, industry, description, and dates", async () => {
  const fixture = fixtureWith([recordedPosthogResponse(), jsonResponse(ACME_URL, ACME_BOARD)]);

  const startups = await withFixtureFetch(
    "ashby",
    () => fetchAshby({ limit: 10, companies: ["acme"] }),
    fixture,
  );

  assert.deepEqual(
    startups.map((startup) => startup.id),
    [
      "ashby:acme:11111111-1111-1111-1111-111111111111",
      "ashby:acme:22222222-2222-2222-2222-222222222222",
    ],
    "unlisted, non-technical, and id-less postings are dropped",
  );

  const [backend, sre] = startups;
  assert.ok(backend && sre);

  assert.equal(backend.name, "acme");
  assert.deepEqual(backend.locations, ["Berlin", "Remote (EU)"]);
  assert.equal(backend.remote, false);
  assert.deepEqual(backend.industry, ["Engineering", "Platform"]);
  assert.equal(backend.description, "Build the API", "HTML falls back when plain text is absent");
  assert.equal(backend.signals[0]?.date, "2026-10-01T10:00:00.000Z");
  assert.equal(backend.url, "https://jobs.ashbyhq.com/acme/11111111");

  assert.deepEqual(sre.locations, ["United States", "San Francisco", "California"]);
  assert.equal(sre.remote, true, "workplaceType Remote counts as remote");
  assert.deepEqual(sre.industry, ["Engineering"]);
  assert.equal(sre.description, "Keep the site up.");
  assert.equal(sre.signals[0]?.date, "2026-09-15T08:30:00.000Z");
});

test("ashby: enabled in sources.yaml and collected through the registry", async () => {
  const sources = await discoverSources();
  const discovered = sources.filter((source) => source.id === "ashby");

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.file, "ashby.ts");

  const config = loadSourceConfig(CONFIG_PATH);

  // Ashby ships disabled: it is a per-company aggregator, so a run without
  // configured company slugs has nothing to fetch.
  assert.deepEqual(planSources(config, discovered).run, []);

  const enabling = {
    sources: { ashby: { enabled: true, companies: ["posthog"], limit: 10 } },
  };
  const enablingPlan = planSources(enabling, discovered);

  assert.equal(enablingPlan.run[0]?.source.id, "ashby");
  assert.equal(enablingPlan.run[0]?.settings.limit, 10);
  assert.deepEqual(enablingPlan.run[0]?.settings.companies, ["posthog"]);
  assert.deepEqual(enablingPlan.warnings, []);

  assert.ok(
    !planSources(config, sources).warnings.some((warning) => warning.includes('"ashby"')),
    "ashby is implemented, so it must not warn",
  );

  const startups = await withFixtureFetch("ashby", () =>
    collectStartups(
      enabling,
      {
        only: new Set(["ashby"]),
        profile,
        runId: "ashby-test",
      },
      discovered,
    ),
  );

  assert.ok(startups.length > 0, "the collection run should return Ashby jobs");
  assertValidStartups(startups, "ashby");
  assert.ok(startups.every((startup) => startup.source === "ashby"));
});
