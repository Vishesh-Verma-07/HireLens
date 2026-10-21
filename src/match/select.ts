import type { Match } from "../types.js";

/**
 * Company key used to stop one employer from monopolising a digest.
 *
 * Legal suffixes are dropped so "Acme, Inc." and "Acme Ltd" collapse together;
 * the rest is reduced to lowercase alphanumerics.
 */
function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|pvt|private|gmbh|corp|corporation)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export interface SelectOptions {
  /** Job URLs already sent in a previous digest — never send these again. */
  excludeUrls?: Set<string>;
  /** Maximum rows in the digest. */
  limit?: number;
  /** Maximum rows for any single company. */
  perCompany?: number;
}

/**
 * Picks the rows that go into a digest.
 *
 * Two rules keep the daily email from feeling like the same list every day:
 *   1. anything already emailed in an earlier digest is skipped, and
 *   2. one company can only occupy a couple of slots, so a single employer
 *      with many postings cannot crowd out everyone else.
 *
 * Order is preserved, so the highest-fit matches still come first.
 */
export function selectForDigest(matches: Match[], opts: SelectOptions = {}): Match[] {
  const exclude = opts.excludeUrls ?? new Set<string>();
  const limit = opts.limit ?? 10;
  const perCompany = opts.perCompany ?? 2;
  const counts = new Map<string, number>();
  const picked: Match[] = [];

  for (const match of matches) {
    if (match.startup.url && exclude.has(match.startup.url)) continue;

    const key = companyKey(match.startup.name);
    const count = counts.get(key) ?? 0;
    if (count >= perCompany) continue;

    counts.set(key, count + 1);
    picked.push(match);
    if (picked.length >= limit) break;
  }

  return picked;
}
