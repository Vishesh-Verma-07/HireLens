import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubConfigured, sendToHub } from "../src/hub/client.js";
import {
  HUB_BATCH_SIZE,
  toHubJob,
  type HubJobPayload,
} from "../src/hub/jobs.js";
import { loadEnv } from "../src/lib/env.js";
import { logger } from "../src/lib/log.js";
import type { Match } from "../src/types.js";

/**
 * Re-sends every job already present in `data/snapshot-*.json` to Hub.
 *
 * Hub upserts by `(source, sourceId)`, so running this repeatedly is safe and
 * does not reset any dashboard-owned status/notes. Batches are 50 records.
 *
 * Usage:
 *   npm run backfill:hub
 */

const BATCH_SIZE = HUB_BATCH_SIZE;

interface Snapshot {
  generatedAt?: string;
  matches?: Match[];
}

function snapshotFiles(root: string): string[] {
  const dir = resolve(root, "data");
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => /^snapshot-.*\.json$/.test(name))
    .sort();
}

function readSnapshot(path: string): Snapshot | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  } catch (err) {
    logger.warn(`hub: could not read ${path} — ${(err as Error).message}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  loadEnv(root);

  if (!hubConfigured()) {
    logger.info("hub: HUB_URL/HUB_API_KEY not set — nothing to backfill");
    return;
  }

  const files = snapshotFiles(root);
  if (files.length === 0) {
    logger.info("hub: no snapshots found in data/ — nothing to backfill");
    return;
  }

  // Later snapshots win, so the newest score/data for a job is the one sent.
  const byId = new Map<string, { match: Match; discoveredAt: string }>();

  for (const file of files) {
    const path = resolve(root, "data", file);
    const snapshot = readSnapshot(path);
    if (!snapshot?.matches) continue;

    const discoveredAt = snapshot.generatedAt ?? new Date().toISOString();
    for (const match of snapshot.matches) {
      const id = match?.startup?.id?.trim();
      if (!id) continue;
      byId.set(id, { match, discoveredAt });
    }
  }

  const payloads: HubJobPayload[] = [];
  let skipped = 0;

  for (const { match, discoveredAt } of byId.values()) {
    const payload = toHubJob(match, discoveredAt);
    if (payload) payloads.push(payload);
    else skipped += 1;
  }

  const batches = Math.ceil(payloads.length / BATCH_SIZE);
  logger.info(
    `hub: backfilling ${payloads.length} job(s) from ${files.length} snapshot(s) in ${batches} batch(es) of ${BATCH_SIZE}` +
      (skipped ? ` — ${skipped} skipped` : ""),
  );

  let sent = 0;
  let failed = 0;

  for (let index = 0; index < payloads.length; index += BATCH_SIZE) {
    const batch = payloads.slice(index, index + BATCH_SIZE);
    const batchNumber = Math.floor(index / BATCH_SIZE) + 1;

    const ok = await sendToHub("jobs", batch);
    if (ok) {
      sent += batch.length;
      logger.info(`hub: batch ${batchNumber}/${batches} sent (${batch.length})`);
    } else {
      failed += batch.length;
      logger.error(`hub: batch ${batchNumber}/${batches} failed (${batch.length})`);
    }
  }

  logger.info(
    `hub: backfill complete — ${sent} sent, ${failed} failed, ${skipped} skipped`,
  );

  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  logger.error(`hub: backfill failed — ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
