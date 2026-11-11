# Source health metrics

Every `collectStartups()` run emits one metric set per source and one summary
set for the run. Instrumentation lives in `src/lib/metrics.ts` and wraps each
source call in `src/sources/index.ts`, so a new source gets metrics for free.

## Metric names

| Metric | Value | Tags | Query with |
| --- | --- | --- | --- |
| `source.jobs_found` | jobs returned by the source | `source_id`, `run_id` | `sum` / `persecond` |
| `source.duration_ms` | source wall-clock time (ms) | `source_id`, `run_id`, `outcome` | `avg`, `p95`, `max` |
| `source.success` | `1` per successful run | `source_id`, `run_id` | `sum` |
| `source.failure` | `1` per failed run | `source_id`, `run_id`, `error_type` | `sum` |
| `source.rate_limited` | `1` per run that gave up on HTTP 429 | `source_id`, `run_id`, `error_type` | `sum` |
| `collection.jobs_found` | jobs collected by the whole run | `run_id` | `sum` |
| `collection.sources_total` | sources attempted | `run_id` | `avg` |
| `collection.sources_failed` | sources that failed | `run_id` | `sum` |
| `collection.duration_ms` | wall-clock time of the whole run (ms) | `run_id` | `p95`, `max` |

`error_type` is one of:

| Value | Meaning |
| --- | --- |
| `rate_limited` | HTTP 429 after retries |
| `timeout` | request aborted by the client timeout |
| `network` | DNS, TLS, or connection failure |
| `http_4xx` | non-retryable client error |
| `http_5xx` | server error after retries |
| `circuit_open` | the source's circuit breaker failed fast |
| `parse` | the response did not match the expected format |
| `unknown` | anything else |

`outcome` on `source.duration_ms` is `success` or `failure`.

`source_id` and `error_type` are low-cardinality and safe to group by.
`run_id` is a UUID that identifies one collection; use it to correlate samples
with the run's log line, **not** as a dashboard dimension.

## Where samples go

1. **Vercel Custom Metrics** — `metric()` from `@vercel/functions` inside a
   Vercel Function. The helper is a no-op when the runtime does not support
   Custom Metrics, so local, Docker, and Render runs need no configuration.
   Querying metrics requires Observability Plus.
2. **JSON logs** — set `METRICS_LOG=1` to also write one line per sample:

   ```
   [12:00:03] INFO  metric {"name":"source.jobs_found","value":42,"tags":{"source_id":"hn","run_id":"…"}}
   ```

   This is the path for Render, Docker, or systemd deployments: ship stdout to
   your log provider and parse the JSON after `metric `.
3. **Custom sink** — `setMetricSink(fn)` in application code or tests. The
   returned function restores the previous sink.

A run with no registered source still emits the `collection.*` summary, so an
empty run is visible rather than silent.

## Dashboard recipe

Create a dashboard with these panels (Vercel CLI shown; the same aggregations
apply in the dashboard):

```bash
# Volume per source
vc metrics source.jobs_found -a sum --group-by source_id --since 24h

# Slowest sources
vc metrics source.duration_ms -a p95 --group-by source_id --since 24h

# Failing sources, split by cause
vc metrics source.failure -a sum --group-by source_id,error_type --since 7d

# Rate-limit pressure
vc metrics source.rate_limited -a sum --group-by source_id --since 7d

# Run-level health
vc metrics collection.sources_failed -a sum --since 7d
vc metrics collection.duration_ms -a p95 --since 7d
```

Inspect the exact tags and aggregations first:

```bash
vc metrics schema source.failure
```

Useful derived panels:

- **Success rate** — `source.success` ÷ (`source.success` + `source.failure`)
  per `source_id`.
- **Silent source** — `source.jobs_found` stays at `0` while
  `source.success` stays at `1`. The parser is probably returning nothing.
- **Stale run** — `collection.sources_total` is missing for a day. The
  scheduler did not run.

## Alerting example: two consecutive failed runs

Alert when a source fails on two scheduled runs in a row (runs are every 6h):

1. Query `sum(source.failure)` grouped by `source_id`.
2. Fire when the value is `> 0` for the same `source_id` on two consecutive
   scheduled evaluations.
3. Route the alert to the owner; include `error_type` from the same query to
   skip the first triage step.

With Vercel, create an Observability alert on `source.failure` with
`sum by source_id`, and require two consecutive evaluations. With a log drain
(Render, Docker), group `metric` lines by `run_id`, then alert when the count of
`source.failure` for a `source_id` is `> 0` on the latest two `run_id`s.

For a coarser page, alert on `collection.sources_failed > 0` for two runs. For
silent breakage, also alert when `source.jobs_found` is `0` for two runs while
`source.success` is `1`.

## Wiring and overhead

```ts
const startups = await collectStartups(config, { only, profile });
// Optional: supply a run id (for example, the scheduler's job id) and observe
// per-source telemetry without parsing logs.
await collectStartups(config, {
  profile,
  runId: jobId,
  onSourceRun: (telemetry) => {
    // telemetry: { sourceId, runId, durationMs, jobsFound, ok, errorType? }
  },
});
```

Instrumentation adds one `performance.now()` pair and a handful of synchronous
`metric()` calls per source. When `METRICS_LOG` is unset and the runtime is not
Vercel, the calls are no-ops and do not add I/O.

## Tests

`src/lib/metrics.test.ts` covers error classification, per-source samples, and
the run summary. `src/sources/index.test.ts` verifies that `collectStartups`
emits metrics for successful, failing, and rate-limited sources, keeps
`run_id` consistent, and never lets telemetry sink a run. Tests use
`setMetricSink()` to capture samples without network or Vercel.
