import assert from "node:assert/strict";
import test from "node:test";
import { fetchRemoteOk } from "./remoteok.js";

/** A trimmed snapshot of RemoteOK's public JSON feed. */
const FIXTURE = [
  { legal: "See https://remoteok.com/legal" },
  {
    id: "123",
    slug: "acme-backend-engineer",
    date: "2026-11-01T10:00:00Z",
    company: "Acme",
    position: "Backend Engineer",
    tags: ["node", "postgres"],
    location: "Worldwide",
    url: "https://remoteok.com/remote-jobs/123",
    description: "<p>Build APIs with <strong>Node</strong>.</p>",
  },
  {
    id: "124",
    company: "Acme",
    position: "Account Executive",
    url: "https://remoteok.com/remote-jobs/124",
  },
  {
    id: "125",
    company: "Acme",
    position: "Product Designer",
    url: "https://remoteok.com/remote-jobs/125",
  },
];

test("fetchRemoteOk still parses the feed through the shared HTTP client", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";

  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify(FIXTURE), { status: 200 });
  }) as typeof fetch;

  try {
    const jobs = await fetchRemoteOk(10);

    assert.equal(requestedUrl, "https://remoteok.com/api");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.id, "remoteok:123");
    assert.equal(jobs[0]?.source, "remoteok");
    assert.equal(jobs[0]?.name, "Acme");
    assert.equal(jobs[0]?.oneLiner, "Backend Engineer");
    assert.match(jobs[0]?.description ?? "", /Build APIs with Node/);
    assert.equal(jobs[0]?.signals[0]?.type, "hiring");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
