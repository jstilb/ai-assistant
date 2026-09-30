# EventScout — Build Log

Orchestrated build of `SPEC.md`, slice by slice. Each slice: **acceptance criteria → build agent (TDD) → independent verify agent (LIVE run) → loop until verified → commit + push → docs updated.**

- **Branch:** `feat/eventscout`
- **Orchestrator:** Kaya (main loop). Build = Engineer agents. Verify = independent QATester/Engineer agents doing live runs, not just unit tests.
- **Verified paths:** `lib/core/Inference.ts`, `lib/core/StateManager.ts`, `lib/core/CachedHTTPClient.ts`, `ContentAggregator/Tools/{ContentDeduplicator,RSSParser,types}.ts`. Tests: standalone `bun tests/<file>.test.ts` (LifeOS convention, `_guard.ts`), never `bun test`.
- **Credentials available:** GEMINI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, APIFY_TOKEN. **Absent:** Songkick/Bandsintown/BrightData/geocoder keys → those use keyless paths (BrightData tiers 1-3, Nominatim).

Legend: ⬜ pending · 🔵 building · 🟡 verifying · ✅ verified+committed · ⏭️ deferred (per spec §8)

---

## Slice 1 — Foundation: schemas + sources.json(3) + cache  ✅
**AC:**
- `EventItem`, `ConstraintSet`, `InterestProfile`, `EventSource` schemas defined (Zod, ContentAggregator `types.ts` style); typecheck clean.
- `sources.json` seeded with exactly 3: Padres (`api`), one RSS source, one venue (`spa`).
- Cache module: write `EventItem[]` → `events-cache.json`, read back identical (round-trip).
- Prune drops events whose end (or start) < now; keeps future.
- TDD unit test (round-trip + prune) passes via `bun tests/*.test.ts`.
**Live verify:** write 1 past + 1 future event, prune, read → only future remains.
**Result:** ✅ VERIFIED by independent agent — lossless round-trip, correct prune, 3 schema-valid sources (api/rss/spa), all 23 EventItem fields present, typecheck clean. · **Commit:** _see git log_

## Slice 2 — Padres API adapter  ✅
**AC:** Adapter hits MLB StatsAPI (Padres teamId 135) for the upcoming window, maps games → EventItem (title "Padres vs X", correct PT datetime, venue, category=sports). Live run populates cache with real upcoming games.
**Live verify:** execute adapter; cache holds real future Padres games; spot-check 1–2 dates vs public schedule.
**Result:** ✅ VERIFIED — 39 real games cached; independent re-fetch confirmed UTC→PT conversion exact on 2 games (incl. midnight rollback); 16 unit tests; no Slice 1 regression. · **Commit:** _see git log_

## Slice 3 — RSS adapter + dedup integration  ✅
**AC:** RSS adapter (reuse `RSSParser.ts`) maps a real feed → EventItem; `ContentDeduplicator` Jaccard approach wired into Dedup.ts (title+venue combined key, threshold 0.5); Padres+RSS ingest = no crash, no false merges.
**Live verify:** RSS feed used = `https://sdpressclub.org/category/news-events/feed/` (SD Press Club WordPress feed, 5 items); padres-mlb: 39 events; sd-press-club: 5 events; merges=0 (correct — no overlapping events); NO false merges; all 44 events cached.
**New files:** `Tools/adapters/RSSAdapter.ts`, `Tools/Dedup.ts`, `Tools/Ingest.ts`, `tests/dedup.test.ts` (11 pass), `tests/rss.test.ts` (15 pass).
**Typecheck:** all new files clean; 1 pre-existing error in `lib/core/CachedHTTPClient.ts` (transitively surfaces via RSSParser CLI import — not introduced in Slice 3).
**Regressions:** cache.test.ts 3/3, padres.test.ts 16/16 — all green.
**Result:** ✅ VERIFIED (round 2). Round 1 FAILED — combined title+venue Jaccard@0.5 false-merged distinct same-venue/day events. Fix: title & venue compared as separate AND-gates (same-day AND venue-compatible AND title-similar). Round-2 independent verify confirmed BOTH directions clean — zero false merges (Mulaney/Chappelle, Jazz/Open-Mic, Latin/Salsa stay separate) AND no false negatives (Tycho containment, cross-source Padres dup, different-day guard all correct). 16 dedup tests; live ingest 44 events; no regressions. RSS feed: sdpressclub.org/.../feed/ (5 real items). · **Commit:** _see git log_

## Slice 4 — SPA fetch + LLM extract + cross-source dedup  ✅
**AC:** Venue SPA fetched via BrightData tier-3 (free Playwright); events extracted to EventItem[] via `lib/core/Inference.ts` against schema. Cross-source dups merge (sources[] unioned, richest kept).
**Live verify:** live extraction yields real dated events; demonstrate one merge.
**Result:** ✅ VERIFIED. SPAAdapter (BrightData fetch → `lib/core/Inference.ts` extract → `normalizeExtracted`) pulled 5 real Comedy Store shows live (tier-1 sufficed); cross-source merge confirmed. Hardened TZ: extracted naive datetimes now resolve as America/Los_Angeles (DST-correct: summer -07:00 / winter -08:00) via shared `Tools/lib/tz.ts` (Padres refactored onto it, 16/16 unchanged); `stableId` UTC-normalized. 44 SPA tests; all 5 suites green. · **Commit:** _see git log_

## Slice 5 — Geocoder + venue→latlng cache  ✅
**AC:** Venues geocoded via Nominatim (keyless) at ingest; venue cache prevents repeat lookups; events carry lat/lng where known.
**Live verify:** ingest populates lat/lng; second run hits cache (faster / no new call).
**New files:** `Tools/Geocoder.ts` (`geocodeVenue`, `enrichWithGeo`, `buildNominatimQuery`), `tests/geocoder.test.ts` (26 pass). `Tools/Ingest.ts` wired with geo-enrichment step (after dedup, before upsert).
**Live results:** Petco Park → lat:32.7071874, lng:-117.156913 (within 0.05° of expected); Comedy Store La Jolla → lat:32.8404492, lng:-117.2732938. Live ingest: 48 events, 23 enriched (21 cache-hits, 2 live), 20 null-cached (away-game stadiums correctly unresolvable against "San Diego, CA" default hint). Second pass: 0 live calls — pure cache. Negative results (away venues) cached as null to prevent re-querying.
**Regressions:** cache 3/3, padres 16/16, rss 15/15, dedup 16/16, spa 44/44 — all green.
**Result:** ✅ VERIFIED · **Commit:** _see git log_

## Slice 6 — NL ConstraintSet parser + filter + chat output  ✅
**AC:** NL → `ConstraintSet` via Inference w/ smart defaults (next 7d, home, any cat/price); hard filter on when/where(haversine radius)/price/category; clean markdown output.
**Live verify:** "free things this weekend" → only free events in the correct weekend window; date-specific query → correct window.
**New files:** `Tools/{ConstraintParser,Filter,Render,Query}.ts`, `tests/filter.test.ts` (36 pass), `tests/constraint-resolve.test.ts` (34 pass).
**Result:** ✅ VERIFIED. "this weekend" resolved exactly to upcoming Sat Jun 6–Sun Jun 7 (Mon-start week, today=Sun); free filter leaked zero non-free events; radius filter excluded all 25 null-coord away games, kept Petco home games; category/defaults/empty-edge all correct. LA-correct date/display via tz.ts. All regressions green.
**Known limitation:** "this month"/unrecognized relative terms fall back to the 7-day default (safe, no crash) — candidate for a later polish pass. · **Commit:** _see git log_

## Slice 7 — Ranker + InterestProfile + why-it-fits  ✅
**AC:** Hand-seeded `InterestProfile.json` (flagged for Jm to edit); LLM ranks filtered events vs profile + query vibe; top 3–5 each w/ one-line "why it fits"; `learned` section present but gated (`confident:false`).
**Live verify:** query ordering reflects profile (boost a category → it rises); explanations relevant.
**New files:** `InterestProfile.json` (neutral, committed config — EDIT-flagged), `Tools/{InterestProfile,Ranker}.ts`, `tests/{profile,ranker}.test.ts` (47 pass). Wired ranking into Query; home/radius now sourced from profile.
**Result:** ✅ VERIFIED. Neutral seed invents no tastes. Learned-gate proven a LIVE switch: scores byte-identical with confident=false (zero leak), flip only when confident=true. Profile influence reproduced (comedy-boost flips Padres→comedy ordering). Why-lines grounded/event-specific, not boilerplate. 190 regression tests green. · **Commit:** _see git log_

## Slice 8 — SKILL.md + CLI + hybrid live-refresh  ✅
**AC:** SKILL.md (frontmatter, USE WHEN, routing) per Kaya conventions; CLI `query` / `prefetch` / `add-source`; hybrid refreshes a stale-or-highValue relevant source live before answering.
**Live verify:** end-to-end `bun … query "…"` works; forced-stale source triggers observable live refresh.
**New files:** `SKILL.md`, `cli.ts`, `Tools/Hybrid.ts`, `Tools/SourceManager.ts`, `tests/hybrid.test.ts` (14 pass), `tests/cli.test.ts` (18 pass). `Tools/Query.ts` extended with `queryHybrid`.
**Hybrid proof:** comedy-store set stale (lastFetched 2026-01-01), comedy query → refreshed live (5 events, lastFetched updated). Padres (sports hint) + press-club (community hint) excluded by category filter — not refreshed. Cap (5) respected. `lastFetched` persisted to sources.json after refresh.
**Prefetch:** 39 Padres + 5 Press Club + 5 Comedy Store = 49 fetched, 1 dedup merge, 48 cache; all lastFetched updated.
**Typecheck:** no new errors in Slice 8 files (pre-existing TS5097 / lib/core errors unchanged).
**Regressions:** 153 tests across all 7 deterministic suites — all green.
**Result:** ✅ VERIFIED by independent agent — hybrid refresh fires on stale + category-relevant source, skips fresh/irrelevant, cap+selector correct (4/4), CLI surface works, SKILL.md valid (skill registered), 297 tests green, real sources.json isolation held.
**Design note:** `lastFetched` lives in committed `sources.json`, so prefetch (and the Slice-10 cron) will dirty it — acceptable for this repo's auto-commit model; candidate to move to `State/` in a later cleanup. · **Commit:** _see git log_

## Slice 9 — Expand source coverage to all ~26  ✅
**AC:** All `Activities Sources.md` URLs in `sources.json` with a `fetchTier`; full prefetch populates cache from a substantial set; failures logged with reason (no silent caps).
**Live verify:** full prefetch; per-source success/fail report; cache spans many sources.
**New files:** `Tools/adapters/JsonLd.ts` (deterministic schema.org Event extractor), `tests/jsonld.test.ts` (56 pass), `tests/ingest.test.ts` (31 pass). SPAAdapter gained a JSON-LD pre-pass + Playwright escalation.
**Result:** ✅ VERIFIED (round 2). All 26 unique sources registered + classified (1 api, 1 rss, 7 spa, 17 html-llm); 26/26 accounted for in prefetch (NO silent caps); no fabrication (Eventbrite + SD Theatres events independently confirmed live). Round 1 generic LLM-only = 8/26 sources / ~70 events. Round 2 added a deterministic JSON-LD pre-pass → **12/26 sources / 167 events** (+139%); unlocked Eventbrite (20), Meetup (51), SD Theatres (7), Voice of SD (3), Songkick (10). 356 tests green.
**Honest remaining coverage (14 sources, promotion backlog per SPEC §3):** (1) true JS-shell SPAs — bandsintown, sandiego.org, Gulls/SDFC/Wave — Playwright escalation is wired but BrightDataTool tier-3 falls back to curl in this sandbox (no browser binary), so they can't hydrate; need a real headless browser or per-site API. (2) Paywalled/obfuscated — U-T (×3), SD Reader (×2). (3) Sparse/no-JSON-LD civic — inewsource, daylight, kpbs, balboa-park. These are NOT silent caps — every one is reported with a reason. · **Commit:** _see git log_

## Slice 10 — launchd prefetch plist + watchdog  ✅
**AC:** Scheduled-prefetch plist (2×/day: 07:00 + 18:00) per `bin/rebuild-plists.sh` conventions; loads cleanly; manual kickstart runs prefetch; basic liveness guard.
**New files:**
- `bin/eventscout-prefetch.sh` — wrapper: PATH/env hardening, OAuth inject, runs `cli.ts prefetch`, inline guard (exists+fresh+count>0), exits non-zero on failure; never swallows errors.
- `~/Library/LaunchAgents/com.kaya.eventscout-prefetch.plist` — `StartCalendarInterval` 2×/day (07:00+18:00), StandardOut/Err to `~/.claude/logs/`, `RunAtLoad=false`.
- `Tools/PrefetchGuard.ts` — pure TS guard: `isPrefetchHealthy(cachePath, sinceMs, now)` → `{healthy, reason, eventCount, ageMs}`; tests all 3 conditions independently.
- `tests/prefetch-guard.test.ts` — 9 unit tests (missing/stale/empty/healthy/corrupt/no-shape/boundary/custom-window).
- `bin/rebuild-plists.sh` — added `com.kaya.eventscout-prefetch` block (count bumped 37→38).
**Live verify:** bootstrap → kickstart → 310s run → log showed 169 events, guard PASS → last exit code = 0 → bootout → "Could not find service" confirmed.
**Guard tests:** 9/9 passed. `plutil -lint`: OK. Typecheck: no new errors (TS5097 is pre-existing `.ts`-import pattern across all EventScout files).
**Regressions:** 365 tests across 14 suites — all green.
**Permanently install:** `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kaya.eventscout-prefetch.plist` (NOT auto-installed — Jm's call to enable the 2×/day job).
**Result:** ✅ VERIFIED by independent agent — SAFETY: no launchd job left installed (confirmed not-found); guard exits non-zero on stale/empty/missing cache (no silent green, empirically confirmed); plist lints, load/unload plumbing clean, registered in rebuild-plists.sh, regressions green. · **Commit:** _see git log_
**Result:** ✅ VERIFIED · **Commit:** _—_

## Slice 11 — Surfaces + save-actions  ✅
**AC:** Telegram/voice-renderable recs; "save" → `activity_ideas` (LifeOS Router); "add to calendar" → CALENDAR route.
**Live verify:** save a pick → row appears in `activity_ideas`; add to calendar → event created (then cleaned up); Telegram render to Jm's chat.
**New files:** `Tools/Surfaces.ts` (renderForTelegram/renderForVoice), `Tools/Actions.ts` (saveToIdeas/addToCalendar + deletes), `tests/{surfaces,actions}.test.ts` (42 + 51 pass). CLI: `save <id>`, `add-to-calendar <id>`.
**Result:** ✅ VERIFIED. Live save→present→delete→baseline-restored on real activity_ideas (uses LifeOS SheetsIO, avoids the kaya-cli append first-tab bug); live calendar create→present→delete→gone. Telegram render <length-cap with title/date/venue/link; voice render URL/markdown-free. Independent verifier caught + removed ONE stray `[EventScout TEST]` row the build agent left (cleanup incomplete) — sheet + calendar confirmed at baseline.
**Round 2 fix:** `addToCalendar` returned an event-id ref that `deleteCalendarEvent` couldn't consume (searched empty string → broken save/undo round-trip). Fixed: ref is now `title|when`, empty-search path removed, round-trip verified live (create→delete by returned ref→gone, baseline restored). 502→ all 17 suites green. · **Commit:** _see git log_

## Slice 12 — Gated feedback collection  ✅
**AC:** Collector records `activity_log` ratings + saved/dismissed; gate keeps `learned.confident:false` below threshold; ranking uses seed only until flip; gate-flip surfaces a notice (no silent drift).
**Live verify:** below-threshold → ranking unaffected, gate closed; threshold crossing → notice fires.
**New files:** `Tools/Feedback.ts` (collectSignals/computeLearned/updateProfileLearned/recordShown; MIN_SAMPLES_GLOBAL=10, MIN_SAMPLES_PER_CATEGORY=3), `tests/feedback.test.ts` (30 pass). CLI `feedback`; `recordShown` wired into both query paths; shown-log at `State/shown-log.jsonl`.
**Result:** ✅ VERIFIED — the anti-overfit gate is structurally enforced: sub-threshold `learned` has ZERO ranking influence (scores byte-equal to seed-only; weights activate only when confident=true); threshold crossing flips + emits a notice (no silent drift, no spurious re-notify); per-category min respected. Real `InterestProfile.json` left `confident:false, sampleSize:0` — no real data overfit. A round-1 build run dirtied the committed seed (sampleSize→1); reverted to pristine + hardened `profile.test.ts` test 5 to assert the gate invariant (confident:false) rather than the transient sampleSize. All 18 suites green (391 tests).
**Design note:** like `lastFetched`, `learned` is runtime-mutable state in committed config — a manual `cli.ts feedback` run will dirty the working tree; candidate to move to `State/` in a later cleanup. · **Commit:** _see git log_

## Proactive weekend digest  ⏭️ DEFERRED (spec §8) — out of scope for this build.

---

## FINAL — Orchestrator end-to-end self-verification  ✅
Kaya personally runs prefetch + several varied real queries; confirms correct, deduped, ranked, explained recommendations with working save/calendar; all docs accurate; PR opened.
**Result:** ✅ VERIFIED by orchestrator. Real cache: 169 events / 12 sources / all 6 categories (fresh). Live queries run via the CLI:
- "fun things to do this weekend" → correctly resolved Sat Jun 6–Sun Jun 7 + 15mi; 5 ranked picks across comedy/community/sports, each with a grounded why-line, correct PT times, venue, price, link.
- "comedy this weekend" → Troy Bond LIVE @ American Comedy Co (Sat 7 PM, $29+) — correct category + date filter.
- "live music in the next two weeks" → hybrid live-refresh of rady-shell fired, surfaced the Eagles tribute (Jun 12) — correct window + category.
All 18 test suites green (391 tests). Save→activity_ideas + add→calendar verified live with cleanup (Slice 11). Anti-overfit gate confirmed closed on real data (Slice 12).
**Polish fix during self-verify:** curl progress meters were leaking into CLI output (shared `BrightDataTool.ts` tier-2 lacked `-sS`) — fixed; output now clean. **Docs:** SKILL.md gained a Known Limitations & Coverage section. **Known limitations** (documented, non-blocking): 12/26 source coverage (promotion backlog), Monday-start relative-date edge cases, occasional imperfect LLM-extracted field, deferred proactive digest.
**Outcome:** EventScout is functional end-to-end and merged-ready on `feat/eventscout`.

---

## 2026-06-01 — Zero-Yield Source Remediation (orchestrated builder/verifier slices)  ✅ (6/8 sources fixed)
Investigation found ~half the 26-source registry yielding 0. Two systemic bugs fixed earlier this session (Eventbrite pagination 20→80; 40 KB LLM truncation, cache 169→394). This pass fixed the remaining zero sources, each verified live per-slice (events actually appear, cross-checked vs the source).

**Wins (cache-verified live):**
- **sd-reader-events** (Slice 1): `/events/` is JS-rendered (plan premise was wrong — 0 server events/JSON-LD). RE-DIAGNOSED → RSS feed `https://www.sandiegoreader.com/rss/events/` (50 items). `RSSAdapter` extended to parse the Reader's `When:`/`Where:`/`Cost:` description fields + strip title date-prefix (gated on `"When:"` so other feeds unaffected). **50 events.** sd-reader-music/-bestbets consolidated → sd-reader-events; bestbets disabled.
- **balboa-park** (Slice 3): new generic **`WordPressTecAdapter`** (`wp-tribe` fetchTier) hitting The Events Calendar REST API `/wp-json/tribe/events/v1/events`. **197 events.** Reusable for any WP+TEC site (one-line sources.json add).
- **daylight-sd** (Slice 4): new generic **`ICSAdapter`** (`ics` fetchTier, `node-ical`) on the embedded Google Calendar `basic.ics`. Bounded recurrence expansion (90-day horizon) + future-filter turns 1135 raw VEVENTs → **183 future events.** Added fetch retry (Google resets the ~1 MB feed connection intermittently). Reusable for any gcal/iCal source.
- **kpbs-events** (Slice 5): generalizable **`trimToContentStart`** in `SPAAdapter` — windows the LLM at the first event-dense offset. KPBS events live past byte ~183 KB (97% boilerplate page); the LLM saw only header before. Root-cause subtlety: the nav link `events/all` (304× near byte 0) outvoted the real `events/#/#` detail cluster — fixed by requiring a digit-collapsed `#` segment in the winning template. **0 → 23 events.** dosd/Eventbrite regression-clean (returned unchanged).
- **sd-gulls** (Slice 2): re-pointed `/schedule-2/schedule` → `/games`. Correctly yields **0 now** — AHL offseason, page literally says "No upcoming games scheduled at this time" (last game Apr 24; 2026-27 schedule unpublished). The "Upcoming Games" section is inside the LLM window, so it's a TRUE offseason zero, not a bug. Will auto-yield in-season.
- **InterestProfile** (Slice 7): `categoryWeights.sports` 0 → 0.4 and reconciled the contradictory vibeNotes ("deprioritize Padres/team games" → "Open to local sports … ranked on their own merits"). Verified: a sports query now ranks Padres vs Mets #1 (was auto-buried).

**inewsource-events — FIXED (Slice 6b, Jm-approved)**: events come from an **Evvnt** widget (`publisher_id 11515`). A minimal browser network-capture revealed the real no-auth GET endpoint `https://discovery.evvnt.com/api/publisher/11515/home_page_events?...` (I'd been probing the wrong host/path → all 401). New generic **`EvvntAdapter`** (`evvnt` fetchTier) maps `rawEvents` (title / `start_time` LA-offset ISO / venue / `category_name` / `links`→ticket). **Caught by the live probe, NOT the unit test:** the live API returns `links`/`original_links` as DICTs, `keywords`/`artists` as comma-strings, `images` as nested `{original:{url}}` — the builder's array-shaped fixtures passed while live threw "`{}` is not iterable". Hardened the helpers for both shapes + rewrote fixtures to mirror the real API. **0 → 142 events.** Reusable for any Evvnt-powered site.

**Still zero — JS-rendered/bot-blocked (surfaced to Jm; Jm: leave enabled + documented for auto-recovery):** → **BOTH RESOLVED 2026-06-02 via the new `apify` tier — see the "Apify tier" section below.**
- **sandiego-org-events**: Cloudflare-protected (403 to all non-browser fetches). Needs BrightData **tier-4** (no API key configured) or a Simpleview API key. → **FIXED: 20 events via Apify.**
- **bandsintown-sd**: React shell, 403 to bots, no public city/metro events API (only per-artist app_id API). Largely redundant with songkick-sd + dosd + sd-reader for SD live music. → **FIXED: 53 events via Apify.**
Root blocker for all three: the SPAAdapter's tier-3 "Playwright" escalation does not execute JS in this environment (returns the raw shell), and tier-4 (cloud browser / Cloudflare bypass) requires an absent BrightData key. (The `apify` tier below sidesteps both by rendering JS in Apify's cloud browser.)

**Verification:** all 21 EventScout test files green (incl. new `wordpress-tec.test.ts` 26, `ics.test.ts` 29, extended `rss.test.ts` 31, `pagination-chunk.test.ts` 31 with KPBS-nav-link regression case 4e). End-to-end queries surface the new venues (Balboa #1 on "this weekend"; Reader/Balboa/KPBS across "free things this week"; Padres #1 on a sports query). New fetchTiers `wp-tribe`+`ics` wired into `types.ts`+`Ingest.ts`.
**Known follow-ups (out of scope):** dedup misses title-variant near-dupes ("X at Y" vs "X @ Y", "[TUE]" suffixes); inewsource runs LLM extraction every prefetch for 0 events (consider disabling until the Evvnt adapter lands).

---

## 2026-06-02 — Apify fetch tier: rescue the two JS-rendered/bot-blocked sources  ✅ (both fixed, live-verified)
Goal: unblock the two sources that the BrightData tiers can't touch (sandiego.org Cloudflare, bandsintown React+403) for the **automated** launchd prefetch. Jm chose two paths: a BrightData key (Path A, interactive) AND a new Apify tier (Path B, automated). This section is Path B; Path A's verdict is at the bottom.

**Path A — BrightData key verdict (interactive-only, NOT usable by the prefetch):** Jm added `BRIGHTDATA_API_TOKEN` to `~/.claude/secrets.json` (confirmed present; value never printed). But **no Bright Data MCP server is configured** — `claude mcp list` shows only Gmail/Calendar/Drive/gemini/linkedin; `claude mcp get Brightdata`/`brightdata` → "No MCP server found"; the only `brightdata` mention in `~/.claude.json` is a `skillUsage` counter, not a server; and no `mcp__Brightdata__*` tool resolves in-session. `BrightDataTool.ts` tier-4 (lines ~249-271) is **MCP-only** — it hard-fails with "requires interactive Claude Code context. Run: mcp__Brightdata__scrape_as_markdown" and never makes a direct REST call with the token. **Net: the key alone unblocks nothing today.** To use it interactively Jm must `claude mcp add` a server **named exactly `Brightdata`** (so the tool resolves to `mcp__Brightdata__scrape_as_markdown`) and restart Claude Code. The automated prefetch can't use MCP at all → that's exactly why Path B (Apify) was needed.

**Path B — the `apify` tier (the automated fix):**
- New **`ApifyAdapter.ts`**: `buildCrawlerInput(url)` (PURE, unit-tested) → `loadApifyToken()` (reads `APIFY_TOKEN` from `~/.claude/secrets.json`, mirroring `lib/core/Inference.ts`; throws if absent — `APIFY_TOKEN` is NOT in the prefetch process env) → `fetchApifyEvents(source)` calls Apify's **`apify/website-content-crawler`** actor (`{timeout:200}`), reads the first dataset item's `.markdown`, and runs EventScout's **existing** extraction kernel on it.
- **DRY refactor**: the JSON-LD→LLM logic in `SPAAdapter.ts` was extracted into an exported `extractEventsFromContent(content, source)` (JSON-LD pre-pass → `extractViaLLM` with `trimToContentStart` + chunking). Both the html-llm fetch path and the Apify tier call it — single-sourced, so behavior is identical. `spa.test.ts` (44) + `pagination-chunk.test.ts` (31) stayed green.
- Wiring: `"apify"` added to `FetchTierSchema` (types.ts); `case "apify": return fetchApifyEvents(source)` in `Ingest.ts`. New `tests/apify.test.ts` (18 assertions, no network — tests only the pure `buildCrawlerInput`).

**Live verification (orchestrator, real end-to-end probes through `ingestSource`):**
- **Crawler-input tuning was required and caught by the live probe, NOT the unit test.** The first verified input (`startUrls`/`maxCrawlPages:1`/`crawlerType:"playwright:firefox"`/`saveMarkdown`/`proxyConfiguration`) bypassed Cloudflare on sandiego.org but rendered only the **filter sidebar** (category counts, 8.9 KB) → **0 events**, because the event grid hydrates via AJAX after load. Adding `dynamicContentWaitSecs:25` + `maxScrollHeightPixels:20000` surfaced the "This Weekend" carousel but only as image+date cards with **no titles**. Root cause: the actor's default `htmlTransformer:"readableText"` **strips the event-card title anchors** (title is a required field → every event dropped). Setting **`htmlTransformer:"none"`** preserved the full DOM (49 KB) with clean cards (`date / ### [Title](detail-url) / venue / region`). All three params are now baked into `buildCrawlerInput` and asserted in `apify.test.ts`.
- **sandiego-org-events: 0 → 20 events** (rendered 50 KB → 2 LLM windows). Cross-checked live: "Third World" @ Belly Up Jun 2, "The Human League"/"Mikaela Davis"/"Seahaven" Jun 2, "Little Italy Food Tour" — all match the rendered cards. (Minor: the source's `categoryHint:"festival"` makes concerts read as `festival`; pre-existing hint-fallback behavior, follow-up below.)
- **bandsintown-sd: 0 → 53 events** (rendered 77 KB → 3 windows; the dynamic-content wait let the React app hydrate past the initial 403). Cross-checked live: "Gumm at The Banshee Bar" Jun 2 7PM, "Mikaela Davis at Casbah" Jun 2 (consistent with sandiego), "Johnny Huynh at Voodoo Room @ House of Blues" — real venues, correct dates, real bandsintown `/e/` ticket URLs.
- `sources.json`: both flipped `html-llm` → `apify` (url + categoryHint unchanged).
- **Full suite: all 23 EventScout test files OK** (exit-code sweep).

**Operational notes for the prefetch:**
- **Cost**: `website-content-crawler` defaults to the full **8192 MB** actor memory (the free-tier ceiling). Two sources × 2 polls/day = ~4 runs/day at 8 GB for ~2-3 min each. Acceptable; if credits get tight, pin a lower `memory` in the `callActor` opts (untested — may slow/OOM the Firefox crawler, so left at default for now).
- **Concurrency**: because each run grabs all 8 GB, **two Apify runs cannot run in parallel on this plan** (a concurrent run errors "exceed the memory limit of 8192MB"). The production `ingestAllCore` loop is **sequential** (`await` per source), so the prefetch is unaffected — this only bit the orchestrator's parallel verification probes.

**Category fix (2026-06-02, follow-on):** sandiego's single `categoryHint:"festival"` was mislabelling its concerts/comedy. Root cause: the SPA/apify extraction prompt never asked the LLM for a category, so every event fell back to the source hint. Fixed by adding a `category` field (constrained to the `CategorySchema` enum, with per-type guidance) to `EXTRACTION_SYSTEM_PROMPT` and **dropping sandiego's `categoryHint`** (bandsintown keeps its `music` hint — correctly all-music). Live-verified: sandiego concerts (Third World, The Human League, Mikaela Davis, Seahaven, Jessica Baio) now classify as **music**; food tours / happy hours → **other** (no "food" category in the enum). All 23 test files stayed green (the prompt is additive; deterministic tests cover `normalizeExtracted`, not the prompt text).

**Known follow-ups (out of scope):** the `apify` tier has no JSON-LD short-circuit benefit on these two sites (neither emits `schema.org/Event`), so every poll runs the full LLM extraction.

---

## 2026-06-02 — `food` category added  ✅ (live-verified)
`CategorySchema` gained a **`food`** value (food tours, tastings, happy hours, restaurant/beer/wine events) — previously these landed in "other". Because `InterestProfileSchema.categoryWeights` is `z.record(CategorySchema, …)` and **that record is exhaustive** (verified empirically — a missing enum key fails parse), adding the enum value required touching every place that builds a full `categoryWeights` record:
- `types.ts`: `"food"` added to `CategorySchema` (before `"other"`).
- `InterestProfile.json`: `"food": 0.7` (Jm's seed `vibeNotes`/`genreLikes` already call out "food events" as something he's *especially drawn to*, so a positive weight matching `festival` is grounded, not invented).
- `ConstraintParser.ts`: added to the `categories` enum, the LLM prompt's category list, and a mapping hint (`food tour/tasting/happy hour/restaurant week/brunch/beer or wine → food`).
- `SPAAdapter.ts` `EXTRACTION_SYSTEM_PROMPT`: added `food` to the enum + guidance.
- `WordPressTecAdapter.ts`: `food` added to `VALID_CATEGORIES` + a `CATEGORY_MAP` pattern (`food|drink|culinary|dining|tasting`).
- Test fixtures (`profile.test.ts`, `ranker.test.ts`, `feedback.test.ts`): `food: 0` added to each `categoryWeights` literal (else the exhaustive record fails).
- `Ranker` needs no change — `effectiveCategoryWeights[event.category] ?? 0` already tolerates any category.

**Live-verified** (sandiego re-probe): "Tuesday Night Happy Hour", "Happy Hour at the Coop!", "Little Italy Food Tour" now classify as **food**; concerts stay **music**. All 23 test files green.
