/**
 * Domain helpers for the Hub ingest payload.
 *
 * Hub normalizes `companyDomain` itself, but doing it here as well means we
 * never send a payload that Hub will reject, and we can decide to skip a job
 * when no usable company domain exists.
 */

const DOMAIN_PATTERN = /^(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+(?<!-)$/;

/**
 * Lowercase, no protocol, no `www.`, no path/query/port/trailing dot.
 * Mirrors `normalizeDomain` in the Hub project.
 */
export function normalizeDomain(raw: string): string {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.replace(/^www\./, "");
  value = value.split("/")[0] ?? "";
  value = value.split("?")[0] ?? "";
  value = value.split("#")[0] ?? "";
  value = value.replace(/:\d+$/, "");
  value = value.replace(/\.+$/, "");
  return value;
}

export function isValidDomain(value: string): boolean {
  return DOMAIN_PATTERN.test(value);
}

/**
 * Derive a normalized domain from a URL or a bare domain.
 *
 * Returns `undefined` when the input is missing, malformed, or does not look
 * like a registrable domain (e.g. `localhost`, `finder://jobs/123`).
 */
export function domainFromUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;

  try {
    const url = new URL(raw);
    const domain = normalizeDomain(url.hostname);
    return isValidDomain(domain) ? domain : undefined;
  } catch {
    // Some sources provide a bare domain rather than a URL.
    const domain = normalizeDomain(raw);
    return isValidDomain(domain) ? domain : undefined;
  }
}
