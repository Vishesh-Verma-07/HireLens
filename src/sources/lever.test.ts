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
import { fetchLever } from "./lever.js";

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
 * The `leverdemo` board holds ten postings, only one of which is a technical
 * role; the rest (sales engineer, accountant, customer success, dentist, …) are
 * the tech filter's negative cases.
 */
const TECH_ID = "lever:leverdemo:82fbbecc-5535-466b-a84b-7957cf49e443";

const NON_TECH_IDS = [
  "lever:leverdemo:ad208490-4052-4f91-a57e-433f2d1e484b", // Customer Success Manager
  "lever:leverdemo:7e10ea46-98be-4bd1-a3ca-57d153b25c61", // Sales Engineer
  "lever:leverdemo:d3afdff4-3005-4d29-a548-3b106436eabe", // Senior Sales Engineer
  "lever:leverdemo:5243ea1b-f2c0-4f43-8f02-a5dbb97e24cb", // Staff Accountant
];

/** A Lever posting as the API returns it, with the fields the source reads. */
function posting(
  id: string,
  title: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    text: title,
    hostedUrl: `https://jobs.lever.co/testco/${id}`,
    createdAt: Date.parse("2026-11-01T10:00:00Z"),
    workplaceType: "remote",
    categories: {
      location: "Remote",
      team: "Engineering",
      department: "Engineering",
      allLocations: ["Remote"],
    },
    descriptionPlain: `${title} at Testco.`,
    ...overrides,
  };
}

function fixture(responses: FixtureResponse[]): Fixture {
  return { source: "lever", recordedAt: "2026-11-12T00:00:00Z", responses };
}

function jsonResponse(url: string, body: unknown): FixtureResponse {
  return { url, status: 200, headers: { "content-type": "application/json" }, body };
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

test("lever: recorded fixture parses into valid Startups", async () => {
  const startups = await withFixtureFetch("lever", () =>
    fetchLever({ limit: 10, companies: ["leverdemo"] }),
  );

  assert.ok(startups.length > 0, "the leverdemo board has at least one tech role");
  assertValidStartups(startups, "lever");
  assert.deepEqual(
    startups.map((startup) => startup.id),
    [TECH_ID],
  );
});

test("lever: keeps only tech roles and maps the posting fields", async () => {
  const startups = await withFixtureFetch("lever", () =>
    fetchLever({ limit: 10, companies: ["leverdemo"] }),
  );

  const ids = startups.map((startup) => startup.id);
  for (const nonTech of NON_TECH_IDS) {
    assert.ok(!ids.includes(nonTech), `${nonTech} is not a technical role`);
  }

  const [platform, ...rest] = startups;
  assert.ok(platform, "the platform developer posting should be kept");
  assert.equal(rest.length, 0, "no other leverdemo posting is technical");

  // Lever has no company display name, so the board slug is the name.
  assert.equal(platform.name, "leverdemo");
  assert.equal(platform.oneLiner, "Senior Software Developer, Platform");
  assert.ok(isTechRole(platform.oneLiner ?? ""));
  assert.equal(platform.source, "lever");
  assert.match(platform.id, /^lever:leverdemo:[a-z0-9-]+$/i);
  assert.equal(
    platform.url,
    "https://jobs.lever.co/leverdemo/82fbbecc-5535-466b-a84b-7957cf49e443",
  );
  assert.deepEqual(platform.locations, ["Irvine, CA"]);
  assert.deepEqual(platform.industry, ["Product"], "team is the industry when department is absent");
  assert.equal(platform.remote, true, 'workplaceType "remote" maps to remote: true');
  assert.match(platform.description ?? "", /Demo Job Listing for Lever/);
  assert.ok((platform.description ?? "").length <= 4000);

  for (const startup of startups) {
    for (const signal of startup.signals) {
      assert.equal(signal.type, "hiring");
      assert.match(
        signal.date ?? "",
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        "createdAt epoch ms becomes an ISO 8601 date-time",
      );
      assert.equal(signal.text, `${startup.name} — ${startup.oneLiner}`);
    }
  }

  // The recorded createdAt is epoch ms; the signal must carry the ISO form.
  assert.equal(platform.signals[0]?.date, "2017-01-17T20:29:55.367Z");
});

test("lever: limit caps the run and ids stay unique", async () => {
  const board = fixture([
    jsonResponse("https://api.lever.co/v0/postings/limitco", [
      posting("job-1", "Backend Engineer"),
      posting("job-2", "Frontend Developer"),
      posting("job-3", "Data Engineer"),
    ]),
  ]);

  const startups = await withFixtureFetch(
    "lever",
    () => fetchLever({ limit: 2, companies: ["limitco"] }),
    board,
  );

  assert.equal(startups.length, 2);
  assertValidStartups(startups, "lever");
  assert.deepEqual(
    startups.map((startup) => startup.id),
    ["lever:limitco:job-1", "lever:limitco:job-2"],
  );
  assert.equal(new Set(startups.map((startup) => startup.id)).size, 2);
});

test("lever: the limit is shared across company slugs", async () => {
  const board = fixture([
    jsonResponse("https://api.lever.co/v0/postings/alpha", [
      posting("a-1", "Platform Engineer"),
      posting("a-2", "Site Reliability Engineer"),
      posting("a-3", "Software Engineer"),
    ]),
    jsonResponse("https://api.lever.co/v0/postings/beta", [
      posting("b-1", "Full Stack Developer"),
      posting("b-2", "Machine Learning Engineer"),
    ]),
  ]);

  const startups = await withFixtureFetch(
    "lever",
    () => fetchLever({ limit: 4, companies: ["alpha", "beta"] }),
    board,
  );

  assert.deepEqual(
    startups.map((startup) => startup.id),
    [
      "lever:alpha:a-1",
      "lever:alpha:a-2",
      "lever:alpha:a-3",
      "lever:beta:b-1",
    ],
    "the total stops at 4 and spills over into the next company",
  );
  assertValidStartups(startups, "lever");
});

test("lever: no companies means no request at all", async () => {
  for (const config of [{}, { companies: [] }, { companies: ["   "] }]) {
    const { result, calls } = await withBlockedFetch(() => fetchLever(config));
    assert.deepEqual(result, []);
    assert.equal(calls, 0, "an empty company list must not hit the network");
  }

  // A non-positive limit short-circuits too.
  const { calls } = await withBlockedFetch(() => fetchLever({ limit: 0, companies: ["leverdemo"] }));
  assert.equal(calls, 0);
});

test("lever: a broken company slug is skipped, the rest still load", async () => {
  const recorded = loadFixture("lever");
  const good = recorded.responses[0];
  assert.ok(good);

  const board = fixture([
    {
      url: "https://api.lever.co/v0/postings/broken",
      status: 404,
      headers: { "content-type": "text/plain" },
      body: "Document not found",
    },
    good,
  ]);

  const startups = await withFixtureFetch(
    "lever",
    () => fetchLever({ limit: 10, companies: ["broken", "leverdemo"] }),
    board,
  );

  assert.deepEqual(
    startups.map((startup) => startup.id),
    [TECH_ID],
    "the live company still contributes results",
  );
  assertValidStartups(startups, "lever");

  // A run made only of dead slugs resolves to an empty batch, not a rejection.
  const solo = await withFixtureFetch(
    "lever",
    () => fetchLever({ limit: 10, companies: ["broken"] }),
    board,
  );
  assert.deepEqual(solo, []);
});

test("lever: malformed postings, junk dates and mixed-case slugs are tolerated", async () => {
  const board = fixture([
    jsonResponse("https://api.lever.co/v0/postings/acme", [
      null,
      "not a posting",
      posting("good-1", "Backend Engineer", { createdAt: 1e18 }),
      posting("good-2", "Platform Engineer", { categories: { location: "Remote" } }),
    ]),
  ]);

  // A mixed-case spelling and its lowercase twin must collapse to one board
  // request, and the id must use the normalised slug.
  const startups = await withFixtureFetch(
    "lever",
    () => fetchLever({ limit: 10, companies: ["Acme", " acme "] }),
    board,
  );

  assert.deepEqual(
    startups.map((startup) => startup.id),
    ["lever:acme:good-1", "lever:acme:good-2"],
  );
  assertValidStartups(startups, "lever");
  assert.equal(
    startups[0]?.signals[0]?.date,
    undefined,
    "an out-of-range timestamp is dropped instead of throwing",
  );
  assert.deepEqual(startups[1]?.locations, ["Remote"]);
  assert.deepEqual(startups[1]?.industry, []);

  // `NaN` must not silently disable the cap.
  const capped = await withFixtureFetch(
    "lever",
    () => fetchLever({ limit: Number.NaN, companies: ["acme"] }),
    board,
  );
  assert.equal(capped.length, 2);
});

test("lever: enabled in config and collected through the registry", async () => {
  const sources = await discoverSources();
  const discovered = sources.filter((source) => source.id === "lever");

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.file, "lever.ts");

  const fileConfig = loadSourceConfig(CONFIG_PATH);
  assert.ok(
    !planSources(fileConfig, sources).warnings.some((warning) =>
      warning.includes('"lever"'),
    ),
    "lever is implemented, so it must not warn",
  );

  const enabled: SourceConfig = {
    sources: { lever: { enabled: true, companies: ["leverdemo"], limit: 10 } },
  };
  const planned = planSources(enabled, discovered);

  assert.equal(planned.run[0]?.source.id, "lever");
  assert.equal(planned.run[0]?.settings.enabled, true);
  assert.equal(planned.run[0]?.settings.limit, 10);
  assert.deepEqual(planned.run[0]?.settings.companies, ["leverdemo"]);

  const startups = await withFixtureFetch("lever", () =>
    collectStartups(
      enabled,
      { only: new Set(["lever"]), profile, runId: "lever-test" },
      discovered,
    ),
  );

  assert.ok(startups.length > 0, "the collection run should return Lever jobs");
  assertValidStartups(startups, "lever");
  assert.ok(startups.every((startup) => startup.source === "lever"));
});

test("lever: enabled:false removes the source from the plan", async () => {
  const disabled: SourceConfig = {
    sources: { lever: { enabled: false, companies: ["leverdemo"] } },
  };

  const sources = await discoverSources();
  const plan = planSources(disabled, sources);
  assert.equal(
    plan.run.some((entry) => entry.source.id === "lever"),
    false,
  );
});
