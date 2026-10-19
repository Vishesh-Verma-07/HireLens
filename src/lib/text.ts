/** Small text helpers shared by the sources and the scorer. */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/** Strip HTML to plain text. Good enough for feeds and HN comments. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
      .replace(/<\s*br\s*\/?\s*>/gi, "\n")
      .replace(/<\s*\/\s*p\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return (line ?? "").trim();
}

export function daysSince(iso: string | undefined, now = Date.now()): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.round((now - t) / 86_400_000));
}

export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a word-boundary pattern for a profile term.
 *
 * Substring matching is too loose: "java" would match "javascript", "react"
 * would match "reactive", "go" would match "google". The lookarounds require
 * the term to stand on its own. Multi-word terms match across any whitespace.
 */
export function termPattern(term: string): RegExp {
  const escaped = escapeRegex(term.trim()).replace(/ +/g, "\\s+");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i");
}

const TECH_ROLE =
  /(?<![a-z])(engineer|engineering|developer|programmer|software|full[- ]?stack|front[- ]?end|back[- ]?end|devops|sre|platform|architect|data scientist|machine learning|ml|ai)(?![a-z])/i;
const NON_TECH_ROLE =
  /(?<![a-z])(sales|account manager|account executive|recruiter|talent|marketing|customer success|support)(?![a-z])/i;

/**
 * Keeps generic job APIs from flooding the digest with sales, finance and
 * operations roles. Only clearly technical titles get through.
 */
export function isTechRole(title: string): boolean {
  return TECH_ROLE.test(title) && !NON_TECH_ROLE.test(title);
}
