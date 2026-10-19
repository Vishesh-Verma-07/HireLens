import { XMLParser } from "fast-xml-parser";
import { fetchText } from "../lib/http.js";
import { htmlToText } from "../lib/text.js";

export interface FeedItem {
  title: string;
  link?: string;
  date?: string;
  summary?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["#text"] === "string") return obj["#text"];
  }
  return "";
}

/** Minimal RSS/Atom reader. Returns normalized items. */
export async function fetchFeed(url: string): Promise<FeedItem[]> {
  const xml = await fetchText(url, { headers: { accept: "application/rss+xml, application/xml, text/xml" } });
  const doc = parser.parse(xml) as Record<string, any>;

  const rssItems = asArray(doc?.rss?.channel?.item);
  const atomEntries = asArray(doc?.feed?.entry);
  const raw = [...rssItems, ...atomEntries];

  const items: FeedItem[] = [];
  for (const entry of raw as Record<string, any>[]) {
    const title = textOf(entry.title).trim();
    if (!title) continue;

    let link = textOf(entry.link);
    if (!link && entry.link && typeof entry.link === "object") {
      link = String(entry.link["@_href"] ?? "");
    }

    const date =
      textOf(entry.pubDate) || textOf(entry.published) || textOf(entry.updated) || undefined;

    const summaryRaw =
      textOf(entry.description) || textOf(entry.summary) || textOf(entry["content:encoded"]) || "";

    items.push({
      title,
      link: link || undefined,
      date,
      summary: summaryRaw ? htmlToText(summaryRaw).slice(0, 400) : undefined,
    });
  }

  return items;
}
