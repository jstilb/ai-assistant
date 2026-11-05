# EventScout: architecture and integration

Moved out of `SKILL.md`. Read it when you change the pipeline, the adapters or the integrations.

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
