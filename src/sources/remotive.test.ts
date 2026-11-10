import assert from "node:assert/strict";
import test from "node:test";
import { fetchRemotive } from "./remotive.js";

/** A trimmed snapshot of Remotive's public remote-jobs API. */
const FIXTURE = {
  jobs: [
    {
      id: 9001,
      url: "https://remotive.com/remote-jobs/software-dev/acme-frontend-engineer-9001",
      title: "Frontend Engineer",
      company_name: "Acme",
      category: "Software Development",
      tags: ["react", "typescript"],
      publication_date: "2026-11-02T08:00:00Z",
      candidate_required_location: "Worldwide",
      description: "<p>Ship the dashboard.</p>",
    },
    {
      id: 9002,
      title: "Sales Manager",
      company_name: "Acme",
      candidate_required_location: "Worldwide",
    },
  ],
};

test("fetchRemotive still parses the API through the shared HTTP client", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";

  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify(FIXTURE), { status: 200 });
  }) as typeof fetch;

  try {
    const jobs = await fetchRemotive(10);

    assert.match(requestedUrl, /^https:\/\/remotive\.com\/api\/remote-jobs\?limit=10$/);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.id, "remotive:9001");
    assert.equal(jobs[0]?.source, "remotive");
    assert.equal(jobs[0]?.name, "Acme");
    assert.equal(jobs[0]?.oneLiner, "Frontend Engineer");
    assert.match(jobs[0]?.description ?? "", /Ship the dashboard\./);
    assert.equal(jobs[0]?.industry.includes("react"), true);
    assert.equal(jobs[0]?.industry.includes("Software Development"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
