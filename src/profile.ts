import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type {
  Education,
  Preferences,
  Profile,
  ProfileLinks,
  ProjectLink,
} from "./types.js";

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseLinks(raw: unknown): ProfileLinks | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;

  const projects: Record<string, ProjectLink> = {};
  if (obj.projects && typeof obj.projects === "object") {
    for (const [key, val] of Object.entries(obj.projects as Record<string, unknown>)) {
      if (val && typeof val === "object") {
        const p = val as Record<string, unknown>;
        projects[key] = { live: optStr(p.live), github: optStr(p.github) };
      }
    }
  }

  const openSource: Record<string, string> = {};
  if (obj.open_source && typeof obj.open_source === "object") {
    for (const [key, val] of Object.entries(obj.open_source as Record<string, unknown>)) {
      const url = optStr(val);
      if (url) openSource[key] = url;
    }
  }

  return {
    portfolio: optStr(obj.portfolio),
    github: optStr(obj.github),
    linkedin: optStr(obj.linkedin),
    leetcode: optStr(obj.leetcode),
    email: optStr(obj.email),
    resume: optStr(obj.resume),
    projects,
    openSource,
  };
}

function parseEducation(raw: unknown): Education[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
    .map((e) => ({
      school: optStr(e.school) ?? "Unknown",
      degree: optStr(e.degree),
      start: optStr(e.start),
      end: optStr(e.end),
      location: optStr(e.location),
      score: optStr(e.score),
    }));
}

export function loadProfile(path: string): Profile {
  const raw = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") {
    throw new Error(`Profile at ${path} is empty or not a mapping.`);
  }

  const prefsRaw = (raw.preferences ?? {}) as Record<string, unknown>;

  const preferences: Preferences = {
    stages: strList(prefsRaw.stages).map((s) => s.toLowerCase()),
    remote: prefsRaw.remote === true,
    locations: strList(prefsRaw.locations),
    minEmployees:
      typeof prefsRaw.minEmployees === "number" ? prefsRaw.minEmployees : undefined,
    maxEmployees:
      typeof prefsRaw.maxEmployees === "number" ? prefsRaw.maxEmployees : undefined,
    visaStatus: optStr(prefsRaw.visaStatus),
    needsSponsorship:
      typeof prefsRaw.needsSponsorship === "boolean"
        ? prefsRaw.needsSponsorship
        : undefined,
    excludeCompanies: strList(prefsRaw.excludeCompanies).map((s) => s.toLowerCase()),
    excludeKeywords: strList(prefsRaw.excludeKeywords).map((s) => s.toLowerCase()),
    maxRequiredYears:
      typeof prefsRaw.maxRequiredYears === "number" && prefsRaw.maxRequiredYears >= 0
        ? prefsRaw.maxRequiredYears
        : undefined,
    maxAgeDays:
      typeof prefsRaw.maxAgeDays === "number" && prefsRaw.maxAgeDays > 0
        ? prefsRaw.maxAgeDays
        : undefined,
  };

  const profile: Profile = {
    name: optStr(raw.name) ?? "Unnamed",
    headline: optStr(raw.headline) ?? "",
    summary: optStr(raw.summary) ?? "",
    skills: strList(raw.skills).map((s) => s.toLowerCase()),
    domains: strList(raw.domains).map((s) => s.toLowerCase()),
    seniority: optStr(raw.seniority) ?? "mid",
    yearsExperience: typeof raw.yearsExperience === "number" ? raw.yearsExperience : 0,
    roles: strList(raw.roles).map((s) => s.toLowerCase()),
    highlights: strList(raw.highlights),
    preferences,
    links: parseLinks(raw.links),
    education: parseEducation(raw.education),
  };

  if (profile.skills.length === 0 && profile.domains.length === 0) {
    throw new Error(
      `Profile at ${path} has no skills or domains. Add some so the matcher has something to match on.`,
    );
  }

  return profile;
}
