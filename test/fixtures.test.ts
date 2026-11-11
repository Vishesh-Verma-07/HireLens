import assert from "node:assert/strict";
import test from "node:test";
import {
  fixturePath,
  loadFixture,
  selectResponse,
  withFixtureFetch,
  type Fixture,
} from "./fixtures.js";

const fixture: Fixture = {
  source: "acme",
  recordedAt: "2026-11-11T00:00:00Z",
  responses: [
    {
      url: "https://acme.test/api?limit=10",
      status: 200,
      headers: { "content-type": "application/json" },
      body: { jobs: [{ id: 1 }] },
    },
    {
      url: "https://acme.test/other",
      status: 200,
      headers: {},
      body: "plain text",
    },
  ],
};

test("loadFixture explains how to record a missing fixture", () => {
  assert.throws(
    () => loadFixture("definitely-not-recorded"),
    /npm run record:fixture definitely-not-recorded/,
  );
});

test("selectResponse prefers an exact URL, then the same path", () => {
  assert.equal(
    selectResponse(fixture, "https://acme.test/api?limit=10"),
    fixture.responses[0],
  );
  assert.equal(
    selectResponse(fixture, "https://acme.test/api?limit=25"),
    fixture.responses[0],
  );
  assert.throws(
    () => selectResponse(fixture, "https://acme.test/unrecorded"),
    /has no response for/,
  );
});

test("selectResponse reuses a single recorded response for any URL", () => {
  const single: Fixture = {
    source: "acme",
    recordedAt: "2026-11-11T00:00:00Z",
    responses: [fixture.responses[0]!],
  };

  assert.equal(
    selectResponse(single, "https://acme.test/completely-different"),
    single.responses[0],
  );
});

test("withFixtureFetch replays the body and always restores global fetch", async () => {
  const originalFetch = globalThis.fetch;

  const body = await withFixtureFetch("acme", async () => {
    const response = await fetch("https://acme.test/api?limit=10");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    return (await response.json()) as { jobs: Array<{ id: number }> };
  }, fixture);

  assert.deepEqual(body, { jobs: [{ id: 1 }] });
  assert.equal(globalThis.fetch, originalFetch);

  await assert.rejects(
    withFixtureFetch(
      "acme",
      async () => {
        await fetch("https://acme.test/api?limit=10");
        throw new Error("boom");
      },
      fixture,
    ),
    /boom/,
  );

  assert.equal(globalThis.fetch, originalFetch);
});

test("withFixtureFetch replays non-JSON bodies verbatim", async () => {
  const text = await withFixtureFetch(
    "acme",
    async () => {
      const response = await fetch("https://acme.test/other");
      return response.text();
    },
    fixture,
  );

  assert.equal(text, "plain text");
});
