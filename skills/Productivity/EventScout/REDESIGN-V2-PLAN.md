# EventScout v2 — Redesign Plan

**Status:** ✅ BUILT & VERIFIED on branch `eventscout-v2` (2026-06-07) — all 8 slices implemented TDD, each independently verified by running real code; full suite 33/33 test files green; end-to-end query confirms cache-first + all-results LLM ranking + tiered output. Not yet committed/merged to `main`.
**Author:** Kaya · **Date:** 2026-06-07
**Grill source:** `/grillme` session 2026-06-07 (decisions locked below)

## Build log (slice → verification verdict)
1. Cache-first + refresh trigger — PASS (fixed a `--refresh` flag-parsing bug found in verification)
2. LLM-score-all rank engine — PASS (broad query returns 861/861; cap gone, proven at scale)
3. Fuller judge context + rubric — PASS (all 6 practical signals + rubric confirmed)
4. Tiered render — PASS (all boundary cases exact: 10-of-861, --limit 10/15/3)
5. Horizon knob + filter — PASS (day-119 kept / day-121 dropped; env guard)
6. Uncap feed/API adapters — PASS (live balboa-park: 264 across 6 pages vs old 200/4-cap)
7. Uncap SPA/html-llm — PASS (songkick 7 windows; eventbrite 20 pages/400 events, no truncation)
8. Prefetch concurrency + timeout — PASS (pool + double-fetch eliminated + 600s timeout)
- Final integration gate caught + fixed an out-of-scope regression: `feedback.test.ts` imported the deleted `scoreEvent` (obsolete per D2/D3; test removed).

## Known follow-ups (out of scope, observed during build)
- Near-duplicate events can co-occur in results (e.g. "Field of Dreamz Festival" vs "Slightly Stoopid Field of Dreamz Festival") — the old LLM-rerank had a dedup instruction; the new scoring engine doesn't dedup twins. `Dedup.ts` should ideally merge these at ingest. Candidate for a follow-up slice.
- Neighborhood derivation uses the first address comma-segment (often the street, not the neighborhood) — still useful context, but could map to real neighborhoods.
- `lastFetched`/`learned` still live in committed config (dirties the tree on prefetch/feedback) — candidate to move to `State/`.

---

## 1. Why

Jm's complaints + asks:

1. **"All results" returns only a few.** Root cause confirmed in code: Stage-1 trims to a 100-event `CANDIDATE_POOL_SIZE` (`Ranker.ts`), then the Stage-2 rerank LLM is told *"Omit events that clearly don't fit; do not pad to limit"* — so it actively curates down to a handful regardless of `--limit`.
2. **Deterministic scoring feels worse than LLM judgment.** Wants LLM judgment to drive ranking, with **more context** to make it useful.
3. **Scheduled fetch should pull & cache ALL results.**
4. **Queries should read from cache by default**, only refreshing live when explicitly asked.
5. **Each source should pull all its events** (no page-1-only / 4-window caps).

Current scale: **2,682 events cached** (~3 MB). Per-source caps that block "all": Apify `maxCrawlPages:1`, Evvnt 3×50, WordPress 4×50 (cap 200), ICS cap 300, and SPA/`html-llm` sources extracting only `LLM_MAX_CHUNKS=4` windows of **one page** unless they carry a `paginate` config (only `eventbrite-sd` does).

---

## 2. Decisions locked (from the grill)

| # | Decision | Choice |
|---|----------|--------|
| D1 | What "all results" returns | **Every event passing hard filters**, LLM-ranked best-first across the whole set, nothing omitted. |
| D2 | Rank engine | **LLM scores every event 0–100** (batched ~75/call) for the query; sort globally by score. Deterministic taste scoring **removed** (kept only as a tiebreaker). |
| D3 | Judge context | **Fuller event data** (un-truncated) + **a reusable query "intent brief"** + **explicit practical signals** (day-of-week, how-soon, distance, free/paid). **Taste/history stays OFF** ("query is everything" holds). |
| D4 | Cache-first trigger | Default = **pure cache read, zero live fetch**. Refresh fires on `--refresh` **flag OR** NL intent ("latest/update/refresh/right now"). `highValue` always-live **retired** → becomes a prefetch-priority hint. |
| D5 | Prefetch coverage | **All upcoming within a ~120-day horizon** (single tunable knob `EVENTSCOUT_HORIZON_DAYS`, default 120). Uncap per-adapter pagination/windows up to that horizon. |
| D6 | Default query window | **~14 days** when undated (sooner-biased) — bounds how much gets scored per query. Widen explicitly to go deeper. |
| D7 | Rendering | **Tiered** — top ~10 full cards w/ why-lines, remainder as compact one-liners. `--limit N` still trims. |
| D8 | Build approach | **Full plan doc first** (this doc), then build slice-by-slice (TDD) on approval. |

---

## 3. Architecture changes

### 3.1 Query path (`Query.ts`, `Ranker.ts`, `Render.ts`, `cli.ts`)

```
NL query
  │
  ├─ parseConstraints (unchanged; default window 14d)         [D6]
  │
  ├─ refresh? = --refresh flag OR wantsRefresh(nl)            [D4]  ← NEW
  │     ├─ yes → live-refresh category-relevant sources (existing pool), persist to cache
  │     └─ no  → skip live fetch entirely (pure cache read)   ← INVERTED DEFAULT
  │
  ├─ readEvents() → filterEvents (HARD filters only)          [D1]  ← pool cap deleted
  │
  ├─ RANK (new engine):                                       [D2][D3]
  │     1. buildIntentBrief(constraints)  → 1 LLM call, structured "what counts as a fit"
  │     2. scoreAllEvents(events, brief)  → batches of ~75, each 1 LLM call → {id, score 0-100, why}
  │        · runs batches through a bounded-concurrency pool
  │        · scoring line carries FULLER context + practical signals
  │        · system prompt carries an explicit 0–100 rubric (cross-batch calibration)
  │     3. sort desc by score; ties → sooner-first, then nearer-first
  │     · LLM-down fallback: order by soonness + fallbackWhy (no taste)
  │
  └─ renderTiered → top 10 full + rest compact                [D7]
```

**Removed:** `CANDIDATE_POOL_SIZE` (100) cap; deterministic taste scoring path in `scoreEvent` as a *ranking* driver; the "omit / don't pad" rerank prompt. **Kept:** haversine (now a practical signal + tiebreak), `EVENTSCOUT_DISABLE_RERANK` kill-switch (falls back to soonness order).

### 3.2 Ingest path (`Ingest.ts`, `adapters/*`, `sources.json`)

```
prefetch (scheduled) / refresh (on demand)
  │
  ├─ each adapter paginates/extracts UNTIL events pass now+HORIZON or listing ends   [D5]
  │     · SPA/html-llm: extend `paginate` + `maxLlmWindows` config to multi-page sources;
  │       page loop becomes horizon-aware (stop when a page is all past-horizon)
  │     · Apify maxCrawlPages 1 → config-driven; Evvnt/WordPress/ICS → horizon-driven loops
  │     · uniform post-adapter horizon filter (drop events > now+HORIZON)
  │
  ├─ dedupeAndMerge → enrichWithGeo → upsertEventsDeduped (unchanged)
  └─ prefetch runs sources with bounded concurrency (currently sequential)            ← NEW
```

`EventSource` already has `paginate { param, pages, start }` and `maxLlmWindows` — so SPA uncapping is largely **config + a horizon-aware stop condition**, not new plumbing.

---

## 4. Slice breakdown (TDD, vertical, sequenced)

Sequencing rationale: **query side first** (delivers the felt fix — "all results, LLM judgment, fast" — and is lower-risk, touching 4 files), **ingest side second** (sprawls across 11 adapters). Each slice = one test → one impl → verify.

### Phase 1 — Query side

- **Slice 1 — Cache-first + refresh trigger.**
  `wantsRefresh(nl)` pure detector + `--refresh` flag in `cmdQuery`; `queryHybrid` skips live fetch unless `refresh`. Retire `highValue` always-live from query path.
  *Tests:* undated query → 0 `ingestSource` calls; `--refresh` and `"latest …"` → refresh pool runs; highValue source NOT auto-fetched on a plain query.

- **Slice 2 — LLM-score-all rank engine.**
  `buildIntentBrief` + `scoreAllEvents` (batched, concurrent) + global sort + tiebreak. Delete pool cap; remove deterministic taste from ranking; LLM-down fallback → soonness order.
  *Tests:* every filtered event appears in output (nothing omitted); order tracks injected scores; ties break sooner-first; mocked-LLM-failure falls back deterministically; `EVENTSCOUT_DISABLE_RERANK=1` honored.

- **Slice 3 — Fuller judge context + calibration rubric.**
  Enrich the scoring line (longer description, neighborhood from `address`/source `geoHint`, source name, all tags, day-of-week, distance-from-home, free/paid); embed the 0–100 rubric + shared brief in every batch.
  *Tests:* scoring line contains the new fields; rubric/brief present in each batch prompt; batch size adapts so token budget holds.

- **Slice 4 — Tiered render.**
  `renderTiered`: top ~10 full cards + compact one-liners for the tail; `--limit` trims.
  *Tests:* 25-event input → 10 full + 15 compact; `--limit 5` → 5 full, no tail; 0 results → graceful message.

### Phase 2 — Ingest side

- **Slice 5 — Horizon knob + uniform horizon filter.**
  `EVENTSCOUT_HORIZON_DAYS` (default 120); post-adapter filter drops events past it.
  *Tests:* event at now+200d excluded; at now+100d kept; knob override respected.

- **Slice 6 — Uncap feed/API adapters (Evvnt, WordPress, ICS, Apify).**
  Horizon-driven pagination loops; remove fixed `MAX_PAGES`/`MAX_TOTAL`/`maxCrawlPages` ceilings (replace with horizon + empty-page stop + a generous safety bound).
  *Tests (mocked pages):* loop stops on empty page; stops when a page is all past-horizon; accumulates across pages.

- **Slice 7 — Uncap SPA/html-llm.**
  Add `paginate` + `maxLlmWindows` config to multi-page SPA sources in `sources.json`; make the page loop horizon-aware.
  *Tests:* multi-page SPA source fetches >1 page; window count honored; horizon stop fires.

- **Slice 8 — Prefetch concurrency + timeout tuning.**
  Run prefetch sources through a bounded-concurrency pool (currently sequential `for…await`); raise per-source timeout for multi-page sources; keep best-effort + per-source logging.
  *Tests:* all enabled sources attempted; one slow source doesn't serialize the rest; failures logged, not fatal.

---

## 5. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| **Cross-batch score miscalibration** (batch A's 80 ≠ batch B's 80) | Explicit 0–100 rubric + the *same* intent brief in every batch; tiebreak is deterministic. Revisit with a normalization pass only if observed. |
| **Per-query cost** (4–8+ LLM calls) | Cache-first keeps queries infrequent; 14-day default + `--limit` bound the scored set; batches run concurrently. |
| **Prefetch runtime/cost balloon** | 120-day horizon caps depth; concurrency pool; per-source timeouts; log every cap/drop (no silent truncation). |
| **Cache size / parse time** (~10 MB JSON per query) | Acceptable now (~100–200 ms). DuckDB/SQLite migration noted as future work, out of scope here. |
| **More extraction windows → more LLM extraction errors** | Existing `dedupeAndMerge` collapses cross-window/cross-page twins; per-source counts logged. |

---

## 6. Out of scope

- Re-enabling taste/history (D3 keeps it off).
- Voice/Telegram/Briefing render redesign — they call the core query and inherit the top picks; no surface-specific work here.
- DuckDB/SQLite cache migration.
- Proactive weekend digest (SPEC §8, still deferred).

---

## 7. Config knobs after v2

| Env / config | Default | Meaning |
|--------------|---------|---------|
| `EVENTSCOUT_HORIZON_DAYS` | 120 | Prefetch coverage horizon (D5). |
| `--refresh` flag / NL intent | off | Force live refresh at query time (D4). |
| `--limit N` | all | Trim the ranked output (D1/D7). |
| `EVENTSCOUT_REFRESH_CONCURRENCY` | 8 | Concurrent sources on refresh (existing). |
| `EVENTSCOUT_DISABLE_RERANK` | off | Kill-switch → soonness fallback (kept). |
| `EVENTSCOUT_USE_PROFILE_TASTE` | off | Re-enable taste (kept off per D3). |
| `paginate` / `maxLlmWindows` (per source) | — | Extended to more sources (D5, Slice 7). |
```
