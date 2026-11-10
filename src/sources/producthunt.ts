import { slug } from "../lib/text.js";
import type { SourceId, Startup } from "../types.js";
import type { BaseSourceConfig, SourceContext } from "./types.js";
import { fetchFeed } from "./rss.js";

export const sourceId = "producthunt" as const satisfies SourceId;

export interface ProductHuntConfig extends BaseSourceConfig {
  feeds?: string[];
}

export async function fetchProductHunt(
  config: ProductHuntConfig = {},
  _context?: SourceContext,
): Promise<Startup[]> {
  const feeds = config.feeds ?? [];
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
        source: sourceId,
        signals: [{ type: "launched", date: item.date, text: item.title, url: item.link }],
      });
    }
  }

  return out;
}
