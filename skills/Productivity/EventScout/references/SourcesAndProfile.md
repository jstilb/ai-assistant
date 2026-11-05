# EventScout: sources, InterestProfile, hybrid refresh

Moved out of `SKILL.md`. Read it when you add or edit a source, edit `InterestProfile.json`, or need the refresh rules.

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
