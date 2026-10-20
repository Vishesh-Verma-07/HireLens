import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { logger } from "../lib/log.js";
import type { Startup } from "../types.js";
import { fetchFunding } from "./funding.js";
import { fetchArbeitnow } from "./arbeitnow.js";
import { fetchHn } from "./hn.js";
import { fetchInternshala } from "./internshala.js";
import { fetchProductHunt } from "./producthunt.js";
import { fetchRemoteOk } from "./remoteok.js";
import { fetchRemotive } from "./remotive.js";
import { fetchUnstop } from "./unstop.js";
import { fetchYc } from "./yc.js";

interface SourceConfig {
  sources: {
    hn?: { enabled?: boolean };
    funding?: { enabled?: boolean; feeds?: string[] };
    producthunt?: { enabled?: boolean; feeds?: string[] };
    yc?: { enabled?: boolean; url?: string; limit?: number; query?: string; hiringOnly?: boolean };
    remoteok?: { enabled?: boolean; limit?: number };
    remotive?: { enabled?: boolean; limit?: number };
    arbeitnow?: { enabled?: boolean; limit?: number };
    internshala?: { enabled?: boolean; limit?: number };
    unstop?: { enabled?: boolean; limit?: number };
  };
}

export interface CollectOptions {
  /** Only run these sources, if set. */
  only?: Set<string>;
}

export function loadSourceConfig(path: string): SourceConfig {
  return parse(readFileSync(path, "utf8")) as SourceConfig;
}

/** Runs every enabled source in parallel; one failing source never sinks the run. */
export async function collectStartups(
  config: SourceConfig,
  opts: CollectOptions = {},
): Promise<Startup[]> {
  const s = config.sources ?? {};
  const want = (name: string) => (!opts.only || opts.only.has(name)) && s[name as keyof SourceConfig["sources"]]?.enabled !== false;

  const jobs: Array<Promise<Startup[]>> = [];
  const labels: string[] = [];

  const track = (label: string, p: Promise<Startup[]>) => {
    labels.push(label);
    jobs.push(p);
  };

  if (want("hn")) track("hn", fetchHn());
  if (want("funding") && s.funding?.feeds?.length) {
    track("funding", fetchFunding(s.funding.feeds));
  }
  if (want("producthunt") && s.producthunt?.feeds?.length) {
    track("producthunt", fetchProductHunt(s.producthunt.feeds));
  }
  if (want("remoteok")) {
    track("remoteok", fetchRemoteOk(s.remoteok?.limit ?? 100));
  }
  if (want("remotive")) {
    track("remotive", fetchRemotive(s.remotive?.limit ?? 60));
  }
  if (want("arbeitnow")) {
    track("arbeitnow", fetchArbeitnow(s.arbeitnow?.limit ?? 60));
  }
  if (want("internshala")) {
    track("internshala", fetchInternshala(s.internshala?.limit ?? 60));
  }
  if (want("unstop")) {
    track("unstop", fetchUnstop(s.unstop?.limit ?? 60));
  }
  if (want("yc")) {
    track(
      "yc",
      fetchYc({
        url: s.yc?.url ?? "https://www.ycombinator.com/companies",
        limit: s.yc?.limit ?? 100,
        query: s.yc?.query,
        hiringOnly: s.yc?.hiringOnly,
      }),
    );
  }

  const settled = await Promise.allSettled(jobs);
  const all: Startup[] = [];

  settled.forEach((result, i) => {
    const label = labels[i] ?? `source${i}`;
    if (result.status === "fulfilled") {
      logger.info(`${label}: ${result.value.length} startups`);
      all.push(...result.value);
    } else {
      logger.warn(`${label}: failed — ${result.reason?.message ?? result.reason}`);
    }
  });

  return all;
}
