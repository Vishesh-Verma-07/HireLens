// Board catalogue for the "Board Scan" query compiler.
//
// These are the public domains the scanner can target with `site:` clauses.
// The data mirrors the board list published by jobboardscan.com, but it is
// kept local so the scan works without depending on that site.

export interface Board {
  /** Stable short id, e.g. "gh" for Greenhouse. */
  id: string;
  name: string;
  /** Host used in the `site:` clause. `*` is the search engine's wildcard. */
  domain: string;
  /** Core systems are selected by the `core` preset. */
  core: boolean;
  /** The sponsored remote board, always available under its own id. */
  sponsored?: boolean;
}

export interface BoardGroup {
  name: string;
  core: boolean;
  boards: Board[];
}

export const SPONSORED_BOARD_ID = "sr2";

type Seed = readonly [name: string, domain: string, id: string];

function group(name: string, core: boolean, seeds: Seed[]): BoardGroup {
  return {
    name,
    core,
    boards: seeds.map(([boardName, domain, id]) => ({
      id,
      name: boardName,
      domain,
      core,
    })),
  };
}

export const BOARD_GROUPS: BoardGroup[] = [
  group("Applicant tracking systems", true, [
    ["Greenhouse", "job-boards.greenhouse.io", "gh"],
    ["Greenhouse (legacy)", "boards.greenhouse.io", "gh2"],
    ["Lever", "jobs.lever.co", "lv"],
    ["Ashby", "jobs.ashbyhq.com", "ash"],
    ["Workday", "*.myworkdayjobs.com", "wd"],
    ["Workable", "apply.workable.com", "wk"],
    ["SmartRecruiters", "jobs.smartrecruiters.com", "sr"],
    ["Rippling", "ats.rippling.com", "rp"],
    ["BambooHR", "*.bamboohr.com", "bhr"],
    ["Breezy", "*.breezy.hr", "brz"],
    ["Teamtailor", "*.teamtailor.com", "tt"],
    ["Recruitee", "*.recruitee.com", "rc"],
    ["Pinpoint", "*.pinpointhq.com", "pp"],
    ["JazzHR", "*.applytojob.com", "jz"],
    ["Personio", "*.jobs.personio.com", "pers"],
  ]),
  group("Enterprise systems", false, [
    ["iCIMS", "*.icims.com", "ic"],
    ["Taleo", "*.taleo.net", "tl"],
    ["SuccessFactors", "*.successfactors.com", "sf"],
    ["UKG / UltiPro", "*.ultipro.com", "ukg"],
    ["Paycom", "*.paycomonline.net", "pcm"],
    ["Paylocity", "recruiting.paylocity.com", "pl"],
    ["ADP", "workforcenow.adp.com", "adp"],
    ["Jobvite", "jobs.jobvite.com", "jv"],
    ["Eightfold", "*.eightfold.ai", "ef"],
  ]),
  group("Startups and tech", false, [
    ["Wellfound", "wellfound.com", "wf"],
    ["Work at a Startup", "workatastartup.com", "was"],
    ["Built In", "builtin.com", "bi"],
    ["Dice", "dice.com", "dc"],
  ]),
  group("Remote-first boards", false, [
    ["Secret Remote", "secretremote.com", "sr2"],
    ["We Work Remotely", "weworkremotely.com", "wwr"],
    ["Working Nomads", "workingnomads.com", "wnom"],
    ["RemoteOK", "remoteok.com", "rok"],
    ["Remotive", "remotive.com", "rmv"],
    ["Himalayas", "himalayas.app", "him"],
  ]),
  group("Government and public sector", false, [
    ["USAJOBS (federal)", "usajobs.gov", "usa"],
    ["GovernmentJobs (state, city)", "governmentjobs.com", "gvj"],
    ["HigherEdJobs", "higheredjobs.com", "hed"],
    ["SchoolSpring (K-12)", "schoolspring.com", "ssp"],
    ["Bundesagentur für Arbeit", "arbeitsagentur.de", "bua"],
  ]),
];

/** Every board, with the sponsored flag applied. */
export function allBoards(): Board[] {
  return BOARD_GROUPS.flatMap((g) => g.boards).map((b) =>
    b.id === SPONSORED_BOARD_ID ? { ...b, sponsored: true } : b,
  );
}

export function boardById(id: string): Board | undefined {
  return allBoards().find((b) => b.id === id);
}

export type BoardPreset = "core" | "all" | "remote" | "public" | "none";

export const BOARD_PRESETS: Record<string, BoardPreset> = {
  core: "core",
  "core systems": "core",
  all: "all",
  everything: "all",
  remote: "remote",
  "remote boards": "remote",
  public: "public",
  "public sector": "public",
  "government and public sector": "public",
  none: "none",
};

export function presetBoards(preset: BoardPreset): Board[] {
  const picked =
    preset === "none"
      ? []
      : preset === "all"
        ? BOARD_GROUPS
        : preset === "core"
          ? BOARD_GROUPS.filter((g) => g.core)
          : preset === "remote"
            ? BOARD_GROUPS.filter((g) => g.name === "Remote-first boards")
            : BOARD_GROUPS.filter((g) => g.name === "Government and public sector");

  return picked
    .flatMap((g) => g.boards)
    .map((b) => (b.id === SPONSORED_BOARD_ID ? { ...b, sponsored: true } : b));
}

/**
 * Resolves a preset name or comma-separated board ids.
 *
 * `none` is explicit and never gets the sponsored board added back; every
 * other selection includes it unless `includeSponsored` is false.
 */
export function selectBoards(spec: string, includeSponsored = true): Board[] {
  const preset = BOARD_PRESETS[spec.trim().toLowerCase()];
  let picked: Board[];

  if (preset) {
    picked = presetBoards(preset);
    if (preset === "none") return [];
  } else {
    const ids = spec.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return [];
    const byId = new Map(allBoards().map((b) => [b.id, b]));
    const unknown: string[] = [];
    picked = [];

    for (const id of ids) {
      const board = byId.get(id);
      if (board) picked.push(board);
      else unknown.push(id);
    }

    if (unknown.length > 0) {
      throw new Error(`Unknown board id(s): ${unknown.join(", ")}. Use a preset or see --help.`);
    }
  }

  if (!includeSponsored) {
    return picked.filter((b) => b.id !== SPONSORED_BOARD_ID);
  }

  const sponsored = boardById(SPONSORED_BOARD_ID);
  if (sponsored && !picked.some((b) => b.id === sponsored.id)) {
    picked.push(sponsored);
  }

  return picked;
}
