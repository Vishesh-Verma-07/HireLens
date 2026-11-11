import assert from "node:assert/strict";
import test from "node:test";
import { assertValidStartups } from "../../test/contract.js";
import { withFixtureFetch } from "../../test/fixtures.js";
import { fetchWellfound } from "./wellfound.js";

/**
 * Minimal `__NEXT_DATA__` payload with the same shape Wellfound's role pages
 * render: an Apollo cache where startups reference their highlighted jobs.
 */
const FIXTURE_HTML = (() => {
  const data = {
    props: {
      pageProps: {
        role: "software-engineer",
        apolloState: {
          data: {
            ROOT_QUERY: {
              talent: {
                'seoLandingPageJobSearchResults({"page":1,"remote":true,"role":"software-engineer"})':
                  {
                    pageCount: 1,
                    startups: [{ __ref: "StartupResult:1" }],
                  },
              },
            },
            "StartupResult:1": {
              name: "Acme",
              companySize: "SIZE_11_50",
              badges: [{ __ref: "Badge:COMPANY_STAGE-1" }],
              highlightedJobListings: [
                { __ref: "JobListingSearchResult:11" },
                { __ref: "JobListingSearchResult:12" },
              ],
            },
            "Badge:COMPANY_STAGE-1": { data: "early_stage", label: "Early Stage" },
            "JobListingSearchResult:11": {
              id: "11",
              title: "Backend Engineer",
              slug: "backend-engineer",
              primaryRoleTitle: "Engineering",
              locationNames: ["Remote", "Remote"],
              remote: true,
              remoteConfig: { kind: "REMOTE" },
              compensation: "$100k",
              liveStartAt: 1_793_169_764,
              description: "Build things.",
            },
            "JobListingSearchResult:12": {
              id: "12",
              title: "Sales Manager",
              slug: "sales-manager",
            },
          },
        },
      },
    },
  };

  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    data,
  )}</script></body></html>`;
})();

test("wellfound: maps a role page, filtering non-tech roles", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(input));
    return new Response(FIXTURE_HTML, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;

  try {
    const startups = await fetchWellfound({ limit: 10, categories: ["engineering"] });

    // The friendly config alias resolves to Wellfound's own role slug.
    assert.equal(
      requested[0],
      "https://wellfound.com/role/r/software-engineer?page=1",
    );

    assert.equal(startups.length, 1);
    assertValidStartups(startups, "wellfound");

    const job = startups[0];
    assert.equal(job?.id, "wellfound:11");
    assert.equal(job?.name, "Acme");
    assert.equal(job?.oneLiner, "Backend Engineer");
    assert.equal(job?.url, "https://wellfound.com/jobs/11-backend-engineer");
    assert.deepEqual(job?.locations, ["Remote"]);
    assert.equal(job?.remote, true);
    assert.equal(job?.stage, "seed");
    assert.equal(job?.employees, "11-50");
    assert.deepEqual(job?.industry, ["Engineering"]);
    assert.match(job?.description ?? "", /Build things\./);
    assert.match(job?.description ?? "", /Compensation: \$100k/);
    assert.equal(
      job?.signals[0]?.date,
      new Date(1_793_169_764 * 1000).toISOString(),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("wellfound: recorded fixture parses into valid Startups", async () => {
  const startups = await withFixtureFetch("wellfound", () =>
    fetchWellfound({ limit: 10, categories: ["engineering"] }),
  );

  assert.ok(startups.length > 0, "fixture should contain at least one tech role");
  assertValidStartups(startups, "wellfound");

  for (const startup of startups) {
    assert.match(startup.id, /^wellfound:\d+$/);
    assert.equal(startup.source, "wellfound");
    assert.equal(startup.signals[0]?.type, "hiring");
    assert.ok(startup.oneLiner && startup.oneLiner.length > 0);
  }

  // The shared tech-role filter drops sales/recruiting postings.
  assert.ok(
    startups.every(
      (startup) => !/sales|account executive|recruiter/i.test(startup.oneLiner ?? ""),
    ),
  );
});

test("wellfound: respects the configured limit", async () => {
  const startups = await withFixtureFetch("wellfound", () =>
    fetchWellfound({ limit: 3, categories: ["software-engineer"] }),
  );

  assert.equal(startups.length, 3);
  assertValidStartups(startups, "wellfound");
});

test("wellfound: skips a category whose page is a different role", async () => {
  // The recorded page is for software-engineer, so a design request is not
  // allowed to misattribute those jobs to the design category.
  const startups = await withFixtureFetch("wellfound", () =>
    fetchWellfound({ limit: 10, categories: ["design"] }),
  );

  assert.deepEqual(startups, []);
});

test("wellfound: no categories falls back to the default engineering role", async () => {
  const startups = await withFixtureFetch("wellfound", () =>
    fetchWellfound({ limit: 2 }),
  );

  assert.equal(startups.length, 2);
  assertValidStartups(startups, "wellfound");
});
