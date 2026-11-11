import assert from "node:assert/strict";
import type { SignalType, Startup } from "../src/types.js";

/**
 * Contract every source must satisfy.
 *
 * Sources are discovered dynamically, so nothing at compile time proves that a
 * fetched `Startup[]` is actually usable by the matcher, the digest, and the
 * seen-store. This utility is that runtime proof, and every source test runs it
 * against a recorded fixture:
 *
 * ```ts
 * const startups = await withFixtureFetch("remoteok", () =>
 *   fetchRemoteOk({ limit: 10 }),
 * );
 * assertValidStartups(startups, "remoteok");
 * ```
 *
 * An empty array is valid: a source may legitimately find no fresh jobs. Tests
 * that care about coverage should assert `startups.length > 0` themselves.
 */

const SIGNAL_TYPES: readonly SignalType[] = ["raised", "launched", "hiring", "news"];

/**
 * ISO 8601 date or date-time. Field data is sometimes date-only, so both are
 * accepted; anything else (epoch numbers, "yesterday", RFC 2822) is rejected.
 */
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fails unless `value` is a non-empty, trimmed string. */
function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok((value as string).trim().length > 0, `${label} must not be empty`);
}

/** Fails unless `value` is an array of strings. */
function assertStringArray(value: unknown, label: string): asserts value is string[] {
  assert.ok(Array.isArray(value), `${label} must be an array of strings`);
  (value as unknown[]).forEach((entry, index) => {
    assert.equal(typeof entry, "string", `${label}[${index}] must be a string`);
  });
}

/** Fails unless `value` parses as a real ISO 8601 date. */
function assertIsoDate(value: unknown, label: string): void {
  assert.equal(typeof value, "string", `${label} must be an ISO 8601 date string`);
  const text = (value as string).trim();
  assert.match(
    text,
    ISO_DATE,
    `${label} "${text}" must be a valid ISO 8601 date (e.g. 2026-11-01T10:00:00Z)`,
  );
  assert.ok(
    !Number.isNaN(Date.parse(text)),
    `${label} "${text}" must be a valid ISO 8601 date (month/day out of range)`,
  );
}

function assertSignal(value: unknown, label: string): void {
  assert.ok(isRecord(value), `${label} must be an object`);

  assert.ok(
    SIGNAL_TYPES.includes(value.type as SignalType),
    `${label}.type "${String(value.type)}" must be one of: ${SIGNAL_TYPES.join(", ")}`,
  );

  if (value.date !== undefined) assertIsoDate(value.date, `${label}.date`);
  if (value.text !== undefined) assertNonEmptyString(value.text, `${label}.text`);
  if (value.url !== undefined) assertNonEmptyString(value.url, `${label}.url`);

  if (value.amountUsd !== undefined) {
    assert.equal(typeof value.amountUsd, "number", `${label}.amountUsd must be a number`);
    assert.ok(
      Number.isFinite(value.amountUsd) && (value.amountUsd as number) >= 0,
      `${label}.amountUsd must be a finite, non-negative number`,
    );
  }
}

/**
 * Asserts that `startups` is a valid `Startup[]` for `sourceId`.
 *
 * Checks the fields every consumer relies on:
 * - `id` is `"{sourceId}:{local-id}"` and unique within the batch,
 * - `name`, `source`, `signals`, `locations`, and `industry` are present,
 * - every signal has a valid `SignalType` and, when dated, a parseable ISO date.
 *
 * The parameter is typed as `readonly Startup[]` so callers get autocomplete,
 * but the checks are runtime checks on unknown data — a fixture-parsed source
 * result is not trusted just because the compiler accepted it.
 */
export function assertValidStartups(
  startups: readonly Startup[],
  sourceId: string,
): void {
  assertNonEmptyString(sourceId, "assertValidStartups sourceId");
  assert.ok(Array.isArray(startups), `[${sourceId}] expected an array of startups`);

  const prefix = `${sourceId}:`;
  const seen = new Map<string, number>();

  (startups as readonly unknown[]).forEach((startup, index) => {
    const where = `[${sourceId}] startups[${index}]`;
    assert.ok(isRecord(startup), `${where} must be a Startup object`);

    // id — the dedupe key across daily runs, so it must be stable and namespaced.
    assertNonEmptyString(startup.id, `${where}.id`);
    const id = startup.id;
    assert.ok(
      id.startsWith(prefix),
      `${where}.id "${id}" must start with "${prefix}"`,
    );
    assert.ok(
      id.length > prefix.length,
      `${where}.id "${id}" must include a local id after "${prefix}"`,
    );

    const firstIndex = seen.get(id);
    assert.equal(
      firstIndex,
      undefined,
      `${where}.id "${id}" duplicates startups[${firstIndex}] — dedupe keys must be unique`,
    );
    seen.set(id, index);

    // Required fields.
    assertNonEmptyString(startup.name, `${where}.name`);
    assert.equal(
      startup.source,
      sourceId,
      `${where}.source must be "${sourceId}" (got "${String(startup.source)}")`,
    );
    assert.ok(Array.isArray(startup.signals), `${where}.signals must be an array`);
    assert.ok(
      (startup.signals as unknown[]).length > 0,
      `${where}.signals must not be empty — a startup with no signal is not matchable`,
    );
    (startup.signals as unknown[]).forEach((signal, signalIndex) => {
      assertSignal(signal, `${where}.signals[${signalIndex}]`);
    });

    assertStringArray(startup.locations, `${where}.locations`);
    assertStringArray(startup.industry, `${where}.industry`);

    // Optional fields, but they must be the declared type when present.
    for (const field of [
      "oneLiner",
      "description",
      "url",
      "stage",
      "employees",
      "batch",
      "companyDomain",
    ] as const) {
      if (startup[field] !== undefined) {
        assertNonEmptyString(startup[field], `${where}.${field}`);
      }
    }

    if (startup.remote !== undefined) {
      assert.equal(typeof startup.remote, "boolean", `${where}.remote must be a boolean`);
    }
  });
}
