import assert from "node:assert/strict";
import test from "node:test";
import type { Profile, Startup } from "../types.js";
import { rankStartups } from "./rank.js";

const profile: Profile = {
  name: "Test Person",
  headline: "Backend engineer",
  summary: "",
  skills: ["typescript"],
  domains: [],
  seniority: "mid",
  yearsExperience: 2,
  roles: ["backend engineer"],
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

function posting(source: Startup["source"], overrides: Partial<Startup> = {}): Startup {
  return {
    id: `${source}:1`,
    name: "Acme",
    oneLiner: "Backend Engineer",
    description: "TypeScript services.",
    url: `https://${source}.test/jobs/1`,
    locations: ["Remote"],
    remote: true,
    industry: ["engineering"],
    source,
    signals: [
      {
        type: "hiring",
        date: "2026-11-12T00:00:00.000Z",
        text: "Acme — Backend Engineer",
      },
    ],
    ...overrides,
  };
}

test("rankStartups: a merged role keeps every contributing source", () => {
  const matches = rankStartups(
    [posting("remoteok"), posting("remotive", { id: "remotive:1" })],
    profile,
  );

  assert.equal(matches.length, 1, "the same company + role should merge");
  assert.deepEqual(matches[0]?.startup.sources, ["remoteok", "remotive"]);
});

test("rankStartups: an empty sources list still contributes its own source", () => {
  const matches = rankStartups(
    [
      posting("remoteok", { sources: [] }),
      posting("remotive", { id: "remotive:1", sources: [] }),
    ],
    profile,
  );

  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0]?.startup.sources, ["remoteok", "remotive"]);
});

test("rankStartups: a single record keeps its own source and no sources list", () => {
  const matches = rankStartups([posting("remoteok")], profile);

  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.startup.source, "remoteok");
  assert.equal(matches[0]?.startup.sources, undefined);
});
