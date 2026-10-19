import { fetchJson } from "../lib/http.js";
import { firstLine, htmlToText, slug } from "../lib/text.js";
import type { Startup } from "../types.js";

interface AlgoliaHit {
  objectID: string;
  title?: string;
  created_at?: string;
}

interface AlgoliaSearch {
  hits: AlgoliaHit[];
}

interface HNItem {
  id: number;
  title?: string;
  created_at?: string;
  children?: HNItem[];
  text?: string;
}

const SEARCH_URL = "https://hn.algolia.com/api/v1/search_by_date";
const ITEM_URL = "https://hn.algolia.com/api/v1/items";

/** Finds the most recent "Ask HN: Who is hiring?" thread. */
async function latestHiringStory(): Promise<AlgoliaHit | undefined> {
  const url =
    `${SEARCH_URL}?query=${encodeURIComponent("Ask HN: Who is hiring?")}` +
    `&tags=story&hitsPerPage=30`;
  const data = await fetchJson<AlgoliaSearch>(url);
  return data.hits.find((h) => /who is hiring/i.test(h.title ?? ""));
}

function locationFrom(parts: string[], remote: boolean): string[] {
  const loc = parts[2]?.trim();
  const out: string[] = [];
  if (loc && !/^remote$/i.test(loc)) out.push(loc);
  if (remote) out.push("Remote");
  return out;
}

/** Parses one top-level comment like "Acme | Backend Engineer | Berlin | REMOTE". */
function parseComment(text: string, date: string | undefined, id: number): Startup | undefined {
  const plain = htmlToText(text);
  const line = firstLine(plain);
  if (!line) return undefined;

  // Real hiring comments are pipe-delimited and start with the company name.
  // Skip meta-comments ("If you're hiring, please...", questions, etc.).
  if (!line.includes("|")) return undefined;
  if (/^(if|please|note|reminder|about|see|here)/i.test(line)) return undefined;

  const parts = line.split("|").map((p) => p.trim());
  const name = parts[0] ?? "";
  if (!name || name.length > 60 || name.split(" ").length > 5) return undefined;

  const remote = /remote/i.test(line) || parts.some((p) => /^remote$/i.test(p));
  const SKIP = /^(https?:\/\/|remote$|onsite$|on-site$|full[- ]?time$|part[- ]?time$|contract$|internship$)/i;
  const role = (parts.slice(1).find((p) => p.length > 1 && !SKIP.test(p)) ?? "").slice(0, 120);

  return {
    id: `hn:${slug(name)}`,
    name,
    oneLiner: role || undefined,
    description: plain.slice(0, 4000),
    url: `https://news.ycombinator.com/item?id=${id}`,
    locations: locationFrom(parts, remote),
    remote: remote || undefined,
    industry: [],
    source: "hn",
    signals: [
      { type: "hiring", date, text: line.slice(0, 400), url: `https://news.ycombinator.com/item?id=${id}` },
    ],
  };
}

export async function fetchHn(): Promise<Startup[]> {
  const story = await latestHiringStory();
  if (!story) return [];

  const item = await fetchJson<HNItem>(`${ITEM_URL}/${story.objectID}`);
  const date = item.created_at ?? story.created_at;
  const out: Startup[] = [];

  for (const child of item.children ?? []) {
    if (!child.text) continue;
    // Each comment has its own timestamp; the thread's creation date can be
    // weeks old, which would make every post look stale.
    const startup = parseComment(child.text, child.created_at ?? date, child.id);
    if (startup) out.push(startup);
  }

  return out;
}
