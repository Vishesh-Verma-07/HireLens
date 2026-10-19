import { slug } from "../lib/text.js";
import type { Startup } from "../types.js";
import { fetchFeed } from "./rss.js";

export async function fetchProductHunt(feeds: string[]): Promise<Startup[]> {
  const out: Startup[] = [];

  for (const feed of feeds) {
    const items = await fetchFeed(feed);
    for (const item of items) {
      // Product Hunt titles are usually "Name — tagline".
      const [rawName, ...rest] = item.title.split(/\s+[—-]\s+/);
      const name = (rawName ?? item.title).trim();
      if (!name) continue;

      out.push({
        id: `producthunt:${slug(name)}`,
        name,
        oneLiner: rest.join(" — ") || item.summary,
        url: item.link,
        locations: [],
        industry: [],
        source: "producthunt",
        signals: [{ type: "launched", date: item.date, text: item.title, url: item.link }],
      });
    }
  }

  return out;
}
