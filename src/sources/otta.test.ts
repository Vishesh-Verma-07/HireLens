import assert from "node:assert/strict";
import test from "node:test";
import { assertValidStartups } from "../../test/contract.js";
import { withFixtureFetch } from "../../test/fixtures.js";
import { isTechRole } from "../lib/text.js";
import { normalizeSourceSettings } from "./config.js";
import { fetchOtta, jobIdsFromSitemap } from "./otta.js";

test("otta: recorded fixture parses into valid Startups", async () => {
  const startups = await withFixtureFetch("otta", () => fetchOtta({ limit: 10 }));

  assert.ok(startups.length > 0, "fixture should contain at least one tech role");
  assertValidStartups(startups, "otta");

  for (const startup of startups) {
    assert.match(startup.id, /^otta:[^/\s]+$/);
    assert.equal(startup.source, "otta");
    assert.equal(startup.signals[0]?.type, "hiring");
    assert.ok(isTechRole(startup.oneLiner ?? ""), `${startup.oneLiner} should be technical`);
    assert.doesNotMatch(
      startup.oneLiner ?? "",
      /sales|account executive|account manager|product management/i,
    );
  }
});

test("otta: salary data survives into the description and signal", async () => {
  const startups = await withFixtureFetch("otta", () => fetchOtta({ limit: 10 }));
  const ampersand = startups.find((startup) => startup.id === "otta:frec2-mQ");

  assert.ok(ampersand, "fixture should include the salaried Ampersand role");
  assert.match(ampersand.description ?? "", /Compensation: USD 89,000–205,000/);
  assert.match(ampersand.signals[0]?.text ?? "", /USD 89,000–205,000/);
});

test("otta: results are sorted newest first and respect the limit", async () => {
  const startups = await withFixtureFetch("otta", () => fetchOtta({ limit: 3 }));

  assert.equal(startups.length, 3);
  assertValidStartups(startups, "otta");

  const dates = startups.map((startup) => Date.parse(startup.signals[0]?.date ?? ""));
  assert.deepEqual(
    dates,
    [...dates].sort((left, right) => right - left),
    "jobs should be ordered by their first-live date",
  );
});

test("otta: salaryMin keeps only jobs that can reach the threshold", async () => {
  const startups = await withFixtureFetch("otta", () =>
    fetchOtta({ limit: 100, salaryMin: 200_000 }),
  );

  assert.ok(startups.length > 0, "fixture has roles above 200k");
  assertValidStartups(startups, "otta");
  for (const startup of startups) {
    assert.match(startup.description ?? "", /Compensation: USD /);
  }

  const none = await withFixtureFetch("otta", () =>
    fetchOtta({ limit: 100, salaryMin: 1_000_000 }),
  );
  assert.deepEqual(none, []);
});

test("otta: location narrows the location text, case-insensitively", async () => {
  const remote = await withFixtureFetch("otta", () =>
    fetchOtta({ limit: 100, location: "remote from us" }),
  );

  assert.ok(remote.length > 0, "fixture has remote-US roles");
  assertValidStartups(remote, "otta");
  for (const startup of remote) {
    assert.ok(
      startup.locations.some((location) => /remote from us/i.test(location)),
      `${startup.id} should match the remote-US filter`,
    );
  }

  const nowhere = await withFixtureFetch("otta", () =>
    fetchOtta({ limit: 100, location: "Berlin" }),
  );
  assert.deepEqual(nowhere, []);
});

test("otta: scanLimit resolves only the tail of the sitemap", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  const ids = ["aaa1", "aaa2", "aaa3", "aaa4", "aaa5", "aaa6", "aaa7", "aaa8", "aaa9", "aaa10"];
  const sitemap = [
    "<urlset>",
    ...ids.map((id) => `<url><loc>https://app.otta.com/jobs/${id}</loc></url>`),
    "</urlset>",
  ].join("\n");

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);

    if (url.includes("sitemap")) {
      return new Response(sitemap, {
        status: 200,
        headers: { "content-type": "application/xml" },
      });
    }

    const query = String((JSON.parse(String(init?.body)) as { query?: string }).query ?? "");
    const jobIds = [...query.matchAll(/publicJob\(externalId: "([^"]+)"\)/g)].map(
      (match) => match[1],
    );
    const data: Record<string, unknown> = {};
    jobIds.forEach((id, index) => {
      data[`job${index}`] = {
        externalId: id,
        title: "Software Engineer",
        live: true,
        firstLiveAt: "2026-01-01T00:00:00",
        company: { name: `Company ${id}` },
        function: { value: "Software Engineering" },
      };
    });

    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const startups = await fetchOtta({ limit: 100, scanLimit: 4 });

    assert.equal(
      requested.filter((url) => url.includes("graphql")).length,
      1,
      "four ids fit in one eight-job batch",
    );
    assert.deepEqual(
      startups.map((startup) => startup.id).sort(),
      ["otta:aaa10", "otta:aaa7", "otta:aaa8", "otta:aaa9"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("otta: sitemap parsing keeps job ids and skips companies", () => {
  const xml = [
    "<urlset>",
    "<url><loc>https://app.otta.com/jobs/abc123</loc></url>",
    "<url><loc>https://app.otta.com/companies/Acme</loc></url>",
    "<url><loc>https://app.otta.com/jobs/def456?utm=x</loc></url>",
    "<url><loc>https://app.otta.com/jobs/abc123</loc></url>",
    "</urlset>",
  ].join("\n");

  assert.deepEqual(jobIdsFromSitemap(xml), ["abc123", "def456"]);
});

test("otta: config normalization validates sitemapUrl and scanLimit", () => {
  const invalid = normalizeSourceSettings("otta", {
    sitemapUrl: "not a url",
    scanLimit: -1,
  });

  assert.equal(invalid.settings.sitemapUrl, undefined);
  assert.equal(invalid.settings.scanLimit, undefined);
  assert.ok(invalid.warnings.some((warning) => warning.includes("sitemapUrl")));
  assert.ok(invalid.warnings.some((warning) => warning.includes("scanLimit")));

  const valid = normalizeSourceSettings("otta", {
    sitemapUrl: "https://example.test/sitemap.xml",
    scanLimit: 20,
  });
  assert.equal(valid.settings.sitemapUrl, "https://example.test/sitemap.xml");
  assert.equal(valid.settings.scanLimit, 20);
  assert.deepEqual(valid.warnings, []);
});
