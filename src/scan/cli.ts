// `npm run scan` — preview the Google queries used by the matcher.
//
// The scan source in src/sources/google.ts runs these exact queries, ranks
// what it finds, and lets the normal digest/email pipeline pick the matches.
// This CLI is the inspectable, no-network view of that query.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { localDate } from "../lib/date.js";
import { loadProfile } from "../profile.js";
import { allBoards } from "./boards.js";
import {
  LEVELS,
  SETUPS,
  TIMES,
  isLevelId,
  isSetupId,
  isTimeId,
  scanForProfile,
  timeLabel,
  type LevelId,
  type ResolvedScan,
  type SetupId,
  type TimeId,
} from "./query.js";

interface ScanArgs {
  roles?: string[];
  location?: string;
  time: TimeId;
  level?: LevelId;
  setup?: SetupId;
  boards: string;
  variants: boolean;
  sponsored: boolean;
  open: boolean;
  write: boolean;
  json: boolean;
  help: boolean;
}

function value(argv: string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`${flag} needs a value`);
  }
  return next;
}

function parseArgs(argv: string[]): ScanArgs {
  const args: ScanArgs = {
    time: "d1",
    boards: "core",
    variants: false,
    sponsored: true,
    open: false,
    write: true,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    switch (arg) {
      case "--role":
      case "--roles": {
        const raw = value(argv, i, arg);
        args.roles = [
          ...(args.roles ?? []),
          ...raw.split(",").map((s) => s.trim()).filter(Boolean),
        ];
        i++;
        break;
      }
      case "--location":
        args.location = value(argv, i, arg);
        i++;
        break;
      case "--posted": {
        const raw = value(argv, i, arg);
        if (!isTimeId(raw)) {
          throw new Error(`Unknown --posted value "${raw}". Choose: ${TIMES.map((t) => t.id).join(", ")}`);
        }
        args.time = raw;
        i++;
        break;
      }
      case "--level": {
        const raw = value(argv, i, arg);
        if (!isLevelId(raw)) {
          throw new Error(`Unknown --level value "${raw}". Choose: ${LEVELS.map((l) => l.id).join(", ")}`);
        }
        args.level = raw;
        i++;
        break;
      }
      case "--setup": {
        const raw = value(argv, i, arg);
        if (!isSetupId(raw)) {
          throw new Error(`Unknown --setup value "${raw}". Choose: ${SETUPS.map((s) => s.id).join(", ")}`);
        }
        args.setup = raw;
        i++;
        break;
      }
      case "--boards":
        args.boards = value(argv, i, arg);
        i++;
        break;
      case "--variants":
        args.variants = true;
        break;
      case "--no-sponsored":
        args.sponsored = false;
        break;
      case "--open":
        args.open = true;
        break;
      case "--no-write":
        args.write = false;
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown option "${arg}". Run with --help.`);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`Board Scan — compile the Google queries used by the matcher.

Usage: npm run scan -- [options]

Options:
  --role <a,b>       job titles (default: first 4 roles in profile.yaml)
  --location <text>  location phrase (default: Remote when preferences.remote)
  --posted <id>      ${TIMES.map((t) => t.id).join("|")} (default: d1)
  --level <id>       ${LEVELS.map((l) => l.id).join("|")}
  --setup <id>       ${SETUPS.map((s) => s.id).join("|")}
  --boards <preset>  core|all|remote|public|none, or comma-separated board ids
  --variants         add common title swaps (engineer <-> developer, ...)
  --no-sponsored     drop the Secret Remote sponsored board
  --open             open every Google run URL in the default browser
  --no-write         don't write out/scan-<date>.md
  --json             print the plan as JSON
  --help             show this help

Presets:
  core     ATS boards (Greenhouse, Lever, Ashby, Workday, Workable, ...)
  all      every board in the catalogue
  remote   remote-first boards
  public   government and public-sector boards

Board ids: ${allBoards().map((b) => b.id).join(", ")}

To search and rank now: npm run match -- --source google`);
}

function levelLabel(id: LevelId): string {
  return LEVELS.find((l) => l.id === id)?.label ?? id;
}

function setupLabel(id: SetupId): string {
  return SETUPS.find((s) => s.id === id)?.label ?? id;
}

function scopeLine(scan: ResolvedScan): string {
  const location = scan.location ? scan.location : "any location";
  return `${location} · ${levelLabel(scan.level)} · ${setupLabel(scan.setup)} · ${timeLabel(scan.time)} · Google`;
}

interface ScanMeta {
  date: string;
  profileName: string;
  scan: ResolvedScan;
}

function renderText(meta: ScanMeta): string {
  const { scan } = meta;
  const lines: string[] = [
    `Board Scan — ${meta.date}`,
    `Profile: ${meta.profileName}`,
    `Roles:   ${scan.roles.join(", ")}`,
    `Scope:   ${scopeLine(scan)}`,
    `Boards:  ${scan.plan.boards} (${scan.boardsSpec}) · ${scan.plan.terms} terms`,
    "",
  ];

  if (!scan.plan.ready) {
    lines.push("Nothing to scan: add roles with --role or profile.yaml, and select a board.");
    return lines.join("\n");
  }

  if (scan.plan.warning) lines.push(`Warning: ${scan.plan.warning}`, "");

  for (const run of scan.plan.runs) {
    lines.push(`${run.label}:`);
    lines.push(`  ${run.query}`);
    lines.push(`  ${run.url}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function renderMarkdown(meta: ScanMeta): string {
  const { scan } = meta;
  const lines: string[] = [
    `# Board Scan — ${meta.date}`,
    "",
    `- **Profile:** ${meta.profileName}`,
    `- **Roles:** ${scan.roles.join(", ")}`,
    `- **Scope:** ${scopeLine(scan)}`,
    `- **Boards:** ${scan.plan.boards} (${scan.boardsSpec})`,
    `- **Terms:** ${scan.plan.terms}`,
    "",
  ];

  if (!scan.plan.ready) {
    lines.push("Nothing to scan: add roles with `--role` or `profile.yaml`, and select a board.");
    return `${lines.join("\n")}\n`;
  }

  if (scan.plan.warning) lines.push(`> **Warning:** ${scan.plan.warning}`, "");

  for (const run of scan.plan.runs) {
    lines.push(
      `## ${run.label}`,
      "",
      "```text",
      run.query,
      "```",
      "",
      run.url,
      "",
    );
  }

  return lines.join("\n");
}

function openExternal(url: string): void {
  const command =
    process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.unref();
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const root = resolve(import.meta.dirname, "..", "..");
  const profile = loadProfile(resolve(root, "profile", "profile.yaml"));
  const date = localDate();

  const scan = scanForProfile(profile, {
    roles: args.roles,
    location: args.location,
    time: args.time,
    level: args.level,
    setup: args.setup,
    boards: args.boards,
    variants: args.variants,
    sponsored: args.sponsored,
  });

  const meta: ScanMeta = { date, profileName: profile.name, scan };

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          date,
          profile: profile.name,
          search: "google",
          roles: scan.roles,
          location: scan.location,
          time: scan.time,
          level: scan.level,
          setup: scan.setup,
          boards: scan.plan.boards,
          terms: scan.plan.terms,
          ready: scan.plan.ready,
          warning: scan.plan.warning,
          runs: scan.plan.runs,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(renderText(meta));
  }

  if (args.write) {
    const outDir = resolve(root, "out");
    mkdirSync(outDir, { recursive: true });
    const file = resolve(outDir, `scan-${date}.md`);
    writeFileSync(file, renderMarkdown(meta), "utf8");
    if (!args.json) console.log(`\nWrote ${file}`);
  }

  if (args.open && scan.plan.ready) {
    for (const run of scan.plan.runs) openExternal(run.url);
    if (!args.json) console.log(`Opened ${scan.plan.runs.length} run(s) in the default browser.`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`scan: ${message}`);
  process.exitCode = 1;
}
