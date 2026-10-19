import { slug } from "../lib/text.js";
import type { Startup } from "../types.js";
import { fetchFeed, type FeedItem } from "./rss.js";

const RAISE_VERB =
  /^(.{2,60}?)[\s,]+(?:has\s+)?(?:raises|raised|lands|landed|secures|secured|closes|closed|nabs|nabbed|scores|scored|snags|hauls|bags|gets|is\s+raising|pulls\s+in)\b/i;

const DESCRIPTORS =
  /^(?:the|a|an|startup|viral|ai|yc-backed|ex-google|indian|us|uk|french|german|buzzy|hot|this)\s+/i;

function companyFromTitle(title: string): string | undefined {
  const m = title.trim().match(RAISE_VERB);
  if (!m?.[1]) return undefined;

  // Strip leading filler ("Viral AI startup Instinct" -> "AI startup Instinct").
  let candidate = m[1].trim();
  for (let i = 0; i < 3 && DESCRIPTORS.test(candidate); i++) {
    candidate = candidate.replace(DESCRIPTORS, "");
  }

  // Keep the trailing run of capitalized tokens ("AI startup Instinct" -> "Instinct").
  const tokens = candidate.split(/\s+/);
  const kept: string[] = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i] ?? "";
    if (/^[A-Z0-9]/.test(tok)) kept.unshift(tok);
    else break;
  }

  const name = (kept.length ? kept : tokens.slice(-2)).join(" ").trim();
  if (!name || name.length > 40) return undefined;
  return name;
}

function amountUsd(title: string): number | undefined {
  const m = title.match(/\$\s?([\d.]+)\s*(billion|million|b|m)\b/i);
  if (!m) return undefined;
  const value = Number.parseFloat(m[1] ?? "0");
  const mult = (m[2] ?? "").toLowerCase().startsWith("b") ? 1_000_000_000 : 1_000_000;
  return Math.round(value * mult);
}

function stageFromTitle(title: string): string | undefined {
  if (/pre[- ]?seed/i.test(title)) return "pre-seed";
  const series = title.match(/series\s+([a-e])\b/i);
  if (series?.[1]) return `series-${series[1].toLowerCase()}`;
  if (/\bseed\b/i.test(title)) return "seed";
  return undefined;
}

export async function fetchFunding(feeds: string[]): Promise<Startup[]> {
  const out: Startup[] = [];

  for (const feed of feeds) {
    let items: FeedItem[];
    try {
      items = await fetchFeed(feed);
    } catch {
      continue; // a dead feed shouldn't sink the source
    }

    for (const item of items) {
      if (!/(rais|fund|seed|series [a-e]|invest|backed)/i.test(item.title)) continue;

      const name = companyFromTitle(item.title);
      if (!name) continue;

      out.push({
        id: `funding:${slug(name)}`,
        name,
        oneLiner: item.title,
        url: item.link,
        locations: [],
        stage: stageFromTitle(item.title),
        industry: [],
        source: "funding",
        signals: [
          {
            type: "raised",
            date: item.date,
            text: item.title,
            url: item.link,
            amountUsd: amountUsd(item.title),
          },
        ],
      });
    }
  }

  return out;
}
