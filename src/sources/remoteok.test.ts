import assert from "node:assert/strict";
import test from "node:test";
import { assertValidStartups } from "../../test/contract.js";
import { withFixtureFetch } from "../../test/fixtures.js";
import { fetchRemoteOk } from "./remoteok.js";

/**
 * Template for a source test — copy this file for a new source.
 *
 * 1. Record a fixture once: `npm run record:fixture <source>`
 * 2. Replay it offline with `withFixtureFetch`.
 * 3. Run the shared contract with `assertValidStartups`.
 *
 * Never hit the live API from a test: a fixture makes the test deterministic and
 * keeps CI offline.
 */
test("remoteok: recorded fixture parses into valid Startups", async () => {
  const startups = await withFixtureFetch("remoteok", () =>
    fetchRemoteOk({ limit: 10 }),
  );

  assert.ok(startups.length > 0, "fixture should contain at least one tech role");
  assertValidStartups(startups, "remoteok");

  assert.equal(startups[0]?.signals[0]?.type, "hiring");
  assert.equal(startups[0]?.remote, true);
});
