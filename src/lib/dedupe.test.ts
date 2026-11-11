import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupeKey,
  dedupeStartups,
  normalizeCompany,
  normalizeLocation,
  normalizeTitle,
  seenKey,
  titleSimilarity,
} from "./dedupe.js";
import type { SourceId, Startup } from "../types.js";

function job(
  source: SourceId,
  overrides: Partial<Startup> & { id?: string } = {},
): Startup {
  return {
    id: `${source}:1`,
    name: "Acme",
    oneLiner: "Software Engineer",
    locations: ["Remote"],
    remote: true,
    industry: [],
    source,
    signals: [{ type: "hiring", text: `${source} posting` }],
    ...overrides,
  };
}

test("normalizes company names, titles, and locations", () => {
  assert.equal(normalizeCompany("Acme, Inc."), "acme");
  assert.equal(normalizeCompany("ACME LLC"), "acme");
  assert.equal(normalizeCompany("Acme & Co"), "acme and");
  assert.equal(
    normalizeTitle("Senior Software Engineer (Remote)"),
    "senior software engineer",
  );
  assert.equal(normalizeTitle("Software Engineer II"), "software engineer");
  assert.equal(normalizeTitle("Sr. Backend Developer - Full-time"), "senior backend developer");
  assert.equal(normalizeLocation(["Remote - US"]), "us");
  assert.equal(normalizeLocation(["Worldwide"]), "");
});

test("title similarity ignores board noise but keeps seniority and stack", () => {
  assert.equal(
    titleSimilarity("Software Engineer (Remote)", "Software Engineer"),
    1,
  );
  assert.ok(titleSimilarity("Senior Software Engineer", "Software Engineer") < 0.85);
  assert.ok(titleSimilarity("Backend Engineer", "Frontend Engineer") < 0.85);
});

test("same role from two boards becomes one record with all sources", () => {
  const { startups, removed } = dedupeStartups([
    job("remoteok", {
      id: "remoteok:1",
      name: "Acme, Inc.",
      oneLiner: "Senior Software Engineer (Remote)",
      locations: ["Remote"],
      industry: ["remoteok-tag"],
      url: "https://remoteok.example/acme",
    }),
    job("remotive", {
      id: "remotive:9",
      name: "Acme",
      oneLiner: "Senior Software Engineer",
      locations: ["Worldwide"],
      industry: ["remotive-tag"],
      description: "Build things.",
    }),
  ]);

  assert.equal(removed, 1);
  assert.equal(startups.length, 1);

  const winner = startups[0]!;
  assert.equal(winner.id, "remoteok:1");
  assert.equal(winner.source, "remoteok");
  assert.deepEqual(winner.sources, ["remoteok", "remotive"]);
  assert.deepEqual(winner.industry, ["remoteok-tag", "remotive-tag"]);
  assert.equal(winner.url, "https://remoteok.example/acme");
  assert.equal(winner.description, "Build things.");
  assert.equal(winner.signals.length, 2, "signals from both boards are kept");
});

test("the same id is merged even without a role title", () => {
  const a = job("yc", {
    id: "yc:acme",
    oneLiner: "Payments for robots",
    signals: [{ type: "hiring", text: "Actively hiring" }],
  });
  const b = job("yc", {
    id: "yc:acme",
    source: "yc",
    oneLiner: "Payments for robots (YC S24)",
    industry: ["fintech"],
  });

  const { startups } = dedupeStartups([a, b]);
  assert.equal(startups.length, 1);
  assert.deepEqual(startups[0]!.sources, ["yc"]);
  assert.deepEqual(startups[0]!.industry, ["fintech"]);
});

test("different locations are not merged", () => {
  const { startups } = dedupeStartups([
    job("remoteok", { id: "remoteok:1", locations: ["Remote - US"] }),
    job("remotive", { id: "remotive:1", locations: ["Remote - India"] }),
  ]);
  assert.equal(startups.length, 2);
});

test("an unknown location matches a known one", () => {
  const { startups } = dedupeStartups([
    job("remoteok", { id: "remoteok:1", locations: [] }),
    job("remotive", { id: "remotive:1", locations: ["Berlin"] }),
  ]);
  assert.equal(startups.length, 1);
  assert.deepEqual(startups[0]!.sources, ["remoteok", "remotive"]);
});

test("different roles and companies stay separate", () => {
  const { startups } = dedupeStartups([
    job("remoteok", { id: "remoteok:1", oneLiner: "Backend Engineer" }),
    job("remotive", { id: "remotive:1", oneLiner: "Frontend Engineer" }),
    job("arbeitnow", { id: "arbeitnow:1", name: "Globex", oneLiner: "Backend Engineer" }),
  ]);
  assert.equal(startups.length, 3);
});

test("seniority differences are not merged", () => {
  const { startups } = dedupeStartups([
    job("remoteok", { id: "remoteok:1", oneLiner: "Senior Software Engineer" }),
    job("remotive", { id: "remotive:1", oneLiner: "Software Engineer" }),
  ]);
  assert.equal(startups.length, 2);
});

test("a company-level signal never merges with a job posting", () => {
  const funding: Startup = {
    id: "funding:acme",
    name: "Acme",
    oneLiner: "Acme raises $10M Series A",
    locations: [],
    industry: [],
    source: "funding",
    signals: [{ type: "raised", text: "Series A" }],
  };

  const { startups } = dedupeStartups([
    funding,
    job("remoteok", { id: "remoteok:1", name: "Acme", oneLiner: "Acme raises $10M Series A" }),
  ]);

  assert.equal(startups.length, 2);
  assert.deepEqual(
    startups.map((startup) => startup.source),
    ["funding", "remoteok"],
  );
});

test("dedupe is idempotent and reports the input order", () => {
  const input = [
    job("remoteok", { id: "remoteok:1" }),
    job("remotive", { id: "remotive:1" }),
    job("arbeitnow", { id: "arbeitnow:1", name: "Globex" }),
  ];

  const once = dedupeStartups(input);
  const twice = dedupeStartups(once.startups);

  assert.deepEqual(
    twice.startups.map((startup) => startup.id),
    ["remoteok:1", "arbeitnow:1"],
  );
  assert.equal(twice.removed, 0);
  assert.equal(once.removed, 1);
});

test("the threshold can be loosened for board-specific spellings", () => {
  const pairs = [
    job("remoteok", { id: "remoteok:1", oneLiner: "Software Engineer" }),
    job("remotive", { id: "remotive:1", oneLiner: "Software Engineer, Backend" }),
  ];

  assert.equal(dedupeStartups(pairs).startups.length, 2);
  assert.equal(dedupeStartups(pairs, { titleThreshold: 0.6 }).startups.length, 1);
});

test("dedupe and seen keys ignore source and location noise", () => {
  const a = job("remoteok", { id: "remoteok:1", locations: ["Remote - US"] });
  const b = job("remotive", { id: "remotive:1", locations: ["US", "Remote"] });

  assert.equal(dedupeKey(a), dedupeKey(b));
  assert.equal(seenKey(a), seenKey(b));
  assert.match(seenKey(a), /^dedupe:acme\|software engineer\|us$/);
  assert.equal(seenKey(job("remoteok", { name: "" })), "");
});
