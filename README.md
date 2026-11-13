# jobfinder

A **single-user** startup-job matcher that also runs as an **email bot**. Every
morning it sweeps public sources for startups worth contacting, scores them
against **one person's** profile, and emails the ranked matches. You can reply
to ask for more, see details, or block a company.

It is a personal, independent reconstruction of the *matching* half of
[Backdoor](https://backdoorai.app) — not a copy of their product, and nothing
here touches their systems.

---

## 1. How Backdoor works (reverse-engineered from public sources)

From Backdoor's public pages (home, `/list`, `/research/founder-reply-rates`,
`/changelog`, `/blog`, `/terms`, `/privacy`):

**Idea:** instead of applying to posted jobs (a pile), write directly to a
startup founder, often before a role is posted. Backdoor lives in iMessage /
WhatsApp and runs this loop:

1. **Profile intake** — you send LinkedIn / résumé / voice note.
2. **Daily sourcing** — it sweeps public sources for *signals* — "just raised",
   "just launched", "started hiring" — not just job posts.
3. **Qualification** — scores each signal against your profile, picks a small
   daily set, each with a "why this was picked" note.
4. **Founder discovery** — the founder's personal email, not a team inbox.
5. **Drafting** — a short note connecting *their news* to *your proof*.
6. **Send + follow-up** — from your Gmail, following up until they reply.
7. **Reply handling** — tracks the thread.

The matching core is: **gather opportunities → score fit → rank → pick a few.**

**Boundary:** Backdoor's Terms prohibit reverse-engineering their software and
unauthorized access to their systems. We don't do that; everything above is
public and this tool is independent.

---

## 2. What this project does today

Scope is **matching only** — no email sending to founders.

- **Sources** (public, no auth), 24 implemented:
  - *Signals*: **YC** company directory, **HN** "Who is hiring?" thread,
    **funding** RSS feeds, **Product Hunt** launches, **Google** Board Scan
    (see below).
  - *Global job boards*: **RemoteOK**, **Remotive**, **Arbeitnow**,
    **Wellfound**, **Otta**, **Work at a Startup** (YC), **Himalayas**,
    **We Work Remotely**, **Remote.co**, **Jobspresso**.
  - *India-focused*: **Internshala**, **Unstop**, **Naukri** (opt-in, reads the
    public job sitemap), **Cutshort** (opt-in).
  - *Niche*: **Web3.career** (crypto/web3), **AI Jobs** (ai-jobs.net, which now
    redirects to foorilla.com).
  - *Company career pages*: **Greenhouse**, **Lever**, **Ashby** (opt-in; list
    the company slugs under `companies` in `config/sources.yaml`).
  - *Pending*: **TLDR Jobs**, **Climatebase** and **DevRel.careers** have
    config blocks but no module yet, so a run warns and skips them instead of
    failing. **ByteByteGo** and **Indie Hackers** are also unimplemented and
    stay disabled until they publish a stable public feed.
- **Source attribution** — every digest line credits the board(s) a match came
  from (`wellfound + remoteok`). It reads `Startup.sources`, which cross-source
  dedupe fills in, so a merged role never hides where it was found.
- **Board Scan (Google)** — compiles the profile into Google queries that
  target ATS domains directly, for boards that don't expose a feed. It searches
  each query through SerpAPI or Google Custom Search, turns every usable result
  into a normal startup/job record, and feeds those records through the same
  ranking and digest/email pipeline (see §3). When Google drops the `site:`
  filter, it retries with site-only discovery; it also adds Google Jobs results
  so roles outside the ATS boards can still reach the digest.
- **Matching** — a transparent, deterministic score (0–100). Whole-word
  matching (so `java` ≠ `javascript`), plus domain fit, signal strength,
  recency, stage, location/remote, and junior/senior awareness. Early-career
  profiles also drop senior/lead titles and postings that ask for more than
  `preferences.maxRequiredYears` years. A listing must match a real core skill
  (not just a role word or a lone `Git`/`Docker`), and hard exclusions
  (`preferences.excludeKeywords`) drop a startup to 0 — this profile excludes
  Java, Ruby and Rails.
- **Freshness gate** — `preferences.maxAgeDays` keeps only opportunities whose
  newest signal is within that many days (undated listings are dropped, since
  their freshness can't be verified). Set to `3` to see only what's fresh.
  With a strict gate plus a junior/India/remote filter, some days legitimately
  have only a handful of matches; the digest shows those rather than padding
  the list with senior or stale roles.
- **Daily snapshot** — one run per day is cached in `data/snapshot-<date>.json`
  and reused, so the bot stays consistent and doesn't re-hit sources.
- **Dedupe** — the same role from several boards is merged into one record
  (`Startup.sources` lists every board that contributed), and `data/store.json`
  suppresses ids seen in the last 30 days. Re-running collection the same day
  returns nothing new; after 30 days a role may resurface. `npm run match:all`
  bypasses both filters.
- **No repeats** — the daily email only includes jobs that were *not* already
  emailed in the last ~10 days (reconstructed from the digest emails in the
  mailbox, so it survives GitHub Actions' ephemeral filesystem), and no single
  company may take more than 2 slots. If nothing new qualifies, the email says
  so instead of resurfacing yesterday's list.
- **Email bot** — see §4.

---

## 3. CLI usage

```bash
npm install

npm run match                 # top 15 new matches, printed + written to out/
npm run match:all             # ignore the seen-store
npm run match:llm             # refine the top slice with an LLM (needs OPENAI_API_KEY)
npm run match -- --limit 25 --source yc,hn
```

### Tests

```bash
npm test                                  # every src/ + test/ *.test.ts file, offline
npm run typecheck                         # tsc --noEmit
npm run record:fixture remoteok           # refresh a source fixture from the live API
npm run record:fixture remoteok -- --trim 25   # big feeds: keep the first N array items
```

Source tests never hit the network: each one replays a recorded response from
`test/fixtures/<source>.json` and then runs the shared contract check
(`assertValidStartups`). See `test/fixtures/README.md` for the fixture format and
the copy-paste test template.

### Scheduled collection

Collection is a normal CLI run, so any scheduler can drive it:

- **GitHub Actions** — `.github/workflows/collect.yml` runs
  `npm run match -- --all --limit 25` every 6 hours
  (`cron: "0 */6 * * *"`) and on manual dispatch. It needs no secrets unless
  you want Google results (`SERPAPI_KEY`, or `GOOGLE_API_KEY` +
  `GOOGLE_CSE_ID`).
- **systemd timer** — `deploy/jobfinder-collect.service` and
  `deploy/jobfinder-collect.timer` do the same on an always-on VM every 6 hours
  (`OnCalendar=*-*-* 00/6:00:00`). Install them next to the bot unit:

  ```bash
  sudo cp deploy/jobfinder-collect.* /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now jobfinder-collect.timer
  ```

- **Vercel Cron** — point a cron job at a Function that calls
  `collectStartups()`; the same `src/sources/index.ts` entry point works there,
  and `source.*` metrics flow into Vercel Custom Metrics automatically (see
  [`docs/observability.md`](docs/observability.md)).

`--all` ignores the 30-day seen store so a scheduled pass always shows what the
sources currently return. The systemd pass also adds `--no-write`: it collects
and ranks but never writes the shared seen store, so it cannot mark roles as
seen before the email bot has sent them. The email bot still owns the digest and
de-duplication.

### Enable or disable a source

Every source is controlled from `config/sources.yaml`; no code change is needed.

```yaml
sources:
  remoteok:
    enabled: true      # false removes it from the next run
    limit: 100         # per-source cap
```

- A missing block runs the source with its defaults.
- `enabled: false` skips the source entirely.
- Unknown or not-yet-implemented ids log a warning; the rest of the run
  continues.
- `npm run match -- --source yc,hn` restricts one run without editing the file.

Defaults for the newer sources (feed URLs, limits, categories) live in
`SOURCE_DEFAULTS` in `src/sources/config.ts`.

### Board Scan — Google results in the digest

The API/RSS sources above only see boards that publish a feed. Board Scan covers
the rest by compiling the profile into Google queries that target
applicant-tracking systems directly, e.g.:

```text
("software engineer" OR "backend engineer")
(site:job-boards.greenhouse.io OR site:jobs.lever.co OR ...)
Remote
(-senior -staff -principal -director -manager)
(remote OR "work from home")
```

It is a local implementation of the query-builder pattern observed on
[jobboardscan.com](https://jobboardscan.com/), reconstructed from the page's
served JavaScript. It is **Google-only**: the query is filtered with Google's
`tbs=qdr:*` time parameter.

`npm run scan` is the preview: it prints the exact queries and live Google URLs
without making a request. The `google` source runs each query, keeps the links
that point at the selected ATS boards, and turns each usable result into a
normal `Startup` with the company, role, location, URL, and a hiring signal.
When `enrich` is on (the default), it also fetches the public ATS page so the
scorer sees the full description instead of only the search snippet.

Google does not always honour `site:` when it is combined with title, location,
and level terms. In that case the source retries with a site-only query for up
to `google.siteQueries` boards (default 4), interleaves those results so one
high-volume ATS cannot consume the whole limit, and lets the local matcher apply
the profile. It also queries Google Jobs for the profile's first role + `remote`
in the profile's first non-remote location; set `google.jobs: false` to disable
that. Both result sets go through `rankStartups` like every other source, so the
ones that fit your profile appear in `npm run match` and in the daily email.

It does **not** scrape Google's HTML. Google blocks automated result pages, so
the source uses a results API instead. Configure one provider in `.env`:

- **SerpAPI** — `SERPAPI_KEY` (preferred; one key, returns Google result dates).
- **Google Custom Search JSON API** — `GOOGLE_API_KEY` + `GOOGLE_CSE_ID`
  (official; free 100 queries/day; the search engine must be set to
  *Search the entire web*, otherwise it may ignore the `site:` clauses).

```bash
npm run scan                                  # preview: profile defaults, Remote, 24h, core ATS boards
npm run scan -- --boards all                  # every board in the catalogue
npm run scan -- --role "frontend developer" --location Bengaluru --posted w
npm run scan -- --open                        # open each Google URL in the browser

npm run match -- --source google --all --no-write   # search + rank now, without writing the digest
npm run email:test                            # send a test digest that may include Google matches
npm run email:send                            # send today's daily digest
```

Useful flags: `--posted` (`h1|h4|h8|h12|d1|d2|d3|w|m`), `--level`, `--setup`,
`--boards`, `--variants`, `--no-sponsored`, `--json`, `--no-write`. Each scan
preview also writes a Markdown plan to `out/scan-<date>.md`.

Google stops reading a query after roughly 32 terms, so long board lists are
split into runs and only the first four runs are kept (the drop is reported).
The source keeps at most `google.limit` ATS results across runs (default 20) and
fetches `google.pages` result pages per run (default 2). It sends Google a
country code (`google.country`, default `us`) because site-filtered queries can
return nothing when the country is left to the API default. All of those knobs
live in `config/sources.yaml`.

Two freshness notes: Google's time filter applies to when Google indexed the
page, not a guaranteed posting date; and for `posted: all` a result without a
usable date is dropped by the normal freshness gate. SerpAPI honours the hourly
`tbs` filters directly; the Google Custom Search API can only round hourly
selections up to its `d1` (24-hour) `dateRestrict`.

---

## 4. Email interface

No WhatsApp Business account is needed, and — because it reads your inbox over
IMAP — **no public webhook or tunnel is needed either.** It runs on your own
machine.

### Setup (Gmail example, ~2 minutes)

1. Enable **2-Step Verification** on your Google account.
2. Create an **App password**: <https://myaccount.google.com/apppasswords>.
3. Copy `.env.example` to `.env` and fill it in:
   - `SMTP_USER` / `MAIL_FROM` / `MAIL_TO` = your address
   - `SMTP_PASS` = the 16-character **app password** (not your login password)
4. Send yourself a test: `npm run email:test`.

Any provider works — for non-Gmail, set `SMTP_HOST` / `IMAP_HOST` instead of
`MAIL_PROVIDER=gmail`.

### Run it

```bash
npm run bot          # starts the loop: sends the daily digest, polls for replies
npm run bot:once     # one pass (poll + daily-if-due) and exit
npm run email:test   # send a test digest now
npm run email:send   # send the daily digest now and mark it sent
```

Keep `npm run bot` running in a terminal (or as a background task). It sends
the digest at/after `MAIL_DAILY_HOUR` and checks for your replies every
`MAIL_POLL_MINUTES`.

### Commands (just reply to the email)

| Reply | What happens |
|-------|--------------|
| `matches` | today's matches |
| `more` | the next batch |
| `3` | full details for match #3 |
| `refresh` | re-run the search now |
| `exclude Acme` | never show that company again |
| `help` | usage |

The bot only acts on mail **from your own address** (`MAIL_TO`) and ignores
anything it sent itself (every message it sends carries an `X-Jobfinder`
header), so it can never loop or be driven by a stranger.

**Why email and not WhatsApp?** Without a WhatsApp Business account, the only
other routes are a paid sandbox or an unofficial linked-device bridge that can
get your number banned. Email reproduces the same "text it and it answers"
loop with zero accounts and zero ToS risk. A WhatsApp adapter can be added
later as another channel under `src/channels/`.

---

## 5. Deploy it for free (no server)

The bot just wakes up, checks the inbox, and sends the digest if it's due — so
it doesn't need an always-on box.

### Option A — GitHub Actions (recommended: $0, no server, no card)

`.github/workflows/bot.yml` runs `npm run bot:once` every 30 minutes on GitHub's
free runners. Private repositories get 2,000 Action minutes/month; one pass per
30 min is ~1,400, so it stays inside the free allowance.

It stays correct even though every runner starts with an empty filesystem,
because the **mailbox** is the source of truth:

- your commands are marked `\Seen` in Gmail (durable), so nothing is replayed;
- the daily digest is de-duplicated by looking for it *in the mailbox*
  (`dailyDigestExists` in `src/channels/email/mailer.ts`), not in a local file.

Setup: push the repo, then add four mail secrets under *Settings → Secrets and
variables → Actions* — `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `MAIL_TO`. For
Google results in the digest, also add `SERPAPI_KEY`, or `GOOGLE_API_KEY` +
`GOOGLE_CSE_ID`. Then run *Actions → jobfinder bot → Run workflow* once to
confirm.

**Caveat: GitHub's cron is best-effort.** Ticks are delayed and sometimes
skipped under load (we saw a multi-hour gap on the first day). So the workflow
sets `MAIL_DAILY_HOUR=0`: the digest goes out on the *first run after local
midnight*, rather than at a fixed 8 AM that may never fire. The mailbox de-dup
guard makes repeated runs safe. If you need guaranteed timing or fast replies,
use Option B (a real VM) instead.

### Option B — a free always-on VM ($0, instant replies)

Oracle Cloud *Always Free* (ARM), Google Cloud `e2-micro`, or a GitHub Student
Pack credit box all work. The included `Dockerfile` runs the normal long-lived
loop:

```bash
docker build -t jobfinder .
docker run -d --restart=unless-stopped --env-file .env jobfinder
```

Without Docker, install Node 22, copy the repo, `npm ci`, and run
`npm run bot` under systemd (`deploy/jobfinder.service` is a ready-made unit).

> **Render's free tier will not work:** it blocks outbound SMTP (ports
> 465/587) and wipes its filesystem on every restart.

### Option C — this PC

A Windows Task Scheduler task running `npm run bot:once` every 30 minutes is
free and zero-setup, but only runs while the PC is on.

---

## 6. The single-user config: `profile/profile.yaml`

This file **is** the "for me only" part: skills, domains, target roles, stage /
remote / location / visa preferences, exclusions, plus `education` and `links`.
Terms are matched as whole words, so specific multi-word terms beat single
generic words.

Two fit controls are worth knowing:

- `preferences.maxRequiredYears` — drop postings that explicitly ask for more
  years than this (default `2`). Senior/lead titles are dropped for junior and
  mid profiles regardless of the stated years.
- `preferences.excludeKeywords` — whole-word stack exclusions. `java` excludes
  Java roles but **not** JavaScript; `ruby` and `rails` cover Rails shops.

Exclusions added via the `exclude` command are stored separately in
`data/exclusions.json` so your hand-written YAML is never rewritten.

---

## 7. Layout

```
src/
  index.ts              # CLI: collect → score → rank → markdown digest
  agent/agent.ts        # transport-agnostic command core + daily snapshot
  profile.ts            # profile.yaml → Profile
  types.ts              # Signal / Startup / Profile / Match
  sources/              # every source module (24 today), auto-discovered
  sources/registry.ts   # auto-discovers modules that export sourceId + fetch{Name}
  sources/google.ts     # Google results API → ATS Startups
  scan/                 # Google-only query compiler + `npm run scan`
  match/score.ts        # deterministic, explainable fit score
  match/rank.ts         # company-level merge, freshness gate, then sort
  match/llm.ts          # optional LLM re-rank
  lib/dedupe.ts         # cross-source role matching + stable dedupe keys
  store/db.ts           # seen-store for cross-run dedupe (30-day TTL)
  report/digest.ts      # Markdown / text / HTML renderers + source attribution
  channels/email/       # config, mailer (SMTP+IMAP), bot loop
  lib/metrics.ts        # per-source health metrics (Vercel Custom Metrics + JSON logs)
test/
  fixtures/             # one recorded API response per source (+ README)
  fixtures.ts           # load/replay a fixture by swapping globalThis.fetch
  contract.ts           # assertValidStartups(startups, sourceId)
scripts/record-fixture.ts # `npm run record:fixture <source>`
config/sources.yaml     # which sources, which feeds, YC options
profile/profile.yaml    # YOUR profile  ← the "for me only" file
deploy/jobfinder.service        # systemd unit for the email bot
deploy/jobfinder-collect.*      # systemd unit + timer for the 6-hour collection
.github/workflows/bot.yml       # 30-minute bot pass
.github/workflows/collect.yml   # 6-hour collection pass
.env.example            # mail + Google search credentials template
docs/observability.md   # metric catalog, dashboards, alerting
```

### Adding a source (5 steps)

1. **Create the module.** Drop one file into `src/sources/` (for example
   `newboard.ts`) exporting `sourceId`, a `<Name>Config` type, and a
   `fetch<Name>(config, context)` function. The header of
   `src/sources/registry.ts` has a copy-paste template. Helpers (no `sourceId`)
   and `*.test.ts` files are ignored by the registry.
2. **Register the id.** Add it to `SOURCE_IDS` in `src/types.ts` (which derives
   `SourceId`), then to `SourceSettingsMap` and `SOURCE_DEFAULTS` in
   `src/sources/config.ts` if it needs defaults.
3. **Configure it.** Add a block under `sources:` in `config/sources.yaml`.
   `enabled: false` keeps it off; missing keys fall back to `SOURCE_DEFAULTS`.
   See [Enable or disable a source](#enable-or-disable-a-source).
4. **Record a fixture.** `npm run record:fixture newboard` writes
   `test/fixtures/newboard.json` from one live response.
5. **Add the test.** Copy the template from `test/fixtures/README.md` into
   `src/sources/newboard.test.ts`. It replays the fixture through the real
   fetch function and calls `assertValidStartups(startups, "newboard")`, which
   enforces the `{source}:{id}` id format, non-empty signals, valid
   `SignalType`s, and ISO dates. Run `npm test`.

Cross-source dedupe and `sources` attribution happen in `collectStartups`, so a
source only has to emit its own source-prefixed ids. The digest then credits
every board that contributed a merged role (`wellfound + remoteok`).

### Source health metrics

Every collection run emits `source.jobs_found`, `source.duration_ms`,
`source.success`, `source.failure`, and `source.rate_limited` for each source,
tagged with `source_id`, `run_id`, and `error_type`. Wrapping happens in
`collectStartups`, so a new source is instrumented automatically — no source
code changes. Samples go to Vercel Custom Metrics through `@vercel/functions`
(a no-op outside Vercel); set `METRICS_LOG=1` to also emit one JSON line per
sample for a log-based dashboard on Render or Docker. See
[`docs/observability.md`](docs/observability.md) for the metric catalog,
dashboard queries, and a two-consecutive-failures alert example.

## 8. Going multi-user later

Scoring takes an explicit `Profile`; the snapshot and seen-store take explicit
paths. Multi-user means a `profiles/` dir (or a DB), a per-user store, and
passing a user id through the agent. No matcher rewrite.

## 9. Roadmap

1. **Founder discovery** — map a matched startup → founder name + public email.
2. **Draft generation** — short "why you fit" notes from your `highlights`
   (never auto-send; you review and send).
3. **Natural-language replies** — an optional LLM intent layer so you can just
   write in prose, Backdoor-style.
4. **WhatsApp adapter** — if/when you have a Business account or choose a
   sandbox, add it under `src/channels/`.
