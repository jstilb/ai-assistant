---
name: EventScout
description: San Diego event and activity discovery. Aggregates curated event sources, deduplicates across venues, LLM-ranks by relevance to your natural-language query, and recommends things to do with ticket links and "why it fits" explanations. USE WHEN find events, things to do, what's happening, concerts, shows, activities, comedy, sports, things this weekend, recommend an outing, events near me, free things to do, save an event to my list, anything to do in San Diego, looking for something fun.
---

# EventScout

Discovers upcoming San Diego events from a curated source registry. Fetches, deduplicates, geocodes, and LLM-ranks events against your natural-language query, then returns **every matching event** — the best fits in full detail with "why it fits" lines, the rest as a compact scannable list. It does **not** curate down to a handful; comprehensive coverage is the whole point.

EventScout is the **discovery layer** for Jm's POS — distinct from `activity_log` (past experiences) and `activity_ideas` (wishlist). It surfaces *upcoming external events*.

---

## CLI Commands

All commands run from the repo root. Env overrides for tests:
```
EVENTSCOUT_SOURCES_PATH=/tmp/sources.json  # isolate sources reads/writes
EVENTSCOUT_CACHE_PATH=/tmp/cache.json      # isolate cache writes
EVENTSCOUT_SOURCE_STATE_PATH=/tmp/ss.json  # isolate per-source lastFetched
                                           # (State/source-state.json)
EVENTSCOUT_ALLOW_LIVE_STATE=1              # ack the worktree guard: state-writing
                                           # commands run from a worktree refuse
                                           # live-tree State/ writes without this
                                           # (or a KAYA_DIR / *_PATH redirect)
EVENTSCOUT_DISABLE_RERANK=1                # skip the LLM rerank (deterministic
                                           # score + why-lines only; for tests
                                           # and as a kill-switch)
EVENTSCOUT_REFRESH_TIMEOUT_MS=360000       # per-source live-refresh timeout
                                           # (default 360s). Backstop against a
                                           # hung source — sized to NOT pre-empt the
                                           # inner LLM retry budget (Playwright
                                           # + a stalled-socket extraction retry).
EVENTSCOUT_REFRESH_CONCURRENCY=8           # max sources fetched at once during a
                                           # query's live refresh (default 8). The
                                           # refresh set is uncapped — this bounds
                                           # concurrent load, not coverage.
```

### query — structured event search (the AGENT resolves all natural language)
```bash
bun skills/Productivity/EventScout/cli.ts query "comedy this week" --from 2026-07-06 --to 2026-07-12 --category comedy
bun skills/Productivity/EventScout/cli.ts query "social events where I could meet someone to date this week" --from 2026-07-06 --to 2026-07-12
bun skills/Productivity/EventScout/cli.ts query "Padres home game this month" --from 2026-07-01 --to 2026-07-31 --category sports
bun skills/Productivity/EventScout/cli.ts query "music shows under $30" --max-price 30
bun skills/Productivity/EventScout/cli.ts query "live music this weekend" --from 2026-07-11 --to 2026-07-12 --refresh   # force a live pull
```
**Zero NL interpretation happens in code.** This CLI is a thin, LOUDLY-validated structured interface — see **"How to invoke query (agents)"** below for the full contract every calling agent must follow. `cli.ts` reads the cache (**cache-first** — see Hybrid Refresh below), builds a `QueryContext` straight from the flags you pass (no guessing), filters on HARD constraints, LLM-scores **every** matching event against your full query text, and prints them ranked best-first — the top ~10 as full cards with why-lines, the rest as compact one-liners.

Flags:
| Flag | Repeatable | Meaning |
|------|------------|---------|
| `--from YYYY-MM-DD --to YYYY-MM-DD` | no | Explicit date window (both required together). Omit both → defaults to the next 14 days, with a visible banner. |
| `--free` | no | Hard filter: only free events. |
| `--max-price N` | no | Hard filter: isFree OR price ≤ N. Don't combine with `--free` — pick one. |
| `--category <cat>` | **yes** | Hard filter. Only pass when the user NAMED a category directly. |
| `--time-of-day <bucket>` | **yes** | `morning \| afternoon \| evening \| late`. |
| `--refresh` | no | Live-refresh category-relevant sources before reading the cache. |
| `--limit N` | no | See the warning below — almost never use this. |

Validation is LOUD: a malformed date, an inverted window (`--from` after `--to`), a span over 180 days, or a `--from` more than 2 years out all exit non-zero with a specific error message. There is no silent best-guess fallback anywhere in this path.

> **⚠️ OUTPUT IS ALL RESULTS BY DEFAULT — do NOT add `--limit`.**
> EventScout returns *every* matching event on purpose; the tiered renderer already keeps a large result set readable (top ~10 in full + a compact tail), so capping it defeats the design and is the #1 mistake agents make here. Only pass `--limit N` when Jm *explicitly* asks for a short list ("just the top 5"). The footer line `[N ranked result(s) from M filtered]` should show **N == M** for an uncapped query. To fetch live instead of from cache, add `--refresh` — the CLI no longer sniffs "latest"/"update" out of the query text itself; the agent decides and passes the flag.

---

## How to invoke query (agents)

**You (the calling agent — chat, voice, or cron) resolve ALL natural-language interpretation before calling the CLI.** `cli.ts query` does zero date/refresh/price/category guessing — it only validates structured flags. Every path into EventScout (chat, voice, cron) already has an LLM agent reading this file, so that's where judgment belongs; code keeps only what markdown can't do (loud validation, exact date arithmetic, DST-correct offsets).

The raw query text you pass as the positional argument still flows verbatim to the LLM ranker — keep the nuance in there ("near Balboa Park", "meet people to date", "chill vibe"). Flags only pull out what should be a HARD filter.

### Dates — the part that used to silently break

Weeks are **Monday-start** (Mon–Sun). Resolve relative dates yourself against **today's actual date** (check it — don't assume), then pass `--from YYYY-MM-DD --to YYYY-MM-DD`. Worked examples, assuming **today is Friday 2026-07-03**:

| User said | Resolve to | Flags |
|---|---|---|
| "Monday through Thursday" | the *next* Mon–Thu (a **4-day window**, not a single day — this is the exact bug this redesign fixes) | `--from 2026-07-06 --to 2026-07-09` |
| "July 6 to July 9" | the literal dates named | `--from 2026-07-06 --to 2026-07-09` |
| "this weekend" | upcoming Sat+Sun | `--from 2026-07-04 --to 2026-07-05` |
| "next Friday" | the Friday in the *following* Mon–Sun week (single day) | `--from 2026-07-10 --to 2026-07-10` |
| "tonight" | today only | `--from 2026-07-03 --to 2026-07-03` |
| (no date mentioned at all) | omit `--from`/`--to` entirely | *(none — CLI defaults to the next 14 days and prints a banner)* |

**Never half-resolve a range.** If the user gave two endpoints ("Monday through Thursday", "July 6 to July 9"), both `--from` and `--to` MUST reflect the full span — a regex or a rushed read that only catches the first date is exactly the class of bug this slice exists to kill. If you're not confident in the resolved dates, omit `--from`/`--to` and let the CLI default rather than guess wrong silently.

### Refresh intent

Pass `--refresh` when the user's phrasing signals they want fresh data: "latest", "what's new", "just added", "refresh", "right now". Otherwise omit it — cache-first is the default and is fast.

### Price

- "free stuff" / "free events" (no dollar ceiling mentioned) → `--free`
- "under $30" / "less than $30" → `--max-price 30`
- **Never pass both.** `--max-price N` already includes free events (Filter.ts treats `isFree` as always satisfying a maxPrice check), so a phrase naming BOTH ("free stuff under $30") resolves to `--max-price 30` ALONE, not `--free` — adding `--free` on top would wrongly narrow the result to free-only and drop the $1–$30 range the user asked for.

### Category — ONLY when the user named one

- "comedy shows" → `--category comedy` (repeat the flag for multiple: `--category comedy --category music`)
- "Padres game" → `--category sports`
- "meet people" / "date night" / "something social" → **NO `--category` flag.** These are vibes/goals, not named categories — hard-filtering to `community` would silently drop a salsa night or a comedy show that fits the intent just as well. Let the LLM ranker judge fit from the raw query text instead.

### time-of-day

Only pass `--time-of-day <bucket>` (`morning | afternoon | evening | late`, repeatable) when the user named a time band directly ("something in the evening"). Don't infer it from vague phrasing.

### Output

Print the full query text as the positional arg, always. Never add `--limit` unless Jm explicitly asked for a short list (see the warning above).

### prefetch — ingest all enabled sources
```bash
bun skills/Productivity/EventScout/cli.ts prefetch
```
Runs the full ingest pipeline over all enabled sources in `sources.json`: fetch → extract → dedup → geocode → cache. Updates `lastFetched` on each successfully ingested source. Run this on a schedule (Slice 10 adds a launchd plist).

### list-sources — inspect the source registry
```bash
bun skills/Productivity/EventScout/cli.ts list-sources
```
Prints each source's id, fetch tier, enabled flag, and last fetched timestamp.

### add-source — register a new event source
```bash
bun skills/Productivity/EventScout/cli.ts add-source https://example.com/events
bun skills/Productivity/EventScout/cli.ts add-source https://example.com/events \
  --tier html-llm --category music --name "My Venue"
```
Validates the URL and schema, then appends a new `EventSource` to `sources.json`. Defaults: `tier=html-llm`, `pollInterval=720` (12 hours), `enabled=true`. Valid tiers: `api | rss | ics | spa | html-llm | wp-tribe | evvnt | pike13 | ctycms | activenet | dancestudio-pro | nineteenhz | sitemap-llm`. Valid categories: `music | comedy | theater | sports | arts | community | festival | talk | film | food | other`.

### refresh — live-ingest one source
```bash
bun skills/Productivity/EventScout/cli.ts refresh <sourceId>
```
Immediately fetches one source by id and updates its `lastFetched`. Useful to force-refresh a single source without a full prefetch.

### ui — browse the cache in a local web UI
```bash
bun skills/Productivity/EventScout/cli.ts ui
```
Launches a minimalist local web app (default `http://localhost:4180`, override with `EVENTSCOUT_UI_PORT`) and opens it in the browser. It serves the live `events-cache.json` as a dense, sortable table: filter by date range, category, and source; search across title/venue/source/performers/tags/description; toggle free-only; click any row to expand full details with ticket/source links. Every row has a **★ star toggle** that saves the event to Jm's "interested" shortlist (see `saved` below); the **"★ Saved" toolbar checkbox** filters the table to that shortlist, including saved events that have since rotated out of the cache (flagged "no longer in the catalog"). The toolbar can trigger a **full refresh** (runs `prefetch` for all sources) or a **single-source refresh** (runs `refresh <id>`) as a background child process with live progress, then reloads the table. Set `EVENTSCOUT_UI_NO_OPEN=1` to suppress the browser auto-open (headless). Implemented in `Tools/UiServer.ts` + `ui/index.html` (no build step, no extra dependencies). Ctrl-C to stop. Always-on as launchd service `com.kaya.eventscout-ui` (loopback by default). **Phone access** (Pixel over Tailscale): set `eventscout_ui_bind` (`0.0.0.0`) + `eventscout_ui_token` in `~/.claude/secrets.json`, kickstart the service, then open `http://<mac-tailscale-ip>:4180/?token=<token>` once (sets a cookie). A non-loopback bind without a token refuses to start — see `lib/core/RemoteAccess.ts`.

### saved — Jm's local "interested" shortlist
```bash
bun skills/Productivity/EventScout/cli.ts saved            # list saved events
bun skills/Productivity/EventScout/cli.ts saved add <id>   # save from the cache
bun skills/Productivity/EventScout/cli.ts saved remove <id>
```
The same list behind the UI's star toggle, persisted to `State/saved-events.json` (env override for tests: `EVENTSCOUT_SAVED_PATH`). Entries snapshot the **full event**, so a saved pick stays viewable after the cache is regenerated or prunes past events; `saved list` marks those `[no longer in cache]`. Saving is idempotent — re-adding refreshes the snapshot and keeps the original `savedAt`.

**Agent disambiguation — "save this event" has two targets.** Marking interest ("save that one", "I'm interested in the jazz show", star-this) → `saved add` (local shortlist, reversible, no LifeOS write). An explicit ask to put it on the LifeOS wishlist ("add it to my activity ideas") → `save <id>` (EXPORTS to the `activity_ideas` sheet via `Tools/Actions.ts`). Default to `saved add` when the wording is just "save".

---

## How Sources Work, Editing InterestProfile.json, Hybrid Refresh Behavior

The `EventSource` field table, the `InterestProfile.json` rules and the hybrid refresh rules are in `references/SourcesAndProfile.md`. Read it before you add or edit a source or the profile.

## Booking Notices (discover → calendar → *book*)

Many events need a booking action (tickets, reservation, RSVP) before a deadline. The agent judges `--action` and `--book-by`, not the code. For the rules and the judging guide, read `Workflows/BookingNotices.md` before you put such an event on the calendar. See also `docs/BOOKING_PROCESS.md`.

## The Thursday plan (weekend holds on Jm's calendar)

Every Thursday at 16:30 the weekend-digest job (`Tools/WeekendDigest.ts`) ranks the coming Saturday and Sunday once, then `Tools/WeekendHolds.ts` puts **at most 3** picks on Jm's primary Google Calendar as `EventScout hold: <title>` entries. Each hold is tentative, shows as free, has no reminders (no notification), and carries the source link, place, price and a "Return visit" line when the venue is in his history (activity_log or his calendar, last 8 weeks). Jm drops a hold by deleting it; the next run records it as dropped and never puts it back (one placement per weekend). A weekend with 3 or more of his own timed entries (10:00–23:00) gets no holds.

- Calendar writes go through `Tools/CalendarApi.ts` (Calendar REST API with gcalcli's stored login, via `Tools/gcal_token.py`) and the shared calendar write log. Holds are found again by a private tag (`eventscoutHold`, `eventscoutWeekend`, `eventscoutEventId`), never by title.
- Recurring groups first (`Tools/Community.ts`, ALIGNMENT G2): the whole cache is grouped into series (title without dates + venue). A series recurs when its dates fall on one weekday with gaps of 6+ days, or a source gives a weekly/monthly rule. One Sonnet call per run judges which recurring series are communities (classes, clubs, pickup sports, dance socials, open mics, volunteer groups) and which are not (watch-only shows, residencies, exhibits, kids-only or seniors-only programs). Communities with score ≥ 40 come before one-off shows; their holds carry "Recurring group: meets weekly on Saturdays (EventScout found it on N dates, …)" — or, with only 2 dates or uneven gaps, "the sources list it on 2 Saturdays: Nov 7, Nov 14" (no "every" claim). If that call fails, the holds follow score order and the job exits 1 ("community check FAILED" in the log).
- Pre-hold source check (`Tools/SourceCheck.ts`, product review 1, 2026-11-08): for picks from a public Google Calendar feed (e.g. the Daylight calendar), the job reads that calendar's weekend through the Calendar API just before placement. Found → the hold links to the event's own page and adds "Organizer page: …" and "Checked on the source: …"; gone → no hold, the next pick takes its place. If the read fails, those picks keep the calendar-view link and the job exits 1 ("source check FAILED"). Other sources are not re-checked yet.
- Weeknight hold (product review 1, 2026-11-08): most recurring groups meet Mon–Fri, so the same run also plans this Friday and next Monday–Thursday. It ranks only evening events (17:00+) from recurring series (about 60 events, ~2 scoring calls; never the whole week), sends them through the same community call, and places at most 1 weeknight hold, for a community only. That hold takes the last of the 3 slots and is never the same group or place as a weekend pick. If the weeknight ranking fails, the weekend holds still go out and the job exits 1 ("weeknight ranking FAILED"). Kill switch: `EVENTSCOUT_WEEKNIGHT=off`.
- Follow-up (ALIGNMENT G3 slice 1, 2026-11-08): each hold ends with "After you go: how was it, and anyone you want to see again? Tell Kaya in one line with a rating …". Such a line routes through the LifeOS Router to activity_log (no push channel).
- Ledger: `State/holds-ledger.json` (placed / kept / dropped per weekend — the real-use counter; each hold also records `community` and `seriesKey`).
- Dry run: `KAYA_ALERT_DRY_RUN=1 EVENTSCOUT_HOLDS_DRY_RUN=1 bun skills/Productivity/EventScout/Tools/WeekendDigest.ts`. Kill switch: `EVENTSCOUT_HOLDS=off`.
- Scope (Jm, 2026-11-08): tentative holds only. Never invite anyone, send a message or buy a ticket.

## Architecture, Integration

The pipeline layout, fetch tiers, adapters, and the Feeds Into and Uses lists are in `references/ArchitectureAndIntegration.md`. Read it when you change the pipeline or an integration.

## Known Limitations & Coverage

Dated coverage notes and known limits (source counts, census fixes, per-source notes, weekend digest, worktree live-state guard) are in `references/KnownLimitations.md`. Key limits: weeks start on Monday; the agent resolves all dates; ranking is pure LLM judgment with no tunable weight.

