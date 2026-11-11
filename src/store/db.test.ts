import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isSeen,
  loadStore,
  markSeen,
  pruneSeen,
  saveStore,
  SEEN_TTL_DAYS,
  type Store,
} from "./db.js";

const DAY_MS = 86_400_000;

function empty(): Store {
  return { seen: {}, meta: {} };
}

test("markSeen records the first timestamp and keeps lastRun", () => {
  const store = empty();
  const first = new Date("2026-01-01T00:00:00.000Z");
  const later = new Date("2026-01-02T00:00:00.000Z");

  markSeen(store, ["a", "b"], first);
  markSeen(store, ["a"], later);

  assert.equal(store.seen.a, first.toISOString());
  assert.equal(store.seen.b, first.toISOString());
  assert.equal(store.meta.lastRun, later.toISOString());
});

test("isSeen honors the TTL window", () => {
  const store = empty();
  const seenAt = Date.parse("2026-01-01T00:00:00.000Z");
  markSeen(store, ["a"], new Date(seenAt));

  assert.equal(isSeen(store, "a", 30, seenAt + 29 * DAY_MS), true);
  assert.equal(isSeen(store, "a", 30, seenAt + 31 * DAY_MS), false);
  assert.equal(isSeen(store, "missing", 30, seenAt), false);
});

test("isSeen ignores timestamps it cannot parse", () => {
  const store: Store = { seen: { a: "not-a-date" }, meta: {} };
  assert.equal(isSeen(store, "a"), false);
});

test("pruneSeen drops expired and unparsable entries", () => {
  const now = Date.parse("2026-02-01T00:00:00.000Z");
  const store: Store = {
    seen: {
      fresh: new Date(now - 5 * DAY_MS).toISOString(),
      stale: new Date(now - (SEEN_TTL_DAYS + 1) * DAY_MS).toISOString(),
      broken: "not-a-date",
    },
    meta: {},
  };

  assert.equal(pruneSeen(store, SEEN_TTL_DAYS, now), 2);
  assert.deepEqual(Object.keys(store.seen), ["fresh"]);
});

test("pruneSeen can be customized and leaves a fresh store alone", () => {
  const now = Date.now();
  const store = empty();
  markSeen(store, ["a"], new Date(now - 10 * DAY_MS));

  assert.equal(pruneSeen(store, 30, now), 0);
  assert.equal(pruneSeen(store, 7, now), 1);
});

test("loadStore and saveStore round-trip through a file", () => {
  const directory = mkdtempSync(join(tmpdir(), "jobfinder-store-"));
  const path = join(directory, "nested", "store.json");

  try {
    assert.deepEqual(loadStore(path), { seen: {}, meta: {} });

    const store = empty();
    markSeen(store, ["a"], new Date("2026-01-01T00:00:00.000Z"));
    saveStore(path, store);

    const loaded = loadStore(path);
    assert.equal(loaded.seen.a, store.seen.a);
    assert.equal(loaded.meta.lastRun, store.meta.lastRun);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a corrupt store file is treated as empty instead of crashing", () => {
  const directory = mkdtempSync(join(tmpdir(), "jobfinder-store-"));
  const path = join(directory, "store.json");

  try {
    writeFileSync(path, "{not json", "utf8");
    assert.deepEqual(loadStore(path), { seen: {}, meta: {} });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
