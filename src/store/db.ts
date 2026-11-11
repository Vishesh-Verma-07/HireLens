import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../lib/log.js";

/**
 * Tiny JSON store. Keeps a record of job ids we've already surfaced so the
 * daily digest shows *new* matches instead of the same list every morning.
 *
 * Deliberately not a database: single user, tiny data, zero native deps.
 * When this goes multi-user, swap this for a real store keyed by user id —
 * the call sites already take an explicit store path.
 */
export interface Store {
  /** id -> ISO timestamp first seen. */
  seen: Record<string, string>;
  meta: { lastRun?: string };
}

/** How long a seen id suppresses the same role on later runs. */
export const SEEN_TTL_DAYS = 30;

const DAY_MS = 86_400_000;

export function loadStore(path: string): Store {
  if (!existsSync(path)) return { seen: {}, meta: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Store>;
    return { seen: parsed.seen ?? {}, meta: parsed.meta ?? {} };
  } catch (err) {
    logger.warn(`store: could not read ${path}, starting fresh — ${(err as Error).message}`);
    return { seen: {}, meta: {} };
  }
}

export function saveStore(path: string, store: Store): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), "utf8");
}

/**
 * Drops entries older than `ttlDays` so a role can resurface after the TTL.
 * Entries with an unparsable timestamp are dropped too: they would otherwise
 * suppress a job forever. Returns the number of entries removed.
 */
export function pruneSeen(
  store: Store,
  ttlDays: number = SEEN_TTL_DAYS,
  now: number = Date.now(),
): number {
  const cutoff = now - ttlDays * DAY_MS;
  let removed = 0;

  for (const [id, firstSeen] of Object.entries(store.seen)) {
    const at = Date.parse(firstSeen);
    if (Number.isNaN(at) || at < cutoff) {
      delete store.seen[id];
      removed++;
    }
  }

  return removed;
}

/** True when `id` was seen within the TTL window. */
export function isSeen(
  store: Store,
  id: string,
  ttlDays: number = SEEN_TTL_DAYS,
  now: number = Date.now(),
): boolean {
  const firstSeen = store.seen[id];
  if (!firstSeen) return false;
  const at = Date.parse(firstSeen);
  if (Number.isNaN(at)) return false;
  return at >= now - ttlDays * DAY_MS;
}

export function markSeen(store: Store, ids: string[], now: Date = new Date()): void {
  const stamp = now.toISOString();
  for (const id of ids) if (!store.seen[id]) store.seen[id] = stamp;
  store.meta.lastRun = stamp;
}
