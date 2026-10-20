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

- **Sources** (public, no auth): **YC** company directory, **HN** "Who is
  hiring?" thread, **funding** RSS feeds, **Product Hunt** launches, plus fresh
  job boards — **RemoteOK**, **Remotive** and **Arbeitnow**.
- **Matching** — a transparent, deterministic score (0–100). Whole-word
  matching (so `java` ≠ `javascript`), plus domain fit, signal strength,
  recency, stage, location/remote, and junior/senior awareness. Hard exclusions
  drop a startup to 0; opportunities with no matching skill/domain/role are
  dropped entirely.
- **Freshness gate** — `preferences.maxAgeDays` keeps only opportunities whose
  newest signal is within that many days (undated listings are dropped, since
  their freshness can't be verified). Set to `3` to see only what's fresh.
- **Daily snapshot** — one run per day is cached in `data/snapshot-<date>.json`
  and reused, so the bot stays consistent and doesn't re-hit sources.
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

Setup: push the repo, then add four secrets under *Settings → Secrets and
variables → Actions* — `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `MAIL_TO` — and
run *Actions → jobfinder bot → Run workflow* once to confirm.

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
  sources/              # yc, hn, funding, producthunt, remoteok, remotive, arbeitnow (+ rss helper)
  match/score.ts        # deterministic, explainable fit score
  match/rank.ts         # dedupe across sources, then sort
  match/llm.ts          # optional LLM re-rank
  store/db.ts           # seen-store for the CLI's "new only"
  report/digest.ts      # Markdown / text / HTML renderers
  channels/email/       # config, mailer (SMTP+IMAP), bot loop
config/sources.yaml     # which sources, which feeds, YC options
profile/profile.yaml    # YOUR profile  ← the "for me only" file
.env.example            # mail credentials template
```

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
