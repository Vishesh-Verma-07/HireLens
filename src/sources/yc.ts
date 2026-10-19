import { fetchText } from "../lib/http.js";
import { logger } from "../lib/log.js";
import { slug } from "../lib/text.js";
import type { Startup } from "../types.js";

/**
 * Y Combinator company directory.
 *
 * The directory is an Algolia-backed app. Its public search config — app id and
 * a short-lived secured key — is embedded in the page as `AlgoliaOpts = {...}`.
 * We read that config on every run rather than hardcoding it, so the key never
 * goes stale in our source. The key must be sent verbatim (the whole base64
 * blob), which is how YC's own client sends it.
 *
 * Fails soft: any problem just means YC contributes nothing that day.
 */

interface AlgoliaOpts {
  app: string;
  key: string;
  valid_until?: number;
}

interface YcHit {
  name: string;
  slug?: string;
  one_liner?: string;
  website?: string;
  all_locations?: string;
  industries?: string[];
  team_size?: number;
  batch?: string;
  isHiring?: boolean;
}

export interface YcOptions {
  url: string;
  limit: number;
  query?: string;
  hiringOnly?: boolean;
}

async function readAlgoliaOpts(pageUrl: string): Promise<AlgoliaOpts> {
  const html = await fetchText(pageUrl);
  const match = html.match(/AlgoliaOpts\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (!match?.[1]) throw new Error("AlgoliaOpts not found in YC directory page");
  const opts = JSON.parse(match[1]) as AlgoliaOpts;
  if (!opts.app || !opts.key) throw new Error("AlgoliaOpts missing app/key");
  return opts;
}

function mapHit(hit: YcHit, baseUrl: string): Startup {
  const locations = (hit.all_locations ?? "")
    .split(";")
    .map((l) => l.trim())
    .filter(Boolean);

  const remote = locations.some((l) => /remote/i.test(l));

  return {
    id: `yc:${slug(hit.slug ?? hit.name)}`,
    name: hit.name,
    oneLiner: hit.one_liner?.trim() || undefined,
    url: hit.website || `${baseUrl.replace(/\/companies.*$/, "")}/companies/${hit.slug ?? ""}`,
    locations,
    remote: remote || undefined,
    industry: hit.industries ?? [],
    employees: hit.team_size ? String(hit.team_size) : undefined,
    batch: hit.batch,
    source: "yc",
    signals: hit.isHiring
      ? [{ type: "hiring", text: `Actively hiring (YC ${hit.batch ?? "company"})` }]
      : [{ type: "news", text: `Listed in the YC directory${hit.batch ? ` (${hit.batch})` : ""}` }],
  };
}

export async function fetchYc(opts: YcOptions): Promise<Startup[]> {
  try {
    const config = await readAlgoliaOpts(opts.url);
    const host = `https://${config.app.toLowerCase()}-dsn.algolia.net`;
    const res = await fetch(`${host}/1/indexes/YCCompany_production/query`, {
      method: "POST",
      headers: {
        "x-algolia-application-id": config.app,
        "x-algolia-api-key": config.key,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: opts.query ?? "",
        hitsPerPage: Math.min(opts.limit, 1000),
        facetFilters: opts.hiringOnly === false ? [] : ["isHiring:true"],
        attributesToRetrieve: [
          "name",
          "slug",
          "one_liner",
          "website",
          "all_locations",
          "industries",
          "team_size",
          "batch",
          "isHiring",
        ],
      }),
    });

    if (!res.ok) {
      logger.warn(`yc: algolia HTTP ${res.status}`);
      return [];
    }

    const data = (await res.json()) as { hits?: YcHit[] };
    return (data.hits ?? []).map((h) => mapHit(h, opts.url));
  } catch (err) {
    logger.warn(`yc: failed — ${(err as Error).message}`);
    return [];
  }
}
