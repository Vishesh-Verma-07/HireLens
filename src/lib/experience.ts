/**
 * Pull a minimum "years of experience" requirement out of free-form job text.
 *
 * This is deliberately conservative:
 *  - only sentences that actually mention experience/yoe are considered, so
 *    "we've been building for 10 years" doesn't disqualify a role;
 *  - company/team self-descriptions ("our team has 15 years") are ignored;
 *  - ranges use the lower bound ("3-5 years" -> 3).
 */
export function requiredYears(text: string | undefined): number | undefined {
  if (!text) return undefined;

  const hay = text
    .replace(/\s+/g, " ")
    .replace(/year\(s\)/gi, "years")
    .replace(/yr\(s\)/gi, "yrs");
  const sentences = hay.split(/(?<=[.!?;])\s+|\n+/);

  const patterns = [
    // 3-5 years / 3 to 5 years
    /(\d{1,2})\s*(?:-|–|to)\s*\d{1,2}\s*(?:years?|yrs?)/gi,
    // 3+ years
    /(\d{1,2})\s*\+\s*(?:years?|yrs?)/gi,
    // minimum 3 years / at least 3 years
    /(?:minimum|min\.?|at least)\s*(?:of\s*)?(\d{1,2})\s*(?:years?|yrs?)/gi,
    // 3 years of professional experience / 3 years experience / 3 years yoe
    /(\d{1,2})\s*(?:years?|yrs?)\s*(?:of\s+)?(?:[a-z-]+\s+){0,3}(?:experience|exp\b|yoe)/gi,
    // Experience: 1 year / experience required: 2 years
    /(?:experience|exp)\s*(?:required|needed)?\s*[:\-–]?\s*(\d{1,2})\s*(?:years?|yrs?)/gi,
  ];

  let max: number | undefined;

  for (const sentence of sentences) {
    if (!/\b(experience|exp|yoe)\b/i.test(sentence)) continue;

    // Skip "we have 12 years of experience" style company blurbs, unless the
    // same sentence is clearly about what the candidate needs.
    const aboutCompany = /\b(we|our|company|team|founded|since)\b/i.test(sentence);
    const aboutCandidate = /\byou\b|\byou'll\b|\bcandidate\b|\brole\b|\brequire/i.test(sentence);
    if (aboutCompany && !aboutCandidate) continue;

    for (const pattern of patterns) {
      for (const match of sentence.matchAll(pattern)) {
        const n = Number.parseInt(match[1] ?? "", 10);
        if (Number.isFinite(n) && n > 0 && n <= 20) {
          max = Math.max(max ?? 0, n);
        }
      }
    }
  }

  return max;
}
