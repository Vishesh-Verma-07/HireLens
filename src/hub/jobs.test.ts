import assert from "node:assert/strict";
import test from "node:test";
import type { Match, Startup } from "../types.js";
import { BOARD_HOSTS, toHubJob } from "./jobs.js";

/**
 * Fixtures are built inline: the domain rules must be tested without the
 * recorded snapshots or the network, so each case states exactly the shape a
 * source produces.
 */
function startup(overrides: Partial<Startup> = {}): Startup {
  return {
    id: "hn:acme",
    name: "Acme",
    oneLiner: "Backend Engineer",
    locations: ["Remote"],
    remote: true,
    industry: [],
    source: "hn",
    signals: [
      { type: "hiring", url: "https://news.ycombinator.com/item?id=1" },
    ],
    ...overrides,
  };
}

function match(overrides: Partial<Startup> = {}): Match {
  return {
    startup: startup(overrides),
    score: 80,
    reasons: ["backend"],
    penalties: [],
    relevant: true,
  };
}

function domainFor(overrides: Partial<Startup> = {}): string | undefined {
  return toHubJob(match(overrides))?.companyDomain;
}

test("explicit companyDomain wins over description and posting URLs", () => {
  assert.equal(
    domainFor({
      companyDomain: "https://www.Acme.com/careers?ref=hn",
      url: "https://news.ycombinator.com/item?id=1",
      description: "Apply via https://other.example.com/jobs or jobs@other.example.com",
    }),
    "acme.com",
  );
});

test("employer link in the description beats the board posting URL", () => {
  assert.equal(
    domainFor({
      url: "https://internshala.com/job/detail/fresher-react-developer-job",
      description:
        "We build a matrimony app. Read more at https://www.acme.io/about and email founder@acme.io.",
      signals: [
        {
          type: "hiring",
          url: "https://internshala.com/job/detail/fresher-react-developer-job",
        },
      ],
    }),
    "acme.io",
  );
});

test("board-only records have no company domain and are skipped", () => {
  const boardOnly = match({
    url: "https://unstop.com/jobs/ai-ml-engineer-infosys-1792029",
    description: "Infosys is hiring for the role of AI ML Engineer!",
    signals: [
      {
        type: "hiring",
        url: "https://unstop.com/jobs/ai-ml-engineer-infosys-1792029",
      },
    ],
  });

  assert.equal(domainFor(boardOnly.startup), undefined);
  assert.equal(toHubJob(boardOnly), undefined, "toHubJob must skip the job");
});

test("email in the description yields the employer's domain", () => {
  assert.equal(
    domainFor({
      url: "https://news.ycombinator.com/item?id=50341345",
      description: 'Please email jobs@sadservers.com with subject "SRE AI Developer".',
    }),
    "sadservers.com",
  );
});

test("www, scheme, port, and path are normalized away", () => {
  assert.equal(
    domainFor({
      description: "Apply at HTTPS://WWW.Example.COM:443/about-us?ref=1#top",
    }),
    "example.com",
  );
  assert.equal(
    domainFor({ companyDomain: "https://www.Example.com./" }),
    "example.com",
  );
});

test("real HN shape: board item URL plus employer site in the body", () => {
  const payload = toHubJob(
    match({
      id: "hn:sadservers",
      name: "SadServers",
      url: "https://news.ycombinator.com/item?id=50341345",
      description:
        "SadServers | Software Engineer | REMOTE (Canada) | https://sadservers.com " +
        "I'm the founder of SadServers, a SaaS that provides hands-on challenges. " +
        "Please email jobs@sadservers.com with subject \"SRE AI Developer\".",
      signals: [
        {
          type: "hiring",
          date: "2026-11-02T18:32:00.000Z",
          url: "https://news.ycombinator.com/item?id=50341345",
        },
      ],
    }),
  );

  assert.equal(payload?.companyDomain, "sadservers.com");
  assert.equal(payload?.url, "https://news.ycombinator.com/item?id=50341345");
});

test("a board host in companyDomain is rejected in favour of the description", () => {
  assert.equal(
    domainFor({
      companyDomain: "https://job-boards.greenhouse.io/acme",
      url: "https://news.ycombinator.com/item?id=1",
      description: "Acme is hiring — see https://acme.dev/jobs",
    }),
    "acme.dev",
  );
});

test("signal URLs are the last resort before giving up", () => {
  assert.equal(
    domainFor({
      url: "https://remoteok.com/remote-jobs/remote-ai-ml-engineer-1137619",
      description: "The fastest-growing European SaaS company is searching for an AI/ML Engineer.",
      signals: [
        {
          type: "hiring",
          url: "https://remoteok.com/remote-jobs/remote-ai-ml-engineer-1137619",
        },
        { type: "news", url: "https://docusketch.com/careers" },
      ],
    }),
    "docusketch.com",
  );
});

test("board hosts reject their own subdomains", () => {
  assert.ok(BOARD_HOSTS.includes("news.ycombinator.com"));
  assert.equal(
    domainFor({
      url: "https://www.news.ycombinator.com/item?id=1",
      description: "Nothing but https://eu.jobs.lever.co/acme and hi@boards.greenhouse.io here.",
    }),
    undefined,
  );
});
