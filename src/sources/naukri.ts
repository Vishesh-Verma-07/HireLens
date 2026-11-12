import { fetchText } from "../lib/http.js";
import { logger } from "../lib/log.js";
import { isTechRole, normalizeWhitespace } from "../lib/text.js";
import type { SourceId, Startup } from "../types.js";
import type { BaseSourceConfig, SourceContext } from "./types.js";

export const sourceId = "naukri" as const satisfies SourceId;

export interface NaukriConfig extends BaseSourceConfig {
  /** Maximum number of postings to return. */
  limit?: number;
  /**
   * Job families to keep. Known values are `it-software` and `engineering`;
   * unknown values are ignored. Defaults to both.
   */
  categories?: string[];
  /** Single sitemap override, used by tests. */
  sitemapUrl?: string;
  /** Several sitemaps to scan, used instead of `sitemapUrl`. */
  sitemaps?: string[];
  /** Upper bound on the number of sitemap entries parsed per run. */
  scanLimit?: number;
}

/**
 * Naukri's job pages are a client-rendered Next.js shell: the server HTML has
 * no title, company, description, or JSON-LD, and the `jobapi` endpoints answer
 * `406 recaptcha required`. What *is* public and captcha-free is the job
 * sitemap: every entry is a real posting whose URL encodes the title, company,
 * locations, experience range, and job id, and whose `<lastmod>` is refreshed
 * daily.
 *
 * The Bengaluru sitemap is the smallest current one that is not gzipped, so it
 * is the default. `sitemaps` can add the other city files (Ahmedabad, Kolkata,
 * Noida, Delhi are plain XML; Mumbai, Pune, Chennai, Hyderabad and OtherCities
 * are gzipped and need a byte-level fetch).
 *
 * The title/company boundary is inferred from the URL slug (see
 * `parseJobUrl`); it is right for the common "role + employer + city" shape and
 * documented as a limitation for slugs that interleave extra words.
 */
const DEFAULT_SITEMAP_URL =
  "https://www.naukri.com/sitemap/jobDescPagesBangalore.xml";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DEFAULT_LIMIT = 100;
/** Upper bound on sitemap entries considered per run. */
const MAX_SCAN_LIMIT = 2_000;

/** Naukri location tokens, lower-case and hyphenated as they appear in slugs. */
const CITY_TOKENS = new Set([
  "bengaluru",
  "bangalore",
  "mumbai",
  "delhi",
  "new-delhi",
  "noida",
  "greater-noida",
  "gurugram",
  "gurgaon",
  "pune",
  "hyderabad",
  "chennai",
  "kolkata",
  "ahmedabad",
  "kochi",
  "cochin",
  "jaipur",
  "indore",
  "chandigarh",
  "coimbatore",
  "bhubaneswar",
  "ranchi",
  "vapi",
  "valsad",
  "zirakpur",
  "tambaram",
  "secunderabad",
  "vadodara",
  "surat",
  "nagpur",
  "lucknow",
  "kanpur",
  "patna",
  "bhopal",
  "visakhapatnam",
  "vijayawada",
  "mysuru",
  "mysore",
  "mangaluru",
  "trivandrum",
  "thiruvananthapuram",
  "kozhikode",
  "calicut",
  "goa",
  "dehradun",
  "jodhpur",
  "udaipur",
  "agra",
  "meerut",
  "faridabad",
  "ghaziabad",
  "navi-mumbai",
  "thane",
  "nashik",
  "aurangabad",
  "rajkot",
  "gandhinagar",
  "ludhiana",
  "amritsar",
  "jalandhar",
  "bathinda",
  "hisar",
  "rohtak",
  "sonipat",
  "panipat",
  "karnal",
  "shimla",
  "jammu",
  "srinagar",
  "guwahati",
  "siliguri",
  "durgapur",
  "asansol",
  "jamshedpur",
  "raipur",
  "bilaspur",
  "jabalpur",
  "gwalior",
  "ujjain",
  "kolhapur",
  "solapur",
  "sangli",
  "satara",
  "ahmednagar",
  "tiruchirappalli",
  "trichy",
  "madurai",
  "salem",
  "tirunelveli",
  "erode",
  "vellore",
  "hosur",
  "puducherry",
  "pondicherry",
  "warangal",
  "nizamabad",
  "karimnagar",
  "guntur",
  "nellore",
  "tirupati",
  "rajahmundry",
  "kakinada",
  "kollam",
  "kottayam",
  "thrissur",
  "palakkad",
  "kannur",
  "malappuram",
  "bangarapet",
  "hospet",
  "hubli",
  "dharwad",
  "belgaum",
  "belagavi",
  "gulbarga",
  "kalaburagi",
  "davanagere",
  "shivamogga",
  "shimoga",
  "tumkur",
  "tumakuru",
  "udupi",
  "manipal",
  "hassan",
  "mandya",
  "kolar",
  "chikkaballapur",
  "kadapa",
  "anantapur",
  "kurnool",
  "ongole",
  "eluru",
  "srikakulam",
  "vizianagaram",
  "port-blair",
  "ajmer",
  "bikaner",
  "alwar",
  "kota",
  "bhilwara",
  "sikar",
  "pali",
  "bhiwadi",
  "neemrana",
  "haridwar",
  "roorkee",
  "nainital",
  "haldwani",
  "rudrapur",
  "kashipur",
  "mohali",
  "panchkula",
  "bahadurgarh",
  "india",
  "malaysia",
  "singapore",
  "dubai",
  "abu-dhabi",
  "qatar",
  "saudi-arabia",
  "riyadh",
  "doha",
  "kuwait",
  "bahrain",
  "oman",
  "muscat",
  "london",
  "united-kingdom",
  "usa",
  "united-states",
  "canada",
  "australia",
  "germany",
  "netherlands",
  "ireland",
  "poland",
  "japan",
  "philippines",
  "vietnam",
  "indonesia",
  "south-africa",
  "kenya",
  "nigeria",
]);

/** Location words that ride along with a city but are not part of a company. */
const LOCATION_MODIFIERS = new Set([
  "rural",
  "all",
  "areas",
  "onsite",
  "hybrid",
  "metro",
]);

const REMOTE_TOKENS = new Set(["remote", "wfh", "workfromhome"]);

/** Employer suffixes; the first one marks where the company name starts. */
const COMPANY_SUFFIX_TOKENS = new Set([
  "solutions",
  "solution",
  "technologies",
  "technology",
  "services",
  "service",
  "systems",
  "system",
  "pvt",
  "ltd",
  "limited",
  "private",
  "consulting",
  "consultants",
  "labs",
  "lab",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "company",
  "group",
  "enterprises",
  "enterprise",
  "industries",
  "industry",
  "infotech",
  "software",
  "engineering",
  "engineers",
  "global",
  "india",
  "bank",
  "healthcare",
  "health",
  "finance",
  "financial",
  "connect",
  "digital",
  "media",
  "networks",
  "communications",
  "telecom",
  "motors",
  "pharma",
  "staffing",
  "manpower",
  "associates",
  "partners",
  "ventures",
  "holdings",
]);

/** Leading words that add nothing to a job title. */
const TITLE_NOISE = new Set([
  "opening",
  "openings",
  "for",
  "with",
  "hiring",
  "urgent",
  "required",
  "requirement",
  "requirements",
  "job",
  "jobs",
  "vacancy",
  "vacancies",
  "apply",
  "walkin",
  "walk-in",
  "immediate",
  "joiners",
  "joiner",
  "looking",
  "only",
  "we",
  "are",
  "is",
  "a",
  "an",
  "the",
]);

/** Single-word role keywords, plural forms included ("Developers"). */
const TECH_TOKEN =
  /^(engineers?|engineering|developers?|programmers?|software|fullstack|devops|sre|platforms?|architects?|scientists?|ml|ai)$/i;

/** Two-word role keywords, matched as an adjacent token pair. */
const TECH_PAIRS = new Set([
  "full-stack",
  "front-end",
  "back-end",
  "machine-learning",
  "data-scientist",
  "data-scientists",
  "site-reliability",
  "software-engineer",
]);

/** Words that can trail the role keyword ("Engineer II", "Data Scientist 5 WFO"). */
const TITLE_TAIL =
  /^(i|ii|iii|iv|v|1|2|3|4|5|sr|jr|senior|junior|lead|principal|staff|trainee|intern|contract|wfo|wfh|remote|hybrid|onsite|\d+)$/;

/** Job-family filters exposed through `categories`. */
const CATEGORY_PATTERNS: Record<string, RegExp> = {
  "it-software":
    /(software|developer|programmer|full[- ]?stack|front[- ]?end|back[- ]?end|devops|sre|data|machine[- ]?learning|ml|ai|cloud|qa|test|android|ios|python|java|\.net|php|node|react|angular|salesforce|sap|sql|analytics|security|network|system|platform|architect)/i,
  engineering:
    /(engineer|engineering|architect|designer|technician|mechanical|civil|electrical|electronics|embedded|hardware|manufacturing|production|quality)/i,
};

const ACRONYMS = new Set([
  "ai",
  "api",
  "aws",
  "cad",
  "cd",
  "ci",
  "cnc",
  "crm",
  "css",
  "dba",
  "erp",
  "gcp",
  "grpc",
  "hr",
  "html",
  "ios",
  "it",
  "js",
  "json",
  "lan",
  "ml",
  "php",
  "plc",
  "qa",
  "rest",
  "sap",
  "seo",
  "sql",
  "sre",
  "ts",
  "wfh",
  "wfo",
  "ui",
  "ux",
  "vpn",
  "wan",
  "xml",
]);

interface ParsedJob {
  id: string;
  url: string;
  title: string;
  company: string;
  locations: string[];
  remote: boolean;
  experience?: { min: number; max: number };
  postedAt?: string;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function titleCase(tokens: string[]): string {
  return tokens
    .filter((token) => token !== "")
    .map((token) => {
      if (ACRONYMS.has(token)) return token.toUpperCase();
      if (token.length <= 2) return token.toUpperCase();
      return token[0]!.toUpperCase() + token.slice(1);
    })
    .join(" ");
}

/**
 * The job id starts with `DDMMYY` (for example `111126007762` was posted on
 * 11 Nov 2026). Ids that do not form a valid, non-future calendar date are
 * left undated.
 */
export function postedAtFromId(id: string): string | undefined {
  if (!/^\d{12}$/.test(id)) return undefined;

  const day = Number(id.slice(0, 2));
  const month = Number(id.slice(2, 4));
  const year = 2000 + Number(id.slice(4, 6));
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  if (year < 2015) return undefined;
  // A posting cannot be from the future; allow a day of clock skew.
  if (date.getTime() > Date.now() + 86_400_000) return undefined;

  return date.toISOString();
}

/**
 * Parses one `job-listings-...` sitemap URL into its posting fields.
 *
 * The slug is `job-listings-{title}-{company}-{locations}-{min}-to-{max}-
 * years-{id}`. Locations are stripped with a city vocabulary, then the last
 * role keyword ends the title and the remainder is the employer. A trailing
 * employer suffix ("solutions", "technologies", "pvt", ...) is treated as the
 * start of the company rather than the end of the title.
 */
export function parseJobUrl(loc: string): ParsedJob | undefined {
  const url = loc.trim().replace(/([^:])\/{2,}/g, "$1/");

  const experienced = url.match(
    /\/job-listings-(.+)-(\d+)-to-(\d+)-years-(\d+)\/?$/,
  );
  const simple = experienced
    ? undefined
    : url.match(/\/job-listings-(.+)-(\d+)\/?$/);

  const match = experienced ?? simple;
  if (!match) return undefined;

  const body = match[1];
  const id = experienced ? match[4] : match[2];
  if (!body || !id) return undefined;

  const experience = experienced
    ? { min: Number(match[2]), max: Number(match[3]) }
    : undefined;

  const words: string[] = [];
  const locations: string[] = [];
  let remote = false;

  for (const raw of body.split("-")) {
    const token = raw.toLowerCase();
    if (token === "") continue;
    if (CITY_TOKENS.has(token)) {
      locations.push(token);
      continue;
    }
    if (REMOTE_TOKENS.has(token)) {
      remote = true;
      continue;
    }
    if (LOCATION_MODIFIERS.has(token)) continue;
    words.push(token);
  }

  if (words.length === 0) return undefined;

  // Mark every token that belongs to a role keyword, including two-word phrases.
  const tech = new Set<number>();
  for (let index = 0; index < words.length; index += 1) {
    if (TECH_TOKEN.test(words[index]!)) tech.add(index);
    if (
      index + 1 < words.length &&
      TECH_PAIRS.has(`${words[index]}-${words[index + 1]}`)
    ) {
      tech.add(index);
      tech.add(index + 1);
    }
  }
  if (tech.size === 0) return undefined;

  const techIndices = [...tech].sort((left, right) => left - right);
  let titleEnd = techIndices[techIndices.length - 1]!;

  // "Acme Software Pvt Ltd" and "Ascendion Engineering" end in an employer
  // suffix, not a role, so step back to the previous role keyword when there
  // is one. This keeps "Salesforce Developer | Ascendion Engineering" intact.
  const after = words[titleEnd + 1];
  const suffixEndsCompany =
    COMPANY_SUFFIX_TOKENS.has(words[titleEnd]!) ||
    (after !== undefined && COMPANY_SUFFIX_TOKENS.has(after));
  if (suffixEndsCompany) {
    const previous = techIndices.filter((index) => index < titleEnd).pop();
    if (previous !== undefined) titleEnd = previous;
  }

  // Keep trailing modifiers with the title ("Engineer II", "Data Scientist 5 WFO").
  while (titleEnd + 1 < words.length && TITLE_TAIL.test(words[titleEnd + 1]!)) {
    titleEnd += 1;
  }

  const titleTokens = words.slice(0, titleEnd + 1);
  while (titleTokens.length > 0 && TITLE_NOISE.has(titleTokens[0]!)) {
    titleTokens.shift();
  }
  const title = titleCase(titleTokens);
  if (!title) return undefined;

  let companyTokens = words.slice(titleEnd + 1);
  // A job slug always carries an employer; when the suffix rule swallowed it
  // into the title, fall back to the first meaningful token of the prefix.
  if (companyTokens.length === 0) {
    companyTokens = titleTokens.filter(
      (token) => !TITLE_NOISE.has(token) && !isTechRole(token),
    );
  }
  while (
    companyTokens.length > 0 &&
    (TITLE_NOISE.has(companyTokens[0]!) || /^\d+$/.test(companyTokens[0]!))
  ) {
    companyTokens.shift();
  }
  // "Wipro Wipro" and similar repeated slug fragments.
  companyTokens = companyTokens.filter(
    (token, index) => index === 0 || token !== companyTokens[index - 1],
  );
  const company = titleCase(companyTokens) || title;

  const uniqueLocations: string[] = [];
  for (const location of locations) {
    const label = titleCase([location]);
    if (!uniqueLocations.includes(label)) uniqueLocations.push(label);
  }
  if (remote && !uniqueLocations.includes("Remote")) uniqueLocations.push("Remote");
  if (uniqueLocations.length === 0) uniqueLocations.push("India");

  return {
    id,
    url,
    title,
    company,
    locations: uniqueLocations,
    remote,
    experience,
    postedAt: postedAtFromId(id),
  };
}

/** Extracts every job posting from a sitemap `<urlset>`. */
export function jobsFromSitemap(xml: string): ParsedJob[] {
  const jobs: ParsedJob[] = [];
  for (const match of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) {
    const loc = match[1];
    if (!loc || !loc.includes("/job-listings-")) continue;
    const job = parseJobUrl(loc);
    if (job) jobs.push(job);
  }
  return jobs;
}

function activeCategories(categories: string[] | undefined): string[] {
  const requested = (Array.isArray(categories) ? categories : []).filter(
    (category) => CATEGORY_PATTERNS[category] !== undefined,
  );
  return requested.length > 0 ? requested : Object.keys(CATEGORY_PATTERNS);
}

function matchesCategory(title: string, categories: string[]): boolean {
  return categories.some((category) => CATEGORY_PATTERNS[category]?.test(title));
}

function descriptionFor(job: ParsedJob): string {
  const parts = [`${job.title} at ${job.company}.`];
  if (job.experience) {
    parts.push(`Experience: ${job.experience.min}-${job.experience.max} years.`);
  }
  parts.push(`Location: ${job.locations.join(", ")}.`);
  parts.push("Posted on Naukri.");
  return normalizeWhitespace(parts.join(" "));
}

function toStartup(job: ParsedJob): Startup {
  return {
    id: `${sourceId}:${job.id}`,
    name: job.company,
    oneLiner: job.title,
    description: descriptionFor(job),
    url: job.url,
    locations: job.locations,
    remote: job.remote || undefined,
    industry: [],
    source: sourceId,
    signals: [
      {
        type: "hiring",
        date: job.postedAt,
        text: `${job.company} - ${job.title}`,
        url: job.url,
      },
    ],
  };
}

function freshness(startup: Startup): number {
  const date = startup.signals[0]?.date;
  const time = date ? Date.parse(date) : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Naukri.com postings, read from the public job sitemap.
 *
 * Every technical sitemap entry becomes one posting; non-technical entries are
 * dropped. Entries are deduped by job id, sorted newest-first using the date
 * encoded in the id, and capped at `limit`. A sitemap that fails to load is
 * logged and skipped, so one bad file does not sink the source.
 */
export async function fetchNaukri(
  config: NaukriConfig = {},
  _context?: SourceContext,
): Promise<Startup[]> {
  const limit = config.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) return [];

  const sitemaps = [
    textValue(config.sitemapUrl),
    ...(Array.isArray(config.sitemaps) ? config.sitemaps : []).map((url) =>
      textValue(url),
    ),
  ].filter((url): url is string => url !== undefined);
  const urls = sitemaps.length > 0 ? sitemaps : [DEFAULT_SITEMAP_URL];

  const requestedScan =
    typeof config.scanLimit === "number" && Number.isFinite(config.scanLimit)
      ? config.scanLimit
      : MAX_SCAN_LIMIT;
  const scanLimit = Math.max(1, Math.min(MAX_SCAN_LIMIT, requestedScan));
  const categories = activeCategories(config.categories);

  const seen = new Set<string>();
  const out: Startup[] = [];
  let parsed = 0;

  for (const url of urls) {
    let xml: string;
    try {
      xml = await fetchText(url, {
        headers: {
          "user-agent": BROWSER_UA,
          accept: "application/xml,text/xml,*/*",
        },
      });
    } catch (error) {
      logger.warn(
        `naukri: sitemap ${url} failed - ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    for (const job of jobsFromSitemap(xml)) {
      if (parsed >= scanLimit) break;
      parsed += 1;

      if (!isTechRole(job.title)) continue;
      if (!matchesCategory(job.title, categories)) continue;

      const startup = toStartup(job);
      if (seen.has(startup.id)) continue;
      seen.add(startup.id);
      out.push(startup);
    }
  }

  out.sort((left, right) => {
    const byDate = freshness(right) - freshness(left);
    if (byDate !== 0) return byDate;
    return right.id.localeCompare(left.id);
  });

  logger.debug(`naukri: parsed ${parsed} sitemap entries, kept ${out.length}`);

  return out.slice(0, limit);
}
