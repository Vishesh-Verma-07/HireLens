import { logger } from "../lib/log.js";
import type { Match, Profile } from "../types.js";

/**
 * OPTIONAL LLM re-rank. Off unless --llm is passed and OPENAI_API_KEY is set.
 *
 * Deliberately provider-agnostic: point OPENAI_BASE_URL at any
 * OpenAI-compatible endpoint. The deterministic score still runs first and
 * still gates the result; this only refines the top slice and adds a reason.
 */
export function llmAvailable(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

const SYSTEM = `You score how well a startup fits a candidate's job search.
Return ONLY JSON: {"score": <0-100 integer>, "reason": "<one sentence>"}.
Be strict: a startup that merely mentions a keyword the candidate knows is a low score.
Reward genuine overlap between what the candidate has built and what the startup does.`;

async function scoreOne(profile: Profile, match: Match, model: string): Promise<{ score: number; reason: string } | undefined> {
  const base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: JSON.stringify({
            candidate: {
              headline: profile.headline,
              skills: profile.skills,
              domains: profile.domains,
              roles: profile.roles,
              summary: profile.summary,
            },
            startup: {
              name: match.startup.name,
              oneLiner: match.startup.oneLiner,
              stage: match.startup.stage,
              industry: match.startup.industry,
              signals: match.startup.signals.map((s) => s.text ?? s.type),
            },
          }),
        },
      ],
    }),
  });

  if (!res.ok) {
    logger.warn(`llm: HTTP ${res.status}`);
    return undefined;
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return undefined;

  try {
    const parsed = JSON.parse(content) as { score?: number; reason?: string };
    if (typeof parsed.score !== "number") return undefined;
    return { score: parsed.score, reason: parsed.reason ?? "" };
  } catch {
    return undefined;
  }
}

/** Re-ranks the top `topN` matches, leaving the rest as-is. */
export async function llmRefine(profile: Profile, matches: Match[], topN = 20): Promise<Match[]> {
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const head = matches.slice(0, topN);
  const tail = matches.slice(topN);

  const refined = await Promise.all(
    head.map(async (m) => {
      const llm = await scoreOne(profile, m, model);
      return llm ? { ...m, llm } : m;
    }),
  );

  return [...refined, ...tail].sort((a, b) => {
    const aScore = a.llm?.score ?? a.score;
    const bScore = b.llm?.score ?? b.score;
    return bScore - aScore;
  });
}
