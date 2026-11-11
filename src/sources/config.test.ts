import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { collectStartups, loadSourceConfig } from "./index.js";
import { planSources, type SourceConfig } from "./registry.js";
import type { DiscoveredSource } from "./types.js";
import type { Profile, SourceId, Startup } from "../types.js";
import { SOURCE_IDS } from "../types.js";

const CONFIG_PATH = resolve(import.meta.dirname, "../../config/sources.yaml");

/** The 19 ids added by Ticket 03. `satisfies` keeps this list honest. */
const NEW_SOURCE_IDS = [
  "wellfound",
  "otta",
  "workatastartup",
  "himalayas",
  "weworkremotely",
  "remoteco",
  "jobspresso",
  "tldr_jobs",
  "bytebytego",
  "indiehackers",
  "ai_jobs_net",
  "climatebase",
  "web3_career",
  "devrel_careers",
  "naukri",
  "cutshort",
  "greenhouse",
  "lever",
  "ashby",
] as const satisfies readonly SourceId[];

/** New sources that ship enabled in `config/sources.yaml`. */
const ENABLED_NEW_SOURCE_IDS = new Set<string>([
  "wellfound",
  "otta",
  "workatastartup",
  "himalayas",
  "weworkremotely",
  "remoteco",
  "jobspresso",
  "tldr_jobs",
  "ai_jobs_net",
  "climatebase",
  "web3_career",
  "devrel_careers",
]);

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

/** A registry containing every known id, so config tests never need modules. */
const ALL_SOURCES: DiscoveredSource[] = SOURCE_IDS.map((id) => ({
  id,
  fetch: async (): Promise<Startup[]> => [],
  file: `${id}.ts`,
}));

function settingsFor(config: SourceConfig, id: SourceId) {
  return planSources(config, ALL_SOURCES).run.find((entry) => entry.source.id === id)
    ?.settings;
}

test("SourceId covers the 19 planned sources without duplicates", () => {
  assert.equal(new Set(SOURCE_IDS).size, SOURCE_IDS.length);
  assert.equal(NEW_SOURCE_IDS.length, 19);

  for (const id of NEW_SOURCE_IDS) {
    assert.ok(SOURCE_IDS.includes(id), `SourceId is missing "${id}"`);
  }

  for (const id of ["yc", "hn", "funding", "producthunt", "remoteok", "remotive", "arbeitnow", "internshala", "unstop", "google"]) {
    assert.ok(SOURCE_IDS.includes(id as SourceId), `SourceId lost existing id "${id}"`);
  }
});

test("config/sources.yaml has exactly one block per known source", () => {
  const config = loadSourceConfig(CONFIG_PATH);
  const blocks = Object.keys(config.sources ?? {}).sort();

  assert.deepEqual(blocks, [...SOURCE_IDS].sort());

  for (const id of NEW_SOURCE_IDS) {
    assert.ok(config.sources?.[id] !== undefined, `sources.yaml is missing "${id}"`);
  }
});

test("loadSourceConfig parses the extended YAML structure", () => {
  const config = loadSourceConfig(CONFIG_PATH);

  assert.equal(config.sources?.wellfound?.limit, 100);
  assert.deepEqual(config.sources?.wellfound?.categories, [
    "engineering",
    "product",
    "design",
  ]);
  assert.equal(config.sources?.himalayas?.remoteOnly, true);
  assert.equal(
    config.sources?.weworkremotely?.feedUrl,
    "https://weworkremotely.com/categories/remote-programming-jobs.rss",
  );
  assert.deepEqual(config.sources?.naukri?.categories, ["it-software", "engineering"]);
  assert.deepEqual(config.sources?.greenhouse?.companies, ["stripe", "airtable", "notion"]);
});

test("existing sources stay configurable through the same YAML", () => {
  const config = loadSourceConfig(CONFIG_PATH);

  assert.equal(config.sources?.remoteok?.limit, 100);
  assert.equal(config.sources?.remotive?.limit, 60);
  assert.equal(config.sources?.internshala?.limit, 120);
  assert.equal(config.sources?.google?.limit, 20);

  const overridden = settingsFor(
    { sources: { remoteok: { limit: 5 } } },
    "remoteok",
  );
  assert.equal(overridden?.limit, 5);
});

test("planSources recognizes every new source name without warnings", () => {
  const config = loadSourceConfig(CONFIG_PATH);
  const { run, warnings } = planSources(config, ALL_SOURCES);
  const running = new Set(run.map((entry) => entry.source.id));

  assert.deepEqual(warnings, []);

  for (const id of NEW_SOURCE_IDS) {
    assert.equal(
      running.has(id),
      ENABLED_NEW_SOURCE_IDS.has(id),
      `${id} should ${ENABLED_NEW_SOURCE_IDS.has(id) ? "" : "not "}run by default`,
    );
  }
});

test("missing required fields fall back to sensible new-source defaults", () => {
  const config = {
    sources: {
      himalayas: {},
      weworkremotely: {},
      tldr_jobs: {},
      greenhouse: {},
      naukri: {},
    },
  } as unknown as SourceConfig;

  const himalayas = settingsFor(config, "himalayas");
  assert.equal(himalayas?.limit, 100);
  assert.equal(himalayas?.remoteOnly, true);

  const weworkremotely = settingsFor(config, "weworkremotely");
  assert.equal(weworkremotely?.limit, 100);
  assert.equal(
    weworkremotely?.feedUrl,
    "https://weworkremotely.com/categories/remote-programming-jobs.rss",
  );

  const tldr = settingsFor(config, "tldr_jobs");
  assert.equal(tldr?.limit, 50);
  assert.equal(tldr?.feedUrl, "https://tldr.tech/jobs/rss");

  const greenhouse = settingsFor(config, "greenhouse");
  assert.deepEqual(greenhouse?.companies, ["stripe", "airtable", "notion"]);

  const naukri = settingsFor(config, "naukri");
  assert.deepEqual(naukri?.categories, ["it-software", "engineering"]);
});

test("malformed new-source settings warn and fall back instead of crashing", () => {
  const config = {
    sources: {
      himalayas: { limit: -5, remoteOnly: "yes" },
      greenhouse: { companies: "stripe" },
      weworkremotely: { feedUrl: "not a url" },
      wellfound: { categories: [1, 2] },
    },
  } as unknown as SourceConfig;

  const { run, warnings } = planSources(config, ALL_SOURCES);
  const byId = new Map(run.map((entry) => [entry.source.id, entry.settings]));

  assert.equal(byId.get("himalayas")?.limit, 100);
  assert.equal(byId.get("himalayas")?.remoteOnly, true);
  assert.deepEqual(byId.get("greenhouse")?.companies, ["stripe", "airtable", "notion"]);
  assert.equal(
    byId.get("weworkremotely")?.feedUrl,
    "https://weworkremotely.com/categories/remote-programming-jobs.rss",
  );
  assert.deepEqual(byId.get("wellfound")?.categories, [
    "engineering",
    "product",
    "design",
  ]);

  for (const field of ["limit", "remoteOnly", "companies", "feedUrl", "categories"]) {
    assert.ok(
      warnings.some((warning) => warning.includes(field)),
      `expected a warning about ${field}`,
    );
  }
});

test("configured sources with no module yet warn without crashing", () => {
  const { run, warnings } = planSources(
    { sources: { wellfound: { enabled: true } } },
    [],
  );

  assert.deepEqual(run, []);
  assert.ok(
    warnings.some(
      (warning) => warning.includes('"wellfound"') && warning.includes("not implemented"),
    ),
  );
});

test("source selection (the want() replacement) accepts new source names", () => {
  const config = loadSourceConfig(CONFIG_PATH);

  const enabled = planSources(config, ALL_SOURCES, new Set(["wellfound", "otta"]));
  assert.deepEqual(
    enabled.run.map((entry) => entry.source.id).sort(),
    ["otta", "wellfound"],
  );
  assert.deepEqual(enabled.warnings, []);

  // `only` also selects sources that ship disabled in the YAML.
  const disabledByDefault = planSources(
    {},
    ALL_SOURCES,
    new Set(["greenhouse", "naukri"]),
  );
  assert.deepEqual(
    disabledByDefault.run.map((entry) => entry.source.id).sort(),
    ["greenhouse", "naukri"],
  );

  const unknown = planSources({}, ALL_SOURCES, new Set(["not_a_source"]));
  assert.ok(unknown.warnings.some((warning) => warning.includes("not_a_source")));
});

test("collectStartups runs a new source selected with only", async () => {
  const sources: DiscoveredSource[] = [
    {
      id: "wellfound",
      fetch: async () => [
        {
          id: "wellfound:1",
          name: "Acme",
          locations: [],
          industry: [],
          source: "wellfound",
          signals: [],
        },
      ],
      file: "wellfound.ts",
    },
  ];

  const result = await collectStartups(
    {},
    { only: new Set(["wellfound"]), profile },
    sources,
  );

  assert.deepEqual(result.map((job) => job.id), ["wellfound:1"]);
});

test("loadSourceConfig rejects a non-mapping YAML root", () => {
  const directory = mkdtempSync(join(tmpdir(), "jobfinder-config-"));

  try {
    const path = join(directory, "sources.yaml");
    writeFileSync(path, "- wellfound\n- otta\n");
    assert.throws(() => loadSourceConfig(path), /must be a YAML mapping/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
