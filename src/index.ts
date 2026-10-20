import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./lib/log.js";
import { localDate } from "./lib/date.js";
import { llmAvailable, llmRefine } from "./match/llm.js";
import { rankStartups } from "./match/rank.js";
import { loadProfile } from "./profile.js";
import { renderDigest } from "./report/digest.js";
import { collectStartups, loadSourceConfig } from "./sources/index.js";
import { loadStore, markSeen, saveStore } from "./store/db.js";

interface Args {
  limit: number;
  showAll: boolean;
  useLlm: boolean;
  write: boolean;
  sources?: Set<string>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 15, showAll: false, useLlm: false, write: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") args.showAll = true;
    else if (a === "--llm") args.useLlm = true;
    else if (a === "--no-write") args.write = false;
    else if (a === "--limit") args.limit = Number.parseInt(argv[++i] ?? "15", 10);
    else if (a === "--source") args.sources = new Set((argv[++i] ?? "").split(",").filter(Boolean));
  }
  return args;
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const args = parseArgs(process.argv.slice(2));

  const profile = loadProfile(resolve(root, "profile", "profile.yaml"));
  const sourceConfig = loadSourceConfig(resolve(root, "config", "sources.yaml"));
  const storePath = resolve(root, "data", "store.json");

  logger.info(`Profile: ${profile.name} (${profile.skills.length} skills, ${profile.domains.length} domains)`);

  const startups = await collectStartups(sourceConfig, { only: args.sources });
  logger.info(`Collected ${startups.length} raw startup records`);

  const ranked = rankStartups(startups, profile);

  if (args.useLlm) {
    if (llmAvailable()) {
      logger.info("Refining top matches with LLM");
      const refined = await llmRefine(profile, ranked, 20);
      ranked.splice(0, ranked.length, ...refined);
    } else {
      logger.warn("--llm passed but OPENAI_API_KEY is not set; skipping LLM refine");
    }
  }

  const store = loadStore(storePath);
  const fresh = args.showAll ? ranked : ranked.filter((m) => !store.seen[m.startup.id]);
  const top = fresh.slice(0, args.limit);

  const digest = renderDigest(profile, top, { showAll: args.showAll });
  console.log(`\n${digest}`);

  if (args.write) {
    const outDir = resolve(root, "out");
    mkdirSync(outDir, { recursive: true });
    const stamp = localDate();
    const outPath = resolve(outDir, `digest-${stamp}.md`);
    writeFileSync(outPath, digest, "utf8");
    markSeen(store, top.map((m) => m.startup.id));
    saveStore(storePath, store);
    logger.info(`Wrote ${outPath} and updated ${storePath}`);
  }

  logger.info(`${fresh.length} new matches; showing top ${top.length}`);
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
