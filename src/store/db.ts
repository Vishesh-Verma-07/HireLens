import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../lib/log.js";

/**
 * Tiny JSON store. Keeps a record of startup ids we've already surfaced so the
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

export function markSeen(store: Store, ids: string[]): void {
  const now = new Date().toISOString();
  for (const id of ids) if (!store.seen[id]) store.seen[id] = now;
  store.meta.lastRun = now;
}
