import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { assertValidStartups } from "../../test/contract.js";
import { withFixtureFetch } from "../../test/fixtures.js";
import { isTechRole } from "../lib/text.js";
import type { Profile } from "../types.js";
import { collectStartups, discoverSources, loadSourceConfig, planSources, type SourceConfig, type SourceSettings } from "./index.js";
import { fetchAiJobs, LISTING_URL } from "./aijobs.js";

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
 * The recorded fixture holds listing page 1 plus the ten detail pages the source
 * fetched for `limit: 10`. Details are one request apiece, so tests must never
 * ask for more roles than were recorded.
 */
const RECORDED_JOBS = 10;

/** Runs `run` with `fetch` replaced by a stub that fails on any request. */
async function withBlockedFetch<T>(run: () => Promise<T>): Promise<{ result: T; calls: number }> {
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

test("ai_jobs_net: recorded fixture parses into valid Startups", async () => {
  const startups = await withFixtureFetch("ai_jobs_net", () => fetchAiJobs({ limit: RECORDED_JOBS }));

  assert.equal(startups.length, RECORDED_JOBS);
  assertValidStartups(startups, "ai_jobs_net");

  const first = startups[0];
  assert.equal(first?.source, "ai_jobs_net");
  assert.match(first?.id ?? "", /^ai_jobs_net:\d+$/);
  assert.equal(first?.name, "Electronic Arts");
  assert.equal(first?.oneLiner, "Senior Software Engineer I");
  assert.equal(
    first?.url,
    "https://foorilla.com/hiring/jobs/senior-software-engineer-i-locations-hyderabad-telangana-india-4124346/",
  );
  assert.equal(first?.signals[0]?.type, "hiring");
  assert.match(first?.signals[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}T/);

  const ids = startups.map((startup) => startup.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique within a run");
});

test("ai_jobs_net: keeps tech roles only and honours the limit", async () => {
  const { all, limited } = await withFixtureFetch("ai_jobs_net", async () => ({
    all: await fetchAiJobs({ limit: RECORDED_JOBS }),
    limited: await fetchAiJobs({ limit: 3 }),
  }));

  for (const startup of all) {
    assert.ok(
      isTechRole(startup.oneLiner ?? ""),
      `"${startup.oneLiner}" should be a tech role`,
    );
  }

  // The fixture holds no detail page for the listing's non-technical rows, so a
  // missing tech filter would make the replay fail on an unrecorded URL.
  assert.equal(limited.length, 3);
  assertValidStartups(limited, "ai_jobs_net");
  assert.deepEqual(
    limited.map((startup) => startup.id),
    all.slice(0, 3).map((startup) => startup.id),
  );
});

test("ai_jobs_net: preserves skills, seniority, salary, location, remote and date", async () => {
  const startups = await withFixtureFetch("ai_jobs_net", () =>
    fetchAiJobs({ limit: RECORDED_JOBS }),
  );

  for (const startup of startups) {
    assert.ok(startup.locations.length > 0, `${startup.id} should have a location`);
    assert.ok((startup.description ?? "").includes("Skills:"), `${startup.id} should list skills`);
    assert.ok(startup.industry.length > 0, `${startup.id} should carry its topics/skills`);
    assert.match(
      startup.signals[0]?.date ?? "",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      "the detail page's Published date becomes an ISO date-time",
    );
  }

  const sage = startups.find((startup) => startup.id === "ai_jobs_net:4124349");
  assert.ok(sage, "the Sage posting should be kept");
  assert.equal(sage.name, "Sage");
  assert.deepEqual(sage.locations, ["London, United Kingdom", "Remote"]);
  assert.equal(sage.remote, true);
  assert.match(sage.description ?? "", /Compensation: GBP 60K-70K/);
  assert.match(sage.description ?? "", /Seniority: Senior-level \/ Expert/);
  assert.ok(sage.industry.includes("Large Language Models"));

  // An onsite role keeps its city, earns no remote flag from the board's
  // hybrid `[WH]` marker, and still reports its mid-level tag.
  const harman = startups.find((startup) => startup.id === "ai_jobs_net:4124348");
  assert.ok(harman, "the HARMAN posting should be kept");
  assert.deepEqual(harman.locations, ["Bucharest - Bucharest, Romania"]);
  assert.equal(harman.remote, undefined);
  assert.match(harman.description ?? "", /Seniority: Mid-level \/ Intermediate/);
  assert.match(harman.description ?? "", /Experience: ~3 years/);
  assert.match(harman.description ?? "", /Compensation: RON 202K-297K/);

  assert.ok(
    startups.some((startup) => startup.remote === true),
    "the fixture should contain at least one remote posting",
  );
  assert.ok(
    startups.every((startup) => (startup.description ?? "").length <= 4000),
    "descriptions stay within the 4000-character cap",
  );
});

test("ai_jobs_net: requests the HTMX listing partial with hx-request", async () => {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];

  const startups = await withFixtureFetch("ai_jobs_net", async () => {
    const replay = globalThis.fetch;
    globalThis.fetch = ((input, init) => {
      requests.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        headers: { ...(init?.headers as Record<string, string> | undefined) },
      });
      return replay(input, init);
    }) as typeof fetch;

    try {
      return await fetchAiJobs({ limit: 1 });
    } finally {
      globalThis.fetch = replay;
    }
  });

  assert.equal(requests[0]?.url, LISTING_URL);
  // Without this header the board answers with its JS shell and no job rows.
  assert.equal(requests[0]?.headers["hx-request"], "true");
  assert.equal(requests.length, 2, "one listing request plus one detail request");
  assertValidStartups(startups, "ai_jobs_net");
});

test("ai_jobs_net: a non-positive limit skips the network entirely", async () => {
  for (const config of [{ limit: 0 }, { limit: -5 }]) {
    const { result, calls } = await withBlockedFetch(() => fetchAiJobs(config));
    assert.deepEqual(result, []);
    assert.equal(calls, 0, "a non-positive limit must not hit the network");
  }
});

test("ai_jobs_net: is discovered, planned, and collected when enabled in YAML", async () => {
  const sources = await discoverSources();
  const discovered = sources.filter((source) => source.id === "ai_jobs_net");

  assert.equal(discovered.length, 1, "the source module is auto-discovered");
  assert.equal(discovered[0]?.file, "aijobs.ts");

  const config = loadSourceConfig(CONFIG_PATH);
  const planned = planSources(config, discovered);

  assert.equal(planned.run[0]?.source.id, "ai_jobs_net");
  assert.equal(planned.run[0]?.settings.enabled, true);
  assert.equal(planned.run[0]?.settings.limit, 60);
  assert.ok(
    !planSources(config, sources).warnings.some((warning) => warning.includes('"ai_jobs_net"')),
    "ai_jobs_net is implemented, so it must not warn",
  );

  // The real config asks for 60 roles, which would need 60 unrecorded detail
  // pages; replay the same block with the limit the fixture was recorded at.
  const replayable: SourceConfig = {
    sources: {
      ...(config.sources as Record<string, SourceSettings> | undefined),
      ai_jobs_net: { enabled: true, limit: RECORDED_JOBS },
    },
  };

  const startups = await withFixtureFetch("ai_jobs_net", () =>
    collectStartups(
      replayable,
      { only: new Set(["ai_jobs_net"]), profile, runId: "ai-jobs-net-test" },
      discovered,
    ),
  );

  assert.ok(startups.length > 0, "the collection run should return ai-jobs.net jobs");
  assertValidStartups(startups, "ai_jobs_net");
  assert.ok(startups.every((startup) => startup.source === "ai_jobs_net"));
});

test("ai_jobs_net: enabled:false removes the source from the plan", async () => {
  const disabled: SourceConfig = {
    sources: { ai_jobs_net: { enabled: false } },
  };

  const sources = await discoverSources();
  const plan = planSources(disabled, sources);
  assert.equal(
    plan.run.some((entry) => entry.source.id === "ai_jobs_net"),
    false,
  );
});
