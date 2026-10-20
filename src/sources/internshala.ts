import { fetchText } from "../lib/http.js";
import { htmlToText, isTechRole } from "../lib/text.js";
import type { Startup } from "../types.js";

/**
 * Internshala's public fresher/junior job pages.
 *
 * This is the India-focused counterweight to the remote boards, which are
 * overwhelmingly senior. Each card carries a title, company, city, skills,
 * experience requirement and a relative posted date ("1 day ago"), which is
 * exactly what the freshness gate needs.
 *
 * No login or detail-page fetch is required: the listing cards are enough to
 * score a role, so one request per page.
 */

const PAGES = [
  "https://internshala.com/fresher-jobs/software-development-jobs",
  "https://internshala.com/jobs/software-development-jobs",
  "https://internshala.com/fresher-jobs/web-development-jobs",
  "https://internshala.com/fresher-jobs/full-stack-development-jobs",
  "https://internshala.com/fresher-jobs/node-js-development-jobs",
  "https://internshala.com/fresher-jobs/javascript-development-jobs",
];

/** A browser UA is required; the site returns a challenge page otherwise. */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

interface Card {
  id: string;
  title: string;
  company: string;
  href: string;
  locations: string[];
  experience?: string;
  about?: string;
  skills: string[];
  ageDays?: number;
}

function firstMatch(text: string, re: RegExp): string | undefined {
  return text.match(re)?.[1]?.trim();
}

function parseAgeDays(label: string | undefined): number | undefined {
  if (!label) return undefined;
  const s = label.toLowerCase().trim();
  if (/just now|today|hour/.test(s)) return 0;
  if (/yesterday/.test(s)) return 1;
  const m = s.match(/(\d+)\s*(day|week|month|year)/);
  if (!m) return undefined;
  const n = Number.parseInt(m[1] ?? "", 10);
  if (!Number.isFinite(n)) return undefined;
  switch (m[2]) {
    case "day":
      return n;
    case "week":
      return n * 7;
    case "month":
      return n * 30;
    default:
      return n * 365;
  }
}

function parseCards(html: string): Card[] {
  const starts = [...html.matchAll(/id="individual_internship_(\d+)"/g)].map((m) => m.index ?? 0);
  const cards: Card[] = [];

  for (let i = 0; i < starts.length; i++) {
    const chunk = html.slice(starts[i], starts[i + 1] ?? html.length);

    // The listing mixes full-time jobs and internships; keep jobs only.
    if (!/employment_type="job"/.test(chunk)) continue;

    const title = firstMatch(chunk, /class="job-title-href"[^>]*>([^<]+)</);
    const company = firstMatch(chunk, /class="company-name"[^>]*>\s*([^<]+?)\s*</);
    const href = firstMatch(chunk, /data-href='([^']+)'/);
    if (!title || !company || !href) continue;

    const locationBlock = chunk.match(/class="row-1-item locations"[\s\S]*?<\/p>/)?.[0] ?? "";
    const locations = [...locationBlock.matchAll(/<a[^>]*>([^<]+)<\/a>/g)]
      .map((m) => m[1]?.trim())
      .filter((x): x is string => Boolean(x));

    const experience = firstMatch(
      chunk,
      /ic-16-briefcase[\s\S]*?<span>([^<]+)<\/span>/,
    );
    const about = firstMatch(chunk, /class="about_job"[\s\S]*?<div class="text">([\s\S]*?)<\/div>/);
    const skills = [...chunk.matchAll(/class=['"]job_skill['"][^>]*>([^<]+)</g)]
      .map((m) => m[1]?.trim())
      .filter((x): x is string => Boolean(x));

    // "1 day ago" / "1 week ago" lives in one of several status-* classes.
    const ageLabel = firstMatch(
      chunk,
      /class="status-(?:info|inactive|success|warning|danger)"[\s\S]*?<span>([^<]+)<\/span>/,
    );

    cards.push({
      id: firstMatch(chunk, /internshipId="(\d+)"/) ?? href,
      title,
      company,
      href,
      locations,
      experience,
      about,
      skills,
      ageDays: parseAgeDays(ageLabel),
    });
  }

  return cards;
}

export async function fetchInternshala(limit: number): Promise<Startup[]> {
  const cardsById = new Map<string, Card>();

  for (const page of PAGES) {
    let html: string;
    try {
      html = await fetchText(page, {
        headers: {
          "user-agent": BROWSER_UA,
          accept: "text/html,application/xhtml+xml",
        },
      });
    } catch {
      continue;
    }

    for (const card of parseCards(html)) {
      if (!cardsById.has(card.id)) cardsById.set(card.id, card);
    }
  }

  // Newest first, so the limit is spent on fresh roles across every category
  // page rather than on page 1's older listings.
  const cards = [...cardsById.values()]
    .filter((c) => c.ageDays !== undefined && isTechRole(c.title))
    .sort((a, b) => (a.ageDays ?? 0) - (b.ageDays ?? 0));

  const out: Startup[] = [];
  const now = Date.now();

  for (const card of cards) {
    if (out.length >= limit) break;

    const url = `https://internshala.com${card.href}`;
    const remote = /remote|work from home|wfh/i.test(card.locations.join(" "));
    const locations = [...new Set([...card.locations, ...(remote ? ["Remote"] : []), "India"])];

    const description = [
      card.about ? htmlToText(card.about) : "",
      card.skills.length ? `Skills: ${card.skills.join(", ")}` : "",
      card.experience ? `Experience: ${card.experience}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    out.push({
      id: `internshala:${card.id}`,
      name: card.company,
      oneLiner: card.title,
      description: description || undefined,
      url,
      locations,
      remote: remote || undefined,
      industry: [],
      source: "internshala",
      signals: [
        {
          type: "hiring",
          date: new Date(now - (card.ageDays ?? 0) * 86_400_000).toISOString(),
          text: `${card.company} — ${card.title} (${card.locations.join(", ") || "India"})`,
          url,
        },
      ],
    });
  }

  return out;
}
