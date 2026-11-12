import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { collectStartups, loadSourceConfig } from "./index.js";
import {
  discoverSources,
  planSources,
  type SourceConfig,
} from "./registry.js";
import type { DiscoveredSource, SourceFetch } from "./types.js";
import type { Profile, SourceId, Startup } from "../types.js";

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

function startup(id: string, source: SourceId): Startup {
  return {
    id,
    name: "Acme",
    locations: [],
    industry: [],
    source,
    signals: [],
  };
}

function fakeSource(id: SourceId, fetch: SourceFetch): DiscoveredSource {
  return { id, fetch, file: `${id}.ts` };
}

test("discovers every built-in source without editing index.ts", async () => {
  const sources = await discoverSources();

  assert.deepEqual(
    sources.map((source) => source.id).sort(),
    [
      "arbeitnow",
      "funding",
      "google",
      "greenhouse",
      "himalayas",
      "hn",
      "internshala",
      "jobspresso",
      "lever",
      "otta",
      "producthunt",
      "remoteco",
      "remoteok",
      "remotive",
      "unstop",
      "wellfound",
      "weworkremotely",
      "workatastartup",
      "yc",
    ],
  );

  for (const source of sources) {
    assert.equal(typeof source.fetch, "function", `${source.id} must expose fetch`);
  }
});

test("config/sources.yaml enables otta in a real collection plan", async () => {
  const config = loadSourceConfig(
    resolve(import.meta.dirname, "../../config/sources.yaml"),
  );
  const sources = await discoverSources();
  const plan = planSources(config, sources);

  assert.ok(
    plan.run.some((entry) => entry.source.id === "otta"),
    "sources.yaml has otta enabled, so the plan must include it",
  );
  assert.ok(
    !plan.warnings.some((warning) => warning.includes('"otta"')),
    "otta is implemented, so it must not warn",
  );
});

test("config/sources.yaml enables weworkremotely in a real collection plan", async () => {
  const config = loadSourceConfig(
    resolve(import.meta.dirname, "../../config/sources.yaml"),
  );
  const sources = await discoverSources();
  const plan = planSources(config, sources);
  const planned = plan.run.find((entry) => entry.source.id === "weworkremotely");

  assert.ok(planned, "sources.yaml has weworkremotely enabled, so the plan must include it");
  assert.equal(planned.settings.limit, 100);
  assert.equal(
    planned.settings.feedUrl,
    "https://weworkremotely.com/categories/remote-programming-jobs.rss",
  );
  assert.ok(
    !plan.warnings.some((warning) => warning.includes('"weworkremotely"')),
    "weworkremotely is implemented, so it must not warn",
  );

  const disabled = planSources(
    { sources: { weworkremotely: { enabled: false } } },
    sources,
  );
  assert.equal(
    disabled.run.some((entry) => entry.source.id === "weworkremotely"),
    false,
    "enabled: false must keep the source out of the run",
  );
});

test("auto-discovers a dropped-in module and ignores helpers/tests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jobfinder-sources-"));

  try {
    writeFileSync(
      join(directory, "alpha.mjs"),
      [
        'export const sourceId = "alpha";',
        "export async function fetchAlpha() { return []; }",
      ].join("\n"),
    );
    writeFileSync(
      join(directory, "helper.mjs"),
      "export async function fetchHelper() { return []; }",
    );
    writeFileSync(
      join(directory, "broken.mjs"),
      'export const sourceId = "broken";',
    );
    writeFileSync(
      join(directory, "ignored.test.mjs"),
      'throw new Error("test files must not be imported");',
    );

    const sources = await discoverSources(directory);

    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.id, "alpha");
    assert.equal(sources[0]?.file, "alpha.mjs");
    assert.deepEqual(await sources[0]?.fetch({}, { profile }), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("skips duplicate source ids instead of running both", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jobfinder-sources-"));

  try {
    for (const file of ["one.mjs", "two.mjs"]) {
      writeFileSync(
        join(directory, file),
        [
          'export const sourceId = "duplicate";',
          "export async function fetchDuplicate() { return []; }",
        ].join("\n"),
      );
    }

    const sources = await discoverSources(directory);
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.id, "duplicate");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("planSources filters disabled and unselected sources", async () => {
  const sources = await discoverSources();

  const only = planSources({}, sources, new Set(["remoteok"]));
  assert.deepEqual(only.run.map((entry) => entry.source.id), ["remoteok"]);
  assert.deepEqual(only.warnings, []);

  const disabled = planSources(
    { sources: { remoteok: { enabled: false } } },
    sources,
  );
  assert.equal(
    disabled.run.some((entry) => entry.source.id === "remoteok"),
    false,
  );

  const configured = planSources(
    { sources: { remoteok: { limit: 5 } } },
    sources,
  );
  assert.equal(
    configured.run.find((entry) => entry.source.id === "remoteok")?.settings.limit,
    5,
  );
});

test("unknown config and --source ids produce warnings, not crashes", async () => {
  const sources = await discoverSources();

  const plan = planSources(
    { sources: { bogus: { enabled: true } } },
    sources,
  );

  assert.equal(plan.run.length, sources.length);
  assert.ok(plan.warnings.some((warning) => warning.includes('"bogus"')));

  const onlyPlan = planSources({}, sources, new Set(["also-bogus"]));
  assert.deepEqual(onlyPlan.run, []);
  assert.ok(onlyPlan.warnings.some((warning) => warning.includes('"also-bogus"')));

  const malformed = planSources(
    { sources: { remoteok: "yes" } } as unknown as SourceConfig,
    sources,
  );
  assert.ok(malformed.warnings.some((warning) => warning.includes("must be a mapping")));
});

test("collectStartups runs any registered source selected with only", async () => {
  const sources = [
    fakeSource("remoteok", async () => [startup("remoteok:1", "remoteok")]),
    fakeSource("hn", async () => [startup("hn:1", "hn")]),
  ];

  const only = await collectStartups(
    {},
    { only: new Set(["hn"]), profile },
    sources,
  );
  assert.deepEqual(only.map((item) => item.id), ["hn:1"]);

  const all = await collectStartups({}, { profile }, sources);
  assert.deepEqual(all.map((item) => item.id).sort(), ["hn:1", "remoteok:1"]);
});

test("collectStartups isolates failures and ignores unknown-only runs", async () => {
  const sources = [
    fakeSource("remoteok", async () => [startup("remoteok:ok", "remoteok")]),
    fakeSource("hn", async () => {
      throw new Error("Hacker News is down");
    }),
  ];

  const result = await collectStartups({}, { profile }, sources);
  assert.deepEqual(result.map((item) => item.id), ["remoteok:ok"]);

  const unknown = await collectStartups(
    { sources: { bogus: { enabled: true } } },
    { only: new Set(["bogus"]), profile },
    sources,
  );
  assert.deepEqual(unknown, []);
});

test("collectStartups skips a source disabled in config", async () => {
  const sources = [
    fakeSource("remoteok", async () => [startup("remoteok:1", "remoteok")]),
  ];

  const result = await collectStartups(
    { sources: { remoteok: { enabled: false } } },
    { profile },
    sources,
  );

  assert.deepEqual(result, []);
});
