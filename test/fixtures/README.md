# Source fixtures

One file per source: `<source>.json`. A fixture is a recording of the real HTTP
traffic a source made — the same request URL and the same response body — used
by `src/sources/<source>.test.ts` so tests are deterministic, offline, and still
run the source's real parsing code.

```
test/fixtures/
  README.md       # this file
  remoteok.json   # one recorded RemoteOK API response
```

## Record or refresh a fixture

```bash
# Record the live response (full size)
npm run record:fixture remoteok

# Big feeds: keep only the first N top-level array items
npm run record:fixture remoteok -- --trim 25

# Big sitemaps: keep only the last N job URLs (the source sees the same slice)
npm run record:fixture otta -- --trim-sitemap 16

# Point at a different config/profile when experimenting
npm run record:fixture yc -- --config config/sources.yaml --profile profile/profile.yaml
```

The recorder imports the source through the normal registry, so the request
goes through the shared HTTP client (timeouts, retries, rate limits, circuit
breaker) and is parsed by the production code. Only successful (2xx) responses
are saved; redirects/failures are logged and skipped. Fixtures are written to
`test/fixtures/<source>.json` and are meant to be committed.

After writing, the recorder runs the contract check against the live startups
and prints any violations. The recording is still saved so you can inspect it
and fix the source.

## Format

```json
{
  "source": "remoteok",
  "recordedAt": "2026-11-11T14:00:55.000Z",
  "responses": [
    {
      "url": "https://remoteok.com/api",
      "status": 200,
      "headers": { "content-type": "application/json" },
      "body": [{ "legal": "..." }, { "id": "123", "company": "Acme" }]
    }
  ]
}
```

- `source` must equal the source id; the replay helper rejects a mismatched file.
- `responses` holds every 2xx response the source made, in request order — this
  covers sources that paginate or fetch detail pages.
- `body` is parsed JSON when the response was JSON, otherwise the raw text.
- `--trim` only shortens top-level arrays; the shape stays exactly as the API
  returned it.
- `--trim-sitemap` rewrites a sitemap response to its last N job `<url>`
  entries before the source parses it, so a recording only resolves the ids it
  saves.

## Use it in a test

Copy this template into `src/sources/<source>.test.ts`. It is the whole pattern:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { assertValidStartups } from "../../test/contract.js";
import { withFixtureFetch } from "../../test/fixtures.js";
import { fetchNewboard } from "./newboard.js";

test("newboard: recorded fixture parses into valid Startups", async () => {
  const startups = await withFixtureFetch("newboard", () =>
    fetchNewboard({ limit: 10 }),
  );

  assert.ok(startups.length > 0, "fixture should yield at least one startup");
  assertValidStartups(startups, "newboard");
});
```

`withFixtureFetch` swaps `globalThis.fetch`, replays the fixture, and restores
the real fetch in a `finally` — even when the test throws. A request to a URL
the fixture does not contain fails loudly instead of hitting the network.

## What the contract checks

`assertValidStartups(startups, sourceId)` verifies the fields every consumer
depends on:

- `id` is `"{sourceId}:{local-id}"` and unique within the batch (it is the
  cross-run dedupe key);
- `name`, `source`, `signals`, `locations`, and `industry` are present;
- `signals` is non-empty, every `type` is one of `raised | launched | hiring |
  news`, and every present `date` parses as an ISO 8601 date;
- optional fields (`url`, `description`, `remote`, …) have the declared type.

An empty `Startup[]` is structurally valid (a source may find nothing fresh), so
fixture tests that need coverage should assert `startups.length > 0`.

## When to re-record

Re-record when the source's response shape or the test's expected data changes.
A fixture is a sample, not a schema: a source must still handle new optional
fields at runtime, but tests are pinned to the recorded sample so a red test
means a real parsing regression, not an upstream edit.
