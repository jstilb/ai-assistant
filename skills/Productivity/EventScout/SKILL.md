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
                                           # inner LLM retry budget (Apify/Playwright
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
Validates the URL and schema, then appends a new `EventSource` to `sources.json`. Defaults: `tier=html-llm`, `pollInterval=720` (12 hours), `enabled=true`. Valid tiers: `api | rss | ics | shopify | spa | html-llm | wp-tribe | evvnt | apify | pike13 | ctycms | activenet | dancestudio-pro | nineteenhz | sitemap-llm`. Valid categories: `music | comedy | theater | sports | arts | community | festival | talk | film | food | other`.

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

## How Sources Work

Sources are defined in `Tools/sources.json`. Each entry is an `EventSource`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique stable identifier |
| `url` | string | Canonical page or feed URL |
| `name` | string | Display name |
| `fetchTier` | enum | How to fetch: `api \| rss \| ics \| shopify \| spa \| html-llm \| wp-tribe \| evvnt \| apify \| pike13 \| ctycms \| activenet \| dancestudio-pro \| nineteenhz` |
| `categoryHint` | Category? | Category most events from this source belong to |
| `geoHint` | string? | Default neighborhood when events lack an address |
| `pollInterval` | number | Minutes between refreshes (720 = 12 hours) |
| `lastFetched` | ISO string? | Merged in at load from `State/source-state.json` (runtime state, split from config 2026-08-20 — never written to sources.json) |
| `highValue` | boolean? | Prefetch-priority hint (does NOT force query-time refresh in v2) |
| `enabled` | boolean | Set to false to pause a source without deleting it |

To add a source: use `add-source` (above) or edit `Tools/sources.json` directly — both are supported. After adding, run `prefetch` to populate the cache.

---

## Editing InterestProfile.json

`InterestProfile.json` (in the skill root) is intentionally thin — just home
and radius, the only two fields any code reads:

```jsonc
{
  "homeLocation": { "lat": 32.7448067, "lng": -117.2476067, "label": "Ocean Beach, San Diego" },
  "defaultRadiusMiles": 25
}
```

`homeLocation` is the haversine origin `Filter.ts` measures every event
against (paired with `defaultRadiusMiles` as the hard cutoff — events beyond
the radius are excluded; events with no coords at all are kept, see "Recall"
below) and the fallback origin `Ranker.ts` uses for its distance-from-home
scoring-line signal and its sooner/nearer tiebreak. There is no taste field
here to tune: ranking is pure LLM judgment against the raw query text —
"query is everything" (Jm 2026-06-04) — so the only way to change what
EventScout surfaces for a given search is to change the query wording itself.
Manual edits to `homeLocation`/`defaultRadiusMiles` take effect immediately,
on the next query.

---

## Hybrid Refresh Behavior

The `query` command is **cache-first** by default (v2, Slice 1):

1. **Scheduled prefetch** (via `prefetch` or launchd) populates `events-cache.json` every 12 hours. All queries read from this cache by default — no live network calls, fast.

2. **Live refresh is opt-in.** A refresh fires ONLY when the `--refresh` flag is passed to `query`. There is no more NL sniffing in code — the calling agent decides refresh intent from phrasing ("latest", "what's new", "just added", etc. — see "How to invoke query (agents)" above) and passes the flag explicitly.

3. **`highValue` no longer forces query-time refresh.** The `highValue` field remains in the schema and `sources.json` as a prefetch-priority hint (future use), but it has no effect on whether a source is refreshed at query time.

4. **When a refresh fires**, `selectRefreshSources()` selects all **enabled**, **category-relevant** sources — staleness is ignored on an explicit refresh (user asked for fresh data). Category relevance: if your query specifies a category (e.g. "comedy"), only comedy-hinted or hint-free sources are included; comedy sources are excluded from a music query.

5. **Concurrency + persistence.** Refreshed sources run through a bounded-concurrency pool (`EVENTSCOUT_REFRESH_CONCURRENCY`, default 8) with a per-source timeout (`EVENTSCOUT_REFRESH_TIMEOUT_MS`, default 360s). Fetched events are persisted to cache before ranking. `lastFetched` updates are batched to avoid races on `State/source-state.json`.

6. **Observable logging:**
   - Cache-only path: `[hybrid] cache-only — reading cache (pass --refresh or say 'latest/update' to fetch live)`
   - Refresh path: `[hybrid] Refreshing N source(s) live …`

7. After any live refresh, the full (now-updated) cache is read → filtered → ranked → returned.

---

## Booking Notices (discover → calendar → *book*)

EventScout closes the loop from discovery to attendance. Putting an event on the
calendar is not the last step — many events need a **booking action** first (buy
tickets, make a reservation, RSVP) and that action has a deadline. The booking
subsystem tracks those deadlines and reminds you before they pass.

**Classification is agent-judged, not guessed in code** (markdown-first
de-determinization, Slice 2, 2026-07). The old classifier (`classifyBooking`, a
regex cascade over ticket/reservation keywords) was an enumerated keyword list —
silently wrong on anything unanticipated. `cli.ts` now does zero text-sniffing:
**YOU (the calling agent)** read the event's title/description/price/tags and pass
the booking action explicitly.

```bash
bun skills/Productivity/EventScout/cli.ts add-to-calendar <eventId> [--action buy-tickets|reserve|rsvp|none] [--book-by YYYY-MM-DD]
bun skills/Productivity/EventScout/cli.ts booking note <eventId>    [--action buy-tickets|reserve|rsvp|none] [--book-by YYYY-MM-DD]

# Booking notices:
bun skills/Productivity/EventScout/cli.ts booking scan [--window N]  # due actions (default 14d)
bun skills/Productivity/EventScout/cli.ts booking list              # full ledger
bun skills/Productivity/EventScout/cli.ts booking booked <eventId>  # stop reminders (booked)
bun skills/Productivity/EventScout/cli.ts booking dismiss <eventId> # stop reminders (dismissed)
```

### How to judge `--action` (agents)

Read the event's title, description, price fields (`isFree`/`priceMin`/`priceMax`),
and any ticket URL, then judge which of the four actions applies:

- **`buy-tickets`** — the event costs money and you need to purchase entry ahead of
  time (a priced concert, a Padres game, a paid comedy show).
- **`reserve`** — you're holding a table/seat ahead of time, usually free to hold
  but capacity-limited by a physical reservation (tasting menu, prix-fixe dinner,
  "table for two", omakase, assigned seating). **This applies even when the event
  is ALSO paid** — see the precedence rule below.
- **`rsvp`** — free (or free-to-claim-a-ticket) but capacity-limited by a
  headcount/signup rather than a held table (Eventbrite RSVP, "register", "sign
  up", "limited spots", a free ticket link with no reservation language).
- **`none`** — just show up. No ticket, no RSVP, no reservation — a bare free
  meetup or drop-in event. Passing `--action none` deliberately skips the ledger
  entry entirely (no notice, so the digest stays signal, not noise) — only use it
  when you're confident no booking is needed; if you're unsure, omit the flag
  instead (see below), don't guess `none`.

**Precedence when signals conflict:** reservation/table/seating wording wins over
price. A **paid** event that ALSO reads "reservation required" / "table for two" /
"prix-fixe" is `reserve`, not `buy-tickets` — the thing being secured is a table,
not a ticket, even though money changes hands. Only fall back to `buy-tickets` when
the event is paid with no reservation/table language at all.

**When you're not confident, omit `--action` entirely.** This is NOT an error — the
CLI accepts it and the entry lands `"unclassified"` (rendered as ⚠️ Needs review),
which nags in every `booking scan`/digest until it's re-noted with a real action or
explicitly marked booked/dismissed. Surfacing an event for a second look beats
silently mislabeling it — guessing wrong and burying the mistake in `none` or a
confident-but-incorrect action is exactly the failure mode this migration removed.

### Choosing a `--book-by` override

Code still owns the date arithmetic: `bookBy = eventStart − leadDays`, clamped to
"book now" if the ideal lead window has already passed. **These are the code's
default lead times, and they remain authoritative whenever `--book-by` is
omitted** — you don't need to compute a date yourself in the normal case:

- `buy-tickets` — keyed by category: sports/festival 21 days, music/comedy/theater
  14 days, arts/food 7 days, talk/film 5 days, community/other 3–7 days.
- `reserve` — always a 7-day lead, regardless of category.
- `rsvp` — always a 3-day lead, regardless of category.

Pass an explicit `--book-by YYYY-MM-DD` only when you know a deadline that differs
from that default — e.g. the event page says tickets go on sale Friday and
typically sell out same-day (sooner than the 14-day default), or a reservation
line names an explicit cutoff date. The override always wins over the computed
default, and it still applies even to an `unclassified` entry (you can record a
known deadline before you're sure of the exact action).

- **Delivery** (`Tools/BookingDigest.ts`, daily 07:30 via
  `com.kaya.cron.eventscout-booking-notices` — migrated 2026-08-20 to the
  monitored run-cron-job family, manifest in
  `MEMORY/daemon/cron/manifests/eventscout-booking-notices.yaml`):
  overdue/urgent actions **page** via AlertGate (edge-triggered per event),
  "soon" ones roll into the daily digest. Passed events are auto-expired so
  they stop nagging. `unclassified` entries have no bookBy, so they roll into
  the daily digest every day until resolved.

Full write-up: [docs/BOOKING_PROCESS.md](docs/BOOKING_PROCESS.md).

---

## Architecture

```
YOU (the calling agent) — read "How to invoke query (agents)" above,
resolve NL → structured flags
    |
    ▼
cli.ts buildQueryContext  (flags → QueryContext; LOUD validation, zero NL guessing)
    |
    ▼
sources.json
    |
    ▼ prefetch / hybrid live-refresh
[Ingest.ts]  ←→  adapters/: PadresAdapter | RSSAdapter | SPAAdapter
    |
    ▼ dedup + geocode
events-cache.json
    |
[Query.ts / queryHybrid]
    |
    ├── Tools/Window.ts      (--from/--to → DST-correct { start, end }, or the
    │                         default next-14-days window; see tz.ts's laDateIso)
    ├── Filter.ts            (HARD constraints only: date window, price, explicit
    │                         category, far-coord exclusion — see "Recall" below)
    ├── Ranker.ts            (LLM scores EVERY filtered event 0–100; global sort;
    │                         rawQuery text carries all remaining semantic nuance)
    └── Render.ts            (tiered markdown: top ~10 full + compact tail)
```

**Ranking is LLM-score-everything** (`Ranker.ts`, v2 — there is NO candidate-pool cap and NO omission):
1. **Intent brief** — one LLM call turns the raw query into a short "what counts as a fit"
   brief, reused across all scoring batches for cross-batch consistency.
2. **Score every event** — all filtered events are batched (~40/call, run concurrently)
   and the LLM assigns each a 0–100 relevance score for *this* query (explicit rubric)
   plus a why-line, reading fuller event context + practical signals (day-of-week,
   how-soon, distance, free/paid). This is what catches semantic intent ("meet people /
   dating potential" → a singles night). The rubric also carries an AGE-GATE line:
   kids-only events (explicit age cap ≤17, camps/story-times) score 0–20 unless the
   query expresses kids/family intent (regression-gated by the
   `eventscout_agegate_rubric` eval). **Every matching event is scored and returned —
   nothing is dropped or curated away.**
3. **Global sort** — descending by score; ties broken by sooner date, then nearer.
   The tiered renderer shows the top ~10 in full and the rest as compact one-liners.
   **There is no hand-seeded taste weighting at all** — `InterestProfile.json` holds
   only `homeLocation`/`defaultRadiusMiles` (see "Editing InterestProfile.json"
   above); Ranker.ts never reads a category/genre/vibe preference of any kind.
   "Query is everything" (Jm 2026-06-04).
   Fallback: `EVENTSCOUT_DISABLE_RERANK=1` or LLM failure → soonness order over all events.

**Recall is deliberately loose** so Stage 2 has good candidates to choose from:
- **Missing coords are NOT excluded.** Only ~50% of events geocode; hard-excluding the
  rest silently hid half the catalog. Coordful events beyond the radius are still cut
  by `Filter.ts`; for events that DO have coords, unknown-locality isn't a thing — the
  distance itself (or "location unknown" when coords are absent) is just one of several
  signals `Ranker.ts` hands the LLM in each event's scoring line (alongside day-of-week,
  how-soon, free/paid). There's no code-level penalty applied before scoring — how much
  distance matters is entirely the LLM's judgment call per query.
- **Category is soft unless the agent makes it explicit.** The calling agent only passes
  `--category` when the user *named* one directly ("comedy shows") — that hard-filters.
  For a vibe/goal query ("meet people") the agent passes NO `--category` flag at all, so
  Filter.ts applies no category gate and cross-category fits (salsa, comedy) survive as a
  ranking signal in Ranker.ts instead. There is no more `categoriesExplicit` guess in code
  — presence of the flag *is* the explicitness signal now.

Key files:
- `Tools/sources.json` — source registry (edit to add sources)
- `InterestProfile.json` — home/radius only (see "Editing InterestProfile.json" above)
- `State/events-cache.json` — populated by prefetch/refresh
- `Tools/Window.ts` — `buildExplicitWindow`/`buildDefaultWindow` (date-window construction)
- `Tools/RefreshIntent.ts` — pure `selectRefreshSources()` selector (refresh=true/false → sources to live-fetch)
- `Tools/SourceManager.ts` — sources.json CRUD
- `cli.ts` — CLI entrypoint + `buildQueryContext` (flags → QueryContext)

---

## Integration

### Feeds Into
- `LifeOS` — save a pick → `activity_ideas`; add to calendar → `CALENDAR` route (Slice 11)
- `CalendarAssistant` / gcal — `add-to-calendar` creates the event
- `AlertGate` → `Telegram` — booking notices (page + daily digest) AND the
  Friday weekend digest (`Tools/WeekendDigest.ts`, built 2026-08-20 — spools
  digest-tier, rides the morning digest)
- `Telegram` — no direct recommendation surface beyond the AlertGate digests
  (the earlier Slice 11 Telegram/voice renderers, `Tools/Surfaces.ts`, had
  zero callers and were deleted in Slice 4)

### Uses
- `lib/core/Inference.ts` — NL parsing, LLM extraction, ranking
- `lib/core/CachedHTTPClient.ts` — HTTP with caching
- `ContentAggregator/Tools/RSSParser.ts` — RSS/Atom feed parsing
- `ContentAggregator/Tools/ContentDeduplicator.ts` — cross-source dedup
- BrightData 4-tier — SPA event page fetching; tier 3 is a real headless
  Playwright render and tier 4 a real Bright Data Web Unlocker REST call
  (`POST api.brightdata.com/request`, zone `mcp_unlocker`) since 2026-08-20
  (stealth profile; block-page detection applies to both tiers; tier-4
  circuit breaker 1/domain/hour, token from `~/.claude/secrets.json`
  `BRIGHTDATA_API_TOKEN`)

---

## Known Limitations & Coverage

- **Source coverage (62 registered in `Tools/sources.json` — ALL enabled as of 2026-08-24; zero disabled entries):** the old promotion backlog is cleared. JS-shell SPAs hydrate for real now: BrightData **tier 3 is an actual headless Playwright render** (implemented 2026-08-20 — before that it silently fell through to curl) with a stealth profile (real-Chrome UA + AutomationControlled masked) that defeats Cloudflare-class walls (verified: Bandsintown, EDMTrain, Spin), and anti-bot block pages are detected and treated as tier FAILURES, never served as content. Sites that resist even that get per-site adapters (RA GraphQL, DanceStudio-Pro POST, 19hz table parser, EDMTrain API). Yield still varies by season and site content — **failures are always logged with a reason, never silently dropped** (`prefetch` prints per-source counts).
- **Census fixes (2026-08-20):** the first full 57-source census prefetch surfaced 4 problem sources, all fixed and live-verified. `sandiego-fc`: ESPN now 403s Mozilla-prefixed non-browser UAs but accepts curl-style, so `SdfcAdapter` sends `User-Agent: curl/8.7.1` (7 events). `bandsintown-sd`: moved to the city page `bandsintown.com/c/san-diego-ca` — the old root `/?latitude=…` URL hits the bot wall even on tier 3, while the city page carries server-side content (72 events). `sandiego-org-events`: apify → `spa` tier, `maxLlmWindows: 8` — the tier-3 Playwright escalation carries it (26 events; the tier-4 static HTML has no extractable events). `sdpl-library-events`: served by the tier-4 unlocker (see library bullet).
- **Apify tier has ZERO sources (2026-08-20) — `ApifyAdapter.ts` is a deletion candidate.** Both former apify sources (`bandsintown-sd`, `sandiego-org-events`) moved to `spa` after the census showed their actor runs TIMED-OUT (200s actor timeout) on **every** prefetch since at least 08-18, running concurrently at 2×8192MB = the full 16GB account memory cap (also: killing a local prefetch orphans its actor runs, which keep holding server-side memory and cause one-off "memory limit" failures). Deletion test (run 2026-08-20): removing `ApifyAdapter.ts` (291 lines) + `tests/apify.test.ts` (208 lines) + the one `case "apify"` arm in `Ingest.ts` + the `"apify"` enum member in `types.ts` makes that complexity vanish with nothing reappearing — the only other reference is a comment in `ICSAdapter.ts`. Kept for now so `apify` stays a valid config tier; delete on next debt sweep. (`sdpl-library-events`, `sdcl-library-events`, added 2026-07-05):** San Diego Public Library's events platform (`sandiego.events.mylibrary.digital`, all ~35 branches incl. Ocean Beach — Jm's home neighborhood) and San Diego County Library's BiblioCommons events calendar (`sdcl.bibliocommons.com`, note SDCL does not serve the City of San Diego/Ocean Beach — its nearest branches are ~10+ miles out). Both are `categoryHint: "community"` with a generic `San Diego, CA` `geoHint` since each source spans many venues; per-event branch/venue text carries the actual location for geocoding and LLM ranking to judge proximity. `sdpl-library-events` uses `fetchTier: "spa"` with `maxLlmWindows: 20`, and is the one source that lives on **tier 4**: the platform's bot wall defeats tiers 1–3 (even the tier-3 stealth Playwright render is blocked), but the Bright Data Web Unlocker serves ~4MB of real listings (verified 2026-08-20: 97 events extracted, 94 persisted, Ocean Beach branch included) — each refresh costs 1 unlocker credit and the circuit breaker allows 1/domain/hour, which its 720-min `pollInterval` respects; `sdcl-library-events` uses `fetchTier: "html-llm"` (plain fetch succeeds) with `paginate: {param: "page", pages: 20}` (mirrors `eventbrite-sd`'s pagination tradeoff — the county-wide calendar has 7,000+ total items across 366 pages, so only the nearest-term ~400 are pulled per prefetch).
- **The Dancehouse class schedule (`thedancehouse-schedule`, added 2026-08-20):** Point Loma dance studio (2180 Chatsworth Blvd — adult ballet, contemporary, hip hop choreography, house open floor, Saturday Hip Hop Line Dance & Social). thedancehouse.com/schedule/ holds the schedule in a **cross-origin** DanceStudio-Pro iframe whose table loads via AJAX POST — still out of reach for the tier-3 browser render (it captures the main frame's DOM, not cross-origin iframe content) — so `fetchTier: "dancestudio-pro"` (`Tools/adapters/DanceStudioProAdapter.ts`) POSTs `app.gostudiopro.com/apps/api_classes-ajax.php` directly (the dancestudio-pro.com host 301s POSTs body-less; GET returns an empty 200) and runs the shared JSON-LD → LLM extraction on the returned table HTML, dating each weekly class to its next occurrence. The studio `id`/`s` params live in the source's url; a second DanceStudio-Pro studio reuses the adapter by adding a source with its own params.
- **SD Parks & Rec activities (`sdparkandrec-activenet`, added 2026-08-20):** the City's ActiveNet catalog (`anc.apm.activecommunities.com/sdparkandrec`) via its public JSON list API (`fetchTier: "activenet"`, `Tools/adapters/ActiveNetAdapter.ts`) — ~1,900 rec-center classes, leagues, camps, and one-off community events city-wide (includes La Jolla Rec cooking, JunkYard hip-hop, etc.). One EventItem per activity *session* at its next upcoming meeting (not per weekly occurrence — that would flood the cache); multi-week span/cadence is prefixed into the description, in-progress sessions are tagged `in-progress`. Skips date-less parent rows (sub-activities aren't expandable via the list API) and youth-capped rows (max age < 18). Caveat: `time_range` mirrors the site verbatim, and some rec centers enter the wrong meridiem (evening classes listed as "5:00 AM") — not correctable deterministically.
- **Resident Advisor San Diego (`ra-co-sandiego`, added 2026-08-20):** electronic-music/club listings for the RA "sandiego" area (area id 309) via RA's own GraphQL API (`fetchTier: "api"`, `Tools/adapters/RaCoAdapter.ts`) — the listings *page* (`ra.co/events/us/sandiego`) 403s plain fetches, but `POST ra.co/graphql` answers unauthenticated with exact structured data (venue, address, cost, lineup, RA-pick blurbs), so no browser or LLM extraction is involved. ~60–90 listings per 120-day horizon; re-listings of the same event under multiple listing dates are collapsed by stable id in the adapter. Events carry RA's own genre taxonomy as tags ("house", "hip-hop", "trance", …) when RA has them; "electronic" is only the platform-default fallback tag for untagged listings. Caveat: `cost` is free-text and usually blank — blank maps to `isFree: false` with no price (unknown ≠ free; most blank-cost RA events charge at the door).
- **Dance-scene coverage (salsa/bachata + hip hop, expanded 2026-08-20):** salsa/bachata socials come from `tangodelrey-*` (Thu social, PB), `majestyinmotion-*` (Stein studio socials + MemberLife class API), `sevilla-nightclub-sd` (Gaslamp Latin Nights + Bachata Room Tuesdays — the WP page's UrVenue calendar renders dated listings into static HTML, so plain `html-llm` works despite the Tribe API being Cloudflare-walled), and `melomano-events` (Kearny Mesa studio socials/workshops/free tryouts, `maxLlmWindows: 8`). Hip hop dance comes from `cultureshock-sd` (pike13), `dancehouse-eventbrite` (incl. Primo Session open floor), `civic-dance-arts`, and `culture-of-4` (Freestyle Session SD — 1.28MB Wix page, needs `maxLlmWindows: 12`; the default 4 windows extracted 0 events). Hip hop *club nights* additionally surface via `ra-co-sandiego` genre tags. Per Jm's research (2026-08-19): no weekly public hip-hop cypher exists beyond Primo Session + Culture Shock open floor; crew jams are Instagram-announced and not feed-scrapable.
- **Dates:** weeks are **Monday-start**. Date resolution is no longer attempted in code at all — the calling AGENT resolves every relative/absolute expression ("this weekend", "next Friday", "June 6–7") into explicit `--from YYYY-MM-DD --to YYYY-MM-DD` flags (see "How to invoke query (agents)" above) before calling the CLI. The CLI's only job is exact date arithmetic on those two strings (DST-correct LA midnight/23:59:59 boundaries, `Tools/Window.ts`) plus LOUD validation — it never guesses. No `--from`/`--to` at all → the CLI itself defaults to the next 14 days with a visible banner; it does not fall back to a regex parse of the query text.
- **Extraction quality:** events from messy HTML (LLM-extracted) occasionally carry an imperfect field (e.g. a malformed ticket URL). API / RSS / JSON-LD sources are exact.
- **No user-tunable ranking weight:** there is no taste profile to edit — ranking is pure LLM judgment against the raw query text every time. The only lever on results is the query wording itself, plus `InterestProfile.json`'s `homeLocation`/`defaultRadiusMiles` (radius is a hard filter; distance is one signal among several the LLM weighs).
- **19hz SoCal listings (`19hz-socal`, enabled 2026-08-20):** the best SD electronic listing, via the deterministic `nineteenhz` fetch tier (`Tools/adapters/NineteenHzAdapter.ts`) — the rigidly-structured chronological table is parsed directly (no browser, no LLM; the old spa-tier LLM extraction chronically blew the prefetch budget). Parses both the dated tables (authoritative `YYYY/MM/DD` per row) and the recurring-weeklies table (plain "Mondays" and ordinal "2nd Saturdays" patterns dated to the next occurrence, tagged `recurring`), and filters the SoCal-wide page to San Diego-county cities before geocoding. A page-structure change throws loudly rather than reading as "no events this week".
- **EDMTrain (`edmtrain-sd`, api tier since 2026-08-23):** `Tools/adapters/EdmtrainAdapter.ts` pulls the official free API (`EDMTRAIN_API_KEY` in secrets.json; missing key throws loudly) — exact venue/lat-lng/lineup, no browser or LLM, and events arrive pre-geocoded so the Geocoder has nothing to enrich. Verified 2026-08-23: 135 listings → 130 persisted (5 beyond the 120-day horizon), vs ~74 from the old spa-tier scrape. The spa fallback story (tier-3 stealth defeats EDMTrain's Cloudflare wall) still holds if the API ever goes away.
- **San Diego Writers, Ink (5 `sdwritersink-*` sources, added 2026-08-24):** writeyourstorynow.org (SDWI, Liberty Station nonprofit — classes, workshops, readings, certificate cohorts, and recurring writing/critique groups) has NO events page, calendar plugin, ICS feed, or JSON-LD — offerings are WordPress custom-post-type detail pages enumerated only by per-CPT Yoast sitemaps, and the /all-programs/ listing pages omit the TIME/VENUE/PRICE blocks that live on the detail pages. Hence the generic `sitemap-llm` fetch tier (`Tools/adapters/SitemapLlmAdapter.ts`): source url = a LEAF sitemap; the adapter drops hub entries (Yoast lists the CPT archive alongside its children — extracting it duplicates every child with invented times), skips date-slugged pages older than a 7-day grace (slug date = series START), fetches each remaining page (concurrency 4, cap 60 — overflow logged loudly), slices `<main>` out of the Elementor nav/footer, and runs page-aligned ≤36KB batches through the shared LLM kernel (page-aligned because the kernel's own 40KB windows overlap — a page split across a boundary gets extracted twice, once degenerately). Block headers instruct the LLM to stamp each event's `ticketUrl` with its detail-page URL (the stripped text has no hrefs; without the nudge links come back empty or truncated). Live-verified 2026-08-24: groups 11, classes 34/34 pages with exact prices+times, readings 5, certificates 5 (+3 beyond horizon), critiques 9 — recurring groups ("Every Thursday", "Second Monday of Every Month") date to their next occurrence. Many SDWI offerings are `Zoom (Live)` — they don't geocode and are kept by the radius filter, surfacing as online events (platform-wide behavior). A second sitemap-only site reuses the tier as-is: one source entry per leaf sitemap. NOTE 2026-08-24: SDWI's WordPress nav carries injected spam pharmacy links ("Maribor Lekarna" etc. — site likely compromised); they sit outside `<main>` and never reach extraction.
- **Weekend digest (SPEC §8 — BUILT 2026-08-20):** `Tools/WeekendDigest.ts` runs Fridays 07:35 (`com.kaya.cron.eventscout-weekend-digest`, monitored run-cron-job family) — queries the cache for the upcoming Sat+Sun with a standing query (the const in that file is the only tuning lever), LLM-ranks normally, and spools one digest-tier AlertGate message (rides the morning digest, never pages; fingerprinted per weekend). EventScout is no longer pull-only.
- **`lastFetched` split out of committed config (2026-08-20):** `sources.json` is pure config; per-source freshness lives in the gitignored `State/source-state.json` (`{sourceId: ISO}`, env override `EVENTSCOUT_SOURCE_STATE_PATH`). `loadSources()` merges it in, so `list-sources`/UI/refresh-selection behavior is unchanged — and a manual `prefetch` no longer dirties the working tree.
- **Worktree live-state guard:** state-writing CLI commands run from a `.claude/worktrees/` checkout refuse to write the live tree's `State/` (or export outward) unless redirected (`KAYA_DIR`, `EVENTSCOUT_*_PATH`) or explicitly acked (`EVENTSCOUT_ALLOW_LIVE_STATE=1`) — the 2026-07-03 live-ledger corruption class is structurally blocked.
