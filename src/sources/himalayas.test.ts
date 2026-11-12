import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { isTechRole } from "../lib/text.js";
import type { Profile, Startup } from "../types.js";
import { assertValidStartups } from "../../test/contract.js";
import { withFixtureFetch, type Fixture } from "../../test/fixtures.js";
import { fetchHimalayas, jobIdFromGuid } from "./himalayas.js";
import { collectStartups, loadSourceConfig } from "./index.js";
import { discoverSources, planSources } from "./registry.js";

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

/** Categories are kept as industry tags, so check title + tags together. */
function isTechStartup(startup: Startup): boolean {
  return isTechRole(`${startup.oneLiner ?? ""} ${startup.industry.join(" ")}`);
}

function searchResponse(jobs: unknown[]): Fixture {
  return {
    source: "himalayas",
    recordedAt: "2026-11-12T00:00:00Z",
    responses: [
      {
        url: "https://himalayas.app/jobs/api/search?q=engineer&sort=recent&page=1",
        status: 200,
        headers: { "content-type": "application/json" },
        body: { jobs },
      },
    ],
  };
}

test("himalayas: recorded fixture parses into valid Startups", async () => {
  const startups = await withFixtureFetch("himalayas", () =>
    fetchHimalayas({ limit: 10 }),
  );

  assert.equal(startups.length, 10);
  assertValidStartups(startups, "himalayas");

  for (const startup of startups) {
    assert.match(startup.id, /^himalayas:[^\s/]+\/[^\s/]+$/);
    assert.equal(startup.source, "himalayas");
    assert.equal(startup.remote, true);
    assert.equal(startup.signals[0]?.type, "hiring");
    assert.ok(startup.locations.includes("Remote"));
    assert.ok(startup.url?.startsWith("https://"));
    assert.ok(
      isTechStartup(startup),
      `${startup.oneLiner} (${startup.industry.join(", ")}) should be a tech role`,
    );
  }
});

test("himalayas: respects the configured limit", async () => {
  const startups = await withFixtureFetch("himalayas", () =>
    fetchHimalayas({ limit: 3 }),
  );

  assert.equal(startups.length, 3);
  assertValidStartups(startups, "himalayas");
});

test("himalayas: maps fields, drops non-tech roles, and honours remoteOnly", async () => {
  const fixture = searchResponse([
    {
      title: "Senior Backend Engineer",
      companyName: " Acme ",
      companySlug: "acme",
      guid: "https://himalayas.app/companies/acme/jobs/senior-backend-engineer",
      locationRestrictions: ["India"],
      minSalary: 120000,
      maxSalary: 150000,
      currency: "USD",
      employmentType: "Full Time",
      seniority: ["Senior"],
      categories: ["Backend-Engineer", "API-Developer"],
      parentCategories: ["Developer"],
      description: "<p>Build and operate public APIs.</p>",
      pubDate: 1794453535,
      applicationLink:
        "https://himalayas.app/companies/acme/jobs/senior-backend-engineer?utm_source=api",
    },
    {
      title: "Account Executive",
      companyName: "Acme",
      companySlug: "acme",
      guid: "https://himalayas.app/companies/acme/jobs/account-executive",
      categories: ["Account-Executive"],
      parentCategories: ["Sales"],
      pubDate: 1794453530,
    },
    {
      title: "Hybrid Platform Engineer",
      excerpt: "This is a hybrid role based in Berlin.",
      companyName: "Beta",
      companySlug: "beta",
      guid: "https://himalayas.app/companies/beta/jobs/hybrid-platform-engineer",
      categories: ["Platform-Engineer"],
      parentCategories: ["Developer"],
      pubDate: 1794453525,
    },
    {
      title: "Hybrid Cloud Engineer",
      companyName: "Epsilon",
      companySlug: "epsilon",
      guid: "https://himalayas.app/companies/epsilon/jobs/hybrid-cloud-engineer",
      categories: ["Cloud-Engineer"],
      parentCategories: ["Developer"],
      pubDate: 1794453518,
    },
    {
      title: "Software Developer",
      companyName: "Gamma",
      companySlug: "gamma",
      locationRestrictions: [],
      categories: ["Software-Developer"],
      description: "Small product team.",
      pubDate: 1794453520,
    },
    {
      title: "Customer Success Manager",
      companyName: "Delta",
      companySlug: "delta",
      guid: "https://himalayas.app/companies/delta/jobs/customer-success-manager",
      categories: ["Customer-Success-Manager"],
      parentCategories: ["Customer Service"],
      pubDate: 1794453515,
    },
  ]);

  const remoteOnly = await withFixtureFetch(
    "himalayas",
    () => fetchHimalayas({ limit: 10 }),
    fixture,
  );

  assert.deepEqual(
    remoteOnly.map((startup) => startup.id),
    [
      "himalayas:acme/senior-backend-engineer",
      "himalayas:gamma/software-developer",
      "himalayas:epsilon/hybrid-cloud-engineer",
    ],
    "sales, customer-success, and the hybrid-role listing must be filtered out",
  );

  const [backend, developer, cloudEngineer] = remoteOnly;
  assert.equal(backend?.name, "Acme");
  assert.equal(backend?.oneLiner, "Senior Backend Engineer");
  assert.deepEqual(backend?.locations, ["Remote", "India"]);
  assert.equal(backend?.remote, true);
  assert.ok(backend?.industry.includes("Developer"));
  assert.ok(backend?.industry.includes("Backend Engineer"));
  assert.match(backend?.description ?? "", /^Compensation: USD 120,000–150,000/);
  assert.match(backend?.description ?? "", /Employment type: Full Time/);
  assert.match(backend?.description ?? "", /Seniority: Senior/);
  assert.match(backend?.description ?? "", /Build and operate public APIs\./);
  assert.equal(
    backend?.signals[0]?.date,
    new Date(1794453535 * 1000).toISOString(),
  );
  assert.equal(
    backend?.url,
    "https://himalayas.app/companies/acme/jobs/senior-backend-engineer?utm_source=api",
  );

  // With no location restrictions the role is remote worldwide; the guid-less
  // fallback id uses the company slug plus a slugified title.
  assert.deepEqual(developer?.locations, ["Remote"]);
  assert.equal(developer?.id, "himalayas:gamma/software-developer");

  // "Hybrid cloud" is a technology, not a work arrangement, so it is remote.
  assert.equal(cloudEngineer?.id, "himalayas:epsilon/hybrid-cloud-engineer");
  assert.equal(cloudEngineer?.remote, true);

  const allRoles = await withFixtureFetch(
    "himalayas",
    () => fetchHimalayas({ limit: 10, remoteOnly: false }),
    fixture,
  );

  const hybrid = allRoles.find(
    (startup) => startup.id === "himalayas:beta/hybrid-platform-engineer",
  );
  assert.ok(hybrid, "remoteOnly: false should keep the hybrid listing");
  assert.equal(hybrid?.remote, undefined);
  assert.ok(
    allRoles.some((startup) => startup.id === "himalayas:epsilon/hybrid-cloud-engineer"),
    "the hybrid-cloud role is technical and remote in both modes",
  );
  assert.ok(
    allRoles.every((startup) => startup.id !== "himalayas:acme/account-executive"),
    "non-technical roles stay filtered even without remoteOnly",
  );
});

test("himalayas: jobIdFromGuid prefers the stable guid path", () => {
  assert.equal(
    jobIdFromGuid({
      guid: "https://himalayas.app/companies/linear/jobs/senior-product-engineer?utm=x",
    }),
    "linear/senior-product-engineer",
  );
  assert.equal(
    jobIdFromGuid({ companySlug: "acme", title: "Senior Backend Engineer" }),
    "acme/senior-backend-engineer",
  );
  assert.equal(jobIdFromGuid({ title: "No company" }), undefined);
});

test("himalayas: source is registered and obeys enabled/limit/remoteOnly config", async () => {
  const sources = await discoverSources();
  const discovered = sources.filter((source) => source.id === "himalayas");

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.file, "himalayas.ts");

  const enabled = planSources(
    { sources: { himalayas: { enabled: true, limit: 10, remoteOnly: false } } },
    discovered,
  );
  assert.equal(enabled.run[0]?.source.id, "himalayas");
  assert.equal(enabled.run[0]?.settings.limit, 10);
  assert.equal(enabled.run[0]?.settings.remoteOnly, false);

  const disabled = planSources(
    { sources: { himalayas: { enabled: false } } },
    discovered,
  );
  assert.deepEqual(disabled.run, []);
});

test("himalayas: enabled in sources.yaml and collected through the registry", async () => {
  const sources = await discoverSources();
  const discovered = sources.filter((source) => source.id === "himalayas");
  const config = loadSourceConfig(CONFIG_PATH);

  const planned = planSources(config, discovered);
  assert.equal(planned.run[0]?.source.id, "himalayas");
  assert.equal(planned.run[0]?.settings.limit, 100);
  assert.equal(planned.run[0]?.settings.remoteOnly, true);

  const startups = await withFixtureFetch("himalayas", () =>
    collectStartups(
      config,
      {
        only: new Set(["himalayas"]),
        profile,
        runId: "himalayas-test",
      },
      discovered,
    ),
  );

  assert.ok(startups.length > 0, "the collection run should return Himalayas jobs");
  assertValidStartups(startups, "himalayas");
  assert.ok(startups.every((startup) => startup.source === "himalayas"));
});
