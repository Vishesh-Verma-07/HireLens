import type { Match, Profile } from "../types.js";
import { localDate } from "../lib/date.js";

function fmtAmount(usd: number | undefined): string {
  if (!usd) return "";
  if (usd >= 1e9) return ` ($${(usd / 1e9).toFixed(1)}B)`;
  return ` ($${Math.round(usd / 1e6)}M)`;
}

function linkOrDash(url: string | undefined): string {
  if (!url) return "—";
  try {
    return `[${new URL(url).hostname}](${url})`;
  } catch {
    return url;
  }
}

function score(m: Match): number {
  return m.llm?.score ?? m.score;
}

function esc(html: string): string {
  return html
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function signalLine(m: Match): string {
  const sig = m.startup.signals[0];
  if (!sig?.text) return "";
  const text = sig.text.length > 240 ? `${sig.text.slice(0, 240)}…` : sig.text;
  return `${text}${fmtAmount(sig.amountUsd)}`;
}

function metaLine(m: Match): string {
  const s = m.startup;
  return [
    s.stage ?? "stage?",
    s.source,
    s.remote ? "remote" : s.locations.join(", ") || "location?",
    linkOrDash(s.url),
  ].join(" · ");
}

// ---------------------------------------------------------------------------
// Markdown (written to out/)
// ---------------------------------------------------------------------------

export function renderDigest(profile: Profile, matches: Match[], opts: { showAll: boolean }): string {
  const heading = `# Job matches for ${profile.name}`;
  const sub = `_${profile.headline || "no headline set"} · ${matches.length} match${matches.length === 1 ? "" : "es"} · ${localDate()}${opts.showAll ? " · all (incl. seen)" : " · new only"}_`;

  if (matches.length === 0) {
    return `${heading}\n\n${sub}\n\nNo new matches this run.\n`;
  }

  const lines: string[] = [heading, "", sub, ""];
  matches.forEach((m, i) => {
    const s = m.startup;
    lines.push(`## ${i + 1}. ${s.name} — ${score(m)}/100`);
    if (s.oneLiner) lines.push(`> ${s.oneLiner}`);
    lines.push("", metaLine(m));
    if (m.reasons.length) lines.push("", `**Why:** ${m.reasons.join("; ")}`);
    if (m.llm?.reason) lines.push("", `**LLM:** ${m.llm.reason}`);
    if (m.penalties.length) lines.push("", `**Watch out:** ${m.penalties.join("; ")}`);
    const sig = signalLine(m);
    if (sig) lines.push("", `**Signal:** ${sig}`);
    lines.push("");
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Plain text (email body fallback)
// ---------------------------------------------------------------------------

export function renderDigestText(
  profile: Profile,
  matches: Match[],
  opts: { startIndex?: number } = {},
): string {
  const start = opts.startIndex ?? 0;
  if (matches.length === 0) {
    return `No new matches right now for ${profile.name}.\n\nTry "refresh", or reply "help".`;
  }

  const out: string[] = [
    `${matches.length} match${matches.length === 1 ? "" : "es"} for ${profile.name}`,
    "",
  ];

  matches.forEach((m, i) => {
    const n = start + i + 1;
    out.push(`${n}. ${m.startup.name} — ${score(m)}/100`);
    if (m.startup.oneLiner) out.push(`   ${m.startup.oneLiner}`);
    out.push(`   ${m.startup.url ?? "—"}`);
    if (m.reasons.length) out.push(`   Why: ${m.reasons.join("; ")}`);
    if (m.penalties.length) out.push(`   Watch: ${m.penalties.join("; ")}`);
    out.push("");
  });

  out.push(`Reply with a number for details, "more" for the next batch, or "help".`);
  return out.join("\n");
}

export function renderMatchDetailText(m: Match, index: number): string {
  const s = m.startup;
  const lines = [`${index}. ${s.name} — ${score(m)}/100`];
  if (s.oneLiner) lines.push(s.oneLiner);
  lines.push("", metaLine(m));
  if (m.reasons.length) lines.push("", `Why: ${m.reasons.join("; ")}`);
  if (m.llm?.reason) lines.push("", `LLM: ${m.llm.reason}`);
  if (m.penalties.length) lines.push("", `Watch out: ${m.penalties.join("; ")}`);
  const sig = signalLine(m);
  if (sig) lines.push("", `Signal: ${sig}`);
  if (m.startup.url) lines.push("", s.url ?? "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML (email body)
// ---------------------------------------------------------------------------

function cardHtml(m: Match, index: number): string {
  const s = m.startup;
  const why = m.reasons.length
    ? `<div style="margin:6px 0;color:#334155;font-size:13px"><strong>Why:</strong> ${esc(m.reasons.join("; "))}</div>`
    : "";
  const watch = m.penalties.length
    ? `<div style="margin:6px 0;color:#9a3412;font-size:13px"><strong>Watch:</strong> ${esc(m.penalties.join("; "))}</div>`
    : "";
  const sig = signalLine(m);
  const sigHtml = sig
    ? `<div style="margin:6px 0;color:#475569;font-size:12px">${esc(sig)}</div>`
    : "";
  const link = s.url
    ? `<a href="${esc(s.url)}" style="color:#2563eb;font-size:13px">${esc(s.url)}</a>`
    : "";

  return `
  <div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin:0 0 12px">
    <div style="font-size:16px;font-weight:600;color:#0f172a">
      ${index}. ${esc(s.name)}
      <span style="float:right;color:#059669;font-size:13px;font-weight:600">${score(m)}/100</span>
    </div>
    ${s.oneLiner ? `<div style="color:#475569;font-size:13px;margin:4px 0">${esc(s.oneLiner)}</div>` : ""}
    <div style="color:#94a3b8;font-size:12px;margin:4px 0">${esc(
      [s.stage ?? "stage?", s.source, s.remote ? "remote" : s.locations.join(", ") || "location?"].join(" · "),
    )}</div>
    ${why}${watch}${sigHtml}
    <div style="margin-top:6px">${link}</div>
  </div>`;
}

export function renderDigestHtml(
  profile: Profile,
  matches: Match[],
  opts: { startIndex?: number } = {},
): string {
  const start = opts.startIndex ?? 0;
  const body = matches.length
    ? matches.map((m, i) => cardHtml(m, start + i + 1)).join("")
    : `<p style="color:#475569">No new matches right now. Reply <strong>refresh</strong> to re-run.</p>`;

  return `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:640px;margin:0 auto;padding:24px">
    <h1 style="font-size:18px;color:#0f172a;margin:0 0 4px">Your matches, ${esc(profile.name)}</h1>
    <p style="color:#64748b;font-size:13px;margin:0 0 16px">${esc(profile.headline)}</p>
    ${body}
    <p style="color:#94a3b8;font-size:12px;margin-top:16px">
      Reply with a number for details, <strong>more</strong> for the next batch,
      <strong>refresh</strong> to re-run, or <strong>help</strong>.
    </p>
  </div>
</body></html>`;
}

export function renderMatchDetailHtml(m: Match, index: number): string {
  return `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:640px;margin:0 auto;padding:24px">
    ${cardHtml(m, index)}
  </div></body></html>`;
}
