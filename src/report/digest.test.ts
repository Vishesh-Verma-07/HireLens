import assert from "node:assert/strict";
import test from "node:test";
import type { Match, Profile, Startup } from "../types.js";
import {
  renderDigest,
  renderDigestHtml,
  renderDigestText,
  renderMatchDetailHtml,
  renderMatchDetailText,
  sourceAttribution,
} from "./digest.js";

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

function startup(overrides: Partial<Startup> = {}): Startup {
  return {
    id: "wellfound:1",
    name: "Acme",
    oneLiner: "Backend Engineer",
    url: "https://acme.test/jobs/1",
    locations: ["Remote"],
    remote: true,
    industry: ["engineering"],
    source: "wellfound",
    sources: ["wellfound"],
    signals: [
      {
        type: "hiring",
        date: "2026-11-12T00:00:00.000Z",
        text: "Acme — Backend Engineer",
        url: "https://acme.test/jobs/1",
      },
    ],
    ...overrides,
  };
}

function match(overrides: Partial<Startup> = {}): Match {
  return {
    startup: startup(overrides),
    score: 88,
    reasons: ["Matches your terms: typescript"],
    penalties: [],
    relevant: true,
  };
}

test("sourceAttribution: a single-source record uses its own source", () => {
  assert.equal(sourceAttribution(startup()), "wellfound");
  assert.equal(sourceAttribution(startup({ sources: undefined })), "wellfound");
  assert.equal(sourceAttribution(startup({ sources: [] })), "wellfound");
});

test("sourceAttribution: a merged record lists every contributing board", () => {
  assert.equal(
    sourceAttribution(startup({ sources: ["wellfound", "remoteok", "himalayas"] })),
    "wellfound + remoteok + himalayas",
  );
});

test("renderDigest: the metadata line credits every contributing board", () => {
  const markdown = renderDigest(profile, [match({ sources: ["wellfound", "remoteok"] })], {
    showAll: false,
  });

  assert.match(markdown, /wellfound \+ remoteok/);
  assert.ok(!markdown.includes("stage? · wellfound ·"), "must not show only the winning board");
});

test("renderDigestText: every match names its source", () => {
  const text = renderDigestText(profile, [
    match({ sources: ["wellfound", "remoteok"] }),
    match({ id: "otta:2", source: "otta", sources: undefined }),
  ]);

  assert.match(text, /Source: wellfound \+ remoteok/);
  assert.match(text, /Source: otta/);
});

test("renderDigestHtml: the card credits every contributing board", () => {
  const html = renderDigestHtml(profile, [match({ sources: ["wellfound", "remoteok"] })]);

  assert.match(html, /wellfound \+ remoteok/);
});

test("match detail renderers include the source attribution", () => {
  const merged = match({ sources: ["wellfound", "remoteok"] });

  assert.match(renderMatchDetailText(merged, 1), /wellfound \+ remoteok/);
  assert.match(renderMatchDetailHtml(merged, 1), /wellfound \+ remoteok/);
});
