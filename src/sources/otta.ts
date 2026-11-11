import { fetchJson, fetchText } from "../lib/http.js";
import { logger } from "../lib/log.js";
import { isTechRole } from "../lib/text.js";
import type { SourceId, Startup } from "../types.js";
import type { BaseSourceConfig, SourceContext } from "./types.js";

export const sourceId = "otta" as const satisfies SourceId;

export interface OttaConfig extends BaseSourceConfig {
  /** Maximum number of startups to return. */
  limit?: number;
  /**
   * Keep only jobs whose salary range reaches at least this annual amount.
   * Jobs without published salary data are dropped while this filter is set.
   */
  salaryMin?: number;
  /** Keep only jobs whose location text contains this term (case-insensitive). */
  location?: string;
  /** Sitemap that lists every public Otta job id. Override in tests. */
  sitemapUrl?: string;
  /** How many job ids, from the end of the sitemap, to resolve. */
  scanLimit?: number;
}

/**
 * otta.com redirects to Welcome to the Jungle, but the app's own API still
 * serves public job data without a login:
 *
 * - the static sitemap lists every public job id, and
 * - `publicJob(externalId)` resolves one of those ids with its full detail.
 *
 * The other GraphQL queries (`jobs`, `totalJobs`) require authentication.
 */
const DEFAULT_SITEMAP_URL =
  "https://api.otta.com/static/sitemaps/sitemap-00001.xml";
const GRAPHQL_URL = "https://api.otta.com/graphql";

/** Otta caps GraphQL query complexity, so one request resolves eight jobs. */
const BATCH_SIZE = 8;

const DEFAULT_LIMIT = 100;
/** A scan smaller than this rarely satisfies the default limit. */
const MIN_SCAN_LIMIT = 40;
/** Upper bound on sitemap ids resolved per run. */
const MAX_SCAN_LIMIT = 400;

/**
 * Every field below is public: `live`, salary, locations, requirements, and
 * the company blurb all come back without a token. Auth-only fields (for
 * example `previewUrl`) would make the whole batch fail with `Unauthenticated`.
 */
const JOB_FIELDS = `
  externalId
  title
  live
  remoteOnly
  firstLiveAt
  insertedAt
  originalUrl
  officeLocation
  scrapedLocation
  otherCompensationInformation
  salaryRange { minAmount maxAmount currency }
  function { value }
  subFunction { value }
  formattedLocationPreferences { name }
  technologiesUsed { value }
  company { name urlSafeName domainName shortDescription mission numberEmployees size { value } }
  team { name mission }
  requirements { value desirable order }
  involvesBullets { value order }
`;

interface MoneyRange {
  minAmount?: string | number | null;
  maxAmount?: string | number | null;
  currency?: string | null;
}

interface LabelledValue {
  value?: string | null;
}

interface OrderedValue extends LabelledValue {
  order?: number | null;
  desirable?: boolean | null;
}

interface OttaCompany {
  name?: string | null;
  urlSafeName?: string | null;
  domainName?: string | null;
  shortDescription?: string | null;
  mission?: string | null;
  numberEmployees?: number | null;
  size?: { value?: string | null } | null;
}

interface OttaJob {
  externalId?: string | null;
  title?: string | null;
  live?: boolean | null;
  remoteOnly?: boolean | null;
  firstLiveAt?: string | null;
  insertedAt?: string | null;
  originalUrl?: string | null;
  officeLocation?: string | null;
  scrapedLocation?: string | null;
  otherCompensationInformation?: string | null;
  salaryRange?: MoneyRange | null;
  function?: LabelledValue | null;
  subFunction?: LabelledValue | null;
  formattedLocationPreferences?: Array<{ name?: string | null }> | null;
  technologiesUsed?: LabelledValue[] | null;
  company?: OttaCompany | null;
  team?: { name?: string | null; mission?: string | null } | null;
  requirements?: OrderedValue[] | null;
  involvesBullets?: OrderedValue[] | null;
}

interface OttaGraphqlResponse {
  data?: Record<string, OttaJob | null> | null;
  errors?: Array<{ message?: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Extracts job ids from the sitemap, in document order.
 *
 * The file mixes job and company URLs (`/jobs/<id>` vs `/companies/<name>`),
 * and the id is the last path segment. Duplicate ids are dropped because the
 * sitemap is regenerated daily and can briefly overlap.
 */
export function jobIdsFromSitemap(xml: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const match of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) {
    const loc = match[1];
    if (!loc) continue;

    const marker = loc.indexOf("/jobs/");
    if (marker === -1) continue;

    const rest = loc.slice(marker + "/jobs/".length);
    const id = (rest.split(/[?#/]/)[0] ?? "").trim();
    if (!id || seen.has(id)) continue;

    seen.add(id);
    ids.push(id);
  }

  return ids;
}

function buildQuery(ids: string[]): string {
  const selections = ids.map(
    (id, index) =>
      `job${index}: publicJob(externalId: ${JSON.stringify(id)}) { ${JOB_FIELDS} }`,
  );
  return `query OttaJobs { ${selections.join("\n")} }`;
}

/**
 * Resolves one batch of ids. The `batch` query parameter is unnecessary for
 * Otta but makes every request URL unique, so recorded fixtures replay the
 * exact response for each batch.
 */
async function fetchBatch(ids: string[], batch: number): Promise<OttaJob[]> {
  const url = `${GRAPHQL_URL}?batch=${batch}`;

  let payload: OttaGraphqlResponse;
  try {
    payload = await fetchJson<OttaGraphqlResponse>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: buildQuery(ids) }),
    });
  } catch (error) {
    logger.warn(
      `otta: batch ${batch} failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const messages = payload.errors
      .map((error) => error.message)
      .filter((message): message is string => Boolean(message));
    logger.debug(`otta: batch ${batch} returned GraphQL errors: ${messages.join("; ")}`);
  }

  const data = payload.data;
  if (!isRecord(data)) return [];

  const jobs: OttaJob[] = [];
  for (const value of Object.values(data)) {
    if (value) jobs.push(value);
  }
  return jobs;
}

function parseAmount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string") return undefined;

  const amount = Number(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

function formatAmount(amount: number): string {
  return amount.toLocaleString("en-US");
}

/** `{ minAmount: "107000", maxAmount: "140000", currency: "USD" }` → `USD 107,000–140,000`. */
function formatSalary(range: MoneyRange | null | undefined): string | undefined {
  if (!range) return undefined;

  const min = parseAmount(range.minAmount);
  const max = parseAmount(range.maxAmount);
  if (min === undefined && max === undefined) return undefined;

  const currency = textValue(range.currency);
  const amount =
    min !== undefined && max !== undefined && min !== max
      ? `${formatAmount(min)}–${formatAmount(max)}`
      : formatAmount(min ?? max ?? 0);

  return `${currency ?? ""} ${amount}`.trim();
}

function salaryCeiling(range: MoneyRange | null | undefined): number | undefined {
  if (!range) return undefined;
  return parseAmount(range.maxAmount) ?? parseAmount(range.minAmount);
}

const NAIVE_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/**
 * Otta's timestamps have no timezone suffix. They are served in UTC, so an
 * explicit `Z` keeps `Date.parse` and the ISO contract honest.
 */
function isoDateTime(value: unknown): string | undefined {
  const text = textValue(value);
  if (!text) return undefined;

  const candidate = NAIVE_DATE_TIME.test(text) ? `${text}Z` : text;
  return Number.isNaN(Date.parse(candidate)) ? undefined : candidate;
}

function locationsFor(job: OttaJob): string[] {
  const locations: string[] = [];

  for (const preference of job.formattedLocationPreferences ?? []) {
    const name = textValue(preference?.name);
    if (name) locations.push(name);
  }

  const scraped = textValue(job.scrapedLocation);
  if (scraped) {
    const isRemote = /\{\{\s*REMOTE\s*\}\}/i.test(scraped);
    const address = scraped
      .replace(/\{\{\s*REMOTE\s*\}\}/gi, "")
      .trim()
      .replace(/,\s*$/, "");
    if (address) locations.push(address);
    if (isRemote) locations.push("Remote");
  }

  if (locations.length === 0) {
    const office = textValue(job.officeLocation);
    if (office) locations.push(office);
  }

  return uniqueStrings(locations);
}

function orderedValues(values: OrderedValue[] | null | undefined): string[] {
  return [...(values ?? [])]
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .map((entry) => textValue(entry.value))
    .filter((value): value is string => value !== undefined);
}

/**
 * Otta titles alone miss roles such as "Member of Technical Staff", so the
 * function/sub-function taxonomy is allowed to prove a technical role too.
 */
function isTechJob(job: OttaJob): boolean {
  const title = textValue(job.title);
  if (title && isTechRole(title)) return true;

  const taxonomy = [textValue(job.function?.value), textValue(job.subFunction?.value)]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  return taxonomy !== "" && isTechRole(taxonomy);
}

function descriptionFor(job: OttaJob): string | undefined {
  const parts: string[] = [];

  const summary = textValue(job.company?.shortDescription);
  if (summary) parts.push(summary);

  const mission = textValue(job.company?.mission);
  if (mission) parts.push(`Mission: ${mission}`);

  // The ticket asks for salary to survive mapping. Compensation goes before
  // the long bullet lists so the 4000-character cut can never drop it.
  const salary = formatSalary(job.salaryRange);
  if (salary) parts.push(`Compensation: ${salary}`);

  const otherCompensation = textValue(job.otherCompensationInformation);
  if (otherCompensation) parts.push(`Other compensation: ${otherCompensation}`);

  const tech = uniqueStrings(
    (job.technologiesUsed ?? []).map((entry) => textValue(entry.value)),
  );
  if (tech.length > 0) parts.push(`Tech: ${tech.join(", ")}`);

  const teamName = textValue(job.team?.name);
  const teamMission = textValue(job.team?.mission);
  if (teamName || teamMission) {
    parts.push(
      [teamName ? `Team: ${teamName}` : "", teamMission ?? ""]
        .filter((value) => value !== "")
        .join("\n"),
    );
  }

  const responsibilities = orderedValues(job.involvesBullets).map(
    (value) => `- ${value}`,
  );
  if (responsibilities.length > 0) {
    parts.push(`What you'll do:\n${responsibilities.join("\n")}`);
  }

  const requirements = [...(job.requirements ?? [])]
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .map((entry) => {
      const value = textValue(entry.value);
      if (!value) return undefined;
      return `- ${value}${entry.desirable ? " (desirable)" : ""}`;
    })
    .filter((value): value is string => value !== undefined);
  if (requirements.length > 0) {
    parts.push(`Requirements:\n${requirements.join("\n")}`);
  }

  return parts.length > 0 ? parts.join("\n\n").slice(0, 4000) : undefined;
}

function mapJob(job: OttaJob, config: OttaConfig): Startup | undefined {
  const externalId = textValue(job.externalId);
  const title = textValue(job.title);
  const company = textValue(job.company?.name);
  if (!externalId || !title || !company) return undefined;

  // The sitemap is regenerated daily; a job can close before we resolve it.
  if (job.live === false) return undefined;
  if (!isTechJob(job)) return undefined;

  const salaryMin = config.salaryMin ?? 0;
  if (salaryMin > 0) {
    const ceiling = salaryCeiling(job.salaryRange);
    if (ceiling === undefined || ceiling < salaryMin) return undefined;
  }

  const locations = locationsFor(job);
  const locationFilter = textValue(config.location)?.toLowerCase();
  if (locationFilter) {
    const haystack = [
      ...locations,
      textValue(job.scrapedLocation) ?? "",
      job.remoteOnly === true ? "Remote" : "",
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(locationFilter)) return undefined;
  }

  const salary = formatSalary(job.salaryRange);
  const url =
    textValue(job.originalUrl) ??
    `https://app.otta.com/jobs/${encodeURIComponent(externalId)}`;
  const postedAt = isoDateTime(job.firstLiveAt) ?? isoDateTime(job.insertedAt);
  const employees =
    textValue(job.company?.size?.value) ??
    (typeof job.company?.numberEmployees === "number"
      ? String(job.company.numberEmployees)
      : undefined);
  const remote =
    job.remoteOnly === true || locations.some((location) => /remote/i.test(location));

  return {
    id: `${sourceId}:${externalId}`,
    name: company,
    oneLiner: title,
    description: descriptionFor(job),
    url,
    locations,
    remote: remote || undefined,
    industry: uniqueStrings([
      textValue(job.function?.value),
      textValue(job.subFunction?.value),
    ]),
    employees,
    companyDomain: textValue(job.company?.domainName),
    source: sourceId,
    signals: [
      {
        type: "hiring",
        date: postedAt,
        text: `${company} — ${title}${salary ? ` (${salary})` : ""}`,
        url,
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
 * Otta's public job board.
 *
 * There is no unauthenticated search endpoint, but the static sitemap lists
 * every public job. This source resolves the last `scanLimit` ids through the
 * batched `publicJob` query, keeps live technical roles, applies the optional
 * salary/location filters, and returns the freshest `limit` jobs.
 *
 * Batches fail soft: one bad response still lets the remaining batches add
 * jobs. A sitemap failure propagates, so the run records the source as failed.
 */
export async function fetchOtta(
  config: OttaConfig = {},
  _context?: SourceContext,
): Promise<Startup[]> {
  const limit = config.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) return [];

  const scanLimit =
    config.scanLimit ??
    Math.min(MAX_SCAN_LIMIT, Math.max(limit * 2, MIN_SCAN_LIMIT));

  const sitemapUrl = textValue(config.sitemapUrl) ?? DEFAULT_SITEMAP_URL;
  const xml = await fetchText(sitemapUrl);
  const ids = jobIdsFromSitemap(xml);

  if (ids.length === 0) {
    logger.warn(`otta: sitemap ${sitemapUrl} listed no job urls`);
    return [];
  }

  // The tail is as company-diverse as the head and shifts between requests, so
  // scanning from the end samples different companies over consecutive runs.
  const scanIds = ids.slice(-Math.max(1, scanLimit));

  const seen = new Set<string>();
  const out: Startup[] = [];
  let batches = 0;

  for (let start = 0, batch = 0; start < scanIds.length; start += BATCH_SIZE, batch += 1) {
    batches += 1;
    const jobs = await fetchBatch(scanIds.slice(start, start + BATCH_SIZE), batch);

    for (const job of jobs) {
      const startup = mapJob(job, config);
      if (!startup || seen.has(startup.id)) continue;
      seen.add(startup.id);
      out.push(startup);
    }
  }

  out.sort((left, right) => freshness(right) - freshness(left));

  logger.debug(
    `otta: scanned ${scanIds.length} job id(s) in ${batches} batch(es), kept ${out.length}`,
  );

  return out.slice(0, limit);
}
