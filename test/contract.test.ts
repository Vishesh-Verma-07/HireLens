import assert from "node:assert/strict";
import test from "node:test";
import type { Startup } from "../src/types.js";
import { assertValidStartups } from "./contract.js";

/** A source id that exists in the `SourceId` union; the checks are generic. */
const SOURCE = "remoteok";

function startup(overrides: Partial<Startup> = {}): Startup {
  return {
    id: `${SOURCE}:1`,
    name: "Acme",
    oneLiner: "Backend Engineer",
    locations: ["Worldwide"],
    remote: true,
    industry: ["node"],
    source: SOURCE,
    signals: [
      {
        type: "hiring",
        date: "2026-11-01T10:00:00Z",
        text: "Acme — Backend Engineer",
        url: "https://acme.test/jobs/1",
      },
    ],
    ...overrides,
  };
}

test("accepts a fully populated startup and an empty list", () => {
  assertValidStartups([startup()], SOURCE);
  assertValidStartups([], SOURCE);
});

test("accepts date-only and offset ISO dates", () => {
  const withDate = (date: string) => startup({ signals: [{ type: "news", date }] });

  assertValidStartups([withDate("2026-11-01")], SOURCE);
  assertValidStartups([withDate("2026-11-01T10:00:00+05:30")], SOURCE);
  assertValidStartups([withDate("2026-11-01T10:00:00.123Z")], SOURCE);
});

test("rejects ids that are not namespaced with the source", () => {
  assert.throws(
    () => assertValidStartups([startup({ id: "1" })], SOURCE),
    /must start with "remoteok:"/,
  );
  assert.throws(
    () => assertValidStartups([startup({ id: "arbeitnow:1" })], SOURCE),
    /must start with "remoteok:"/,
  );
  assert.throws(
    () => assertValidStartups([startup({ id: `${SOURCE}:` })], SOURCE),
    /must include a local id/,
  );
});

test("rejects a mismatched source field", () => {
  assert.throws(
    () => assertValidStartups([startup({ source: "arbeitnow" })], SOURCE),
    /\.source must be "remoteok"/,
  );
});

test("rejects missing required fields", () => {
  assert.throws(
    () => assertValidStartups([startup({ name: "  " })], SOURCE),
    /\.name must not be empty/,
  );
  assert.throws(
    () => assertValidStartups([startup({ signals: [] })], SOURCE),
    /\.signals must not be empty/,
  );
  assert.throws(
    () =>
      assertValidStartups(
        [startup({ locations: undefined as unknown as string[] })],
        SOURCE,
      ),
    /\.locations must be an array/,
  );
});

test("rejects invalid signal types and non-ISO dates", () => {
  assert.throws(
    () =>
      assertValidStartups(
        [startup({ signals: [{ type: "funding" as Startup["signals"][number]["type"] }] })],
        SOURCE,
      ),
    /must be one of: raised, launched, hiring, news/,
  );
  assert.throws(
    () =>
      assertValidStartups(
        [startup({ signals: [{ type: "hiring", date: "last Tuesday" }] })],
        SOURCE,
      ),
    /must be a valid ISO 8601 date/,
  );
  assert.throws(
    () =>
      assertValidStartups(
        [startup({ signals: [{ type: "hiring", date: "2026-13-45" }] })],
        SOURCE,
      ),
    /must be a valid ISO 8601 date/,
  );
});

test("rejects duplicate ids within one batch", () => {
  assert.throws(
    () => assertValidStartups([startup(), startup({ name: "Acme Two" })], SOURCE),
    /duplicates startups\[0\]/,
  );
});

test("rejects wrong optional field types", () => {
  assert.throws(
    () =>
      assertValidStartups(
        [startup({ remote: "yes" as unknown as boolean })],
        SOURCE,
      ),
    /\.remote must be a boolean/,
  );
  assert.throws(
    () =>
      assertValidStartups(
        [startup({ industry: [42] as unknown as string[] })],
        SOURCE,
      ),
    /\.industry\[0\] must be a string/,
  );
});
