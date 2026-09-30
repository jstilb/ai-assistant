# EventScout — Design Spec

> **Status:** Design complete (pre-build). Produced via `/grillme` on 2026-05-31.
> **Working name:** EventScout (rename freely).
> **Category:** Productivity (primary integration surface = LifeOS `activity_ideas`, CalendarAssistant, DailyBriefing).
> **One-liner:** Aggregate a curated, growing list of event/activity sources and recommend things to do that fit Jm's constraints.

---

## 1. Problem & Goal

Jm maintains a curated list of San Diego event/activity sources (`~/Desktop/obsidian/POS/Activities Sources.md`, ~26 URLs, updated over time). He wants to ask Kaya — in plain language, with constraints — and get **detailed, ranked recommendations** of upcoming events that fit.

This is a **discovery layer**, distinct from two things LifeOS already does:
- Logging a *past* activity with a rating → `activity_log` (exists).
- Saving a candidate to a wishlist → `activity_ideas` (exists).
- **Gap:** discovering *upcoming external* events. ← EventScout fills this.

---

## 2. Resolved Decisions (the grill)

| # | Branch | Decision | Rationale |
|---|--------|----------|-----------|
| 1 | Freshness | **Hybrid** — scheduled prefetch into a cache + live refresh of stale/high-value sources at query time | Events announced days–weeks out, so a cache is fresh enough and fast; live refresh covers "tonight" edge cases |
| 2 | Storage | **JSON cache** (`events-cache.json`, pruned each cycle) | Matches ContentAggregator + LifeOS patterns; no DB exists; trivially fast for ~1–5k ephemeral events |
| 3 | Extraction | **Generic-first, promote to adapters** | One pipeline covers all 26 day one; new source = a URL + hint; precise parsers added only where they earn it |
| 4 | Dedup | **Fuzzy match + merge richest** | Same show on Songkick/Bandsintown/venue collapses to one rich record; reuses existing Jaccard engine |
| 5 | Querying | **Smart defaults, clarify only if too broad** | Low friction on specific asks; won't dump 200 events on "anything fun?" |
| 6 | Ranking | **LLM rank vs editable interest profile** | Strong cold-start from hand-seeded profile + existing POS taste signal; explainable |
| 7 | Surface | **Pull-first, multi-surface (chat/Telegram/voice) + save-actions** | Matches "I ask it"; closes loop into `activity_ideas` + Calendar. Proactive digest deferred |
| 8 | Feedback | **Piggyback on `activity_log` + save/dismiss — but gated** | Collect signal now; **do NOT let it influence ranking until there's enough data to be confident (anti-overfit, Jm's explicit constraint)** |

---

## 3. Architecture / Data Flow

```
                    ┌─────────────────────────────────────────────┐
   launchd 1–2×/day │  PREFETCH PIPELINE                           │
   + on-demand ────▶│                                             │
                    │  sources.json                               │
                    │      │                                       │
                    │      ▼                                       │
                    │  [Fetch]  BrightData 4-tier  ──┐             │
                    │           RSS parser (shared)  ├─▶ raw       │
                    │           ICS parser (shared)  │             │
                    │           API clients (MLB/…)  ┘             │
                    │      │                                       │
                    │      ▼                                       │
                    │  [Extract] Inference.ts → EventItem[]        │
                    │            + geocode venues (venue→latlng)   │
                    │      │                                       │
                    │      ▼                                       │
                    │  [Dedup/Merge] date-bucket + Jaccard         │
                    │      │                                       │
                    │      ▼                                       │
                    │  events-cache.json  (prune past events)      │
                    └──────┬──────────────────────────────────────┘
                           │
   "anything fun this      ▼
    weekend near me?" ─▶ [Query] NL → ConstraintSet (LLM, smart defaults)
                           │       └─ live-refresh stale/high-value source if needed
                           ▼
                       [Filter] hard constraints (when/where/price/category)
                           ▼
                       [Rank] LLM vs InterestProfile.json + query vibe
                           ▼
                       [Surface] top 3–5 + why-it-fits + ticket link
                           │         + save→activity_ideas / add→Calendar
                           ▼
                       chat / Telegram / voice
                           ┊
                       [Feedback] activity_log ratings + saved/dismissed
                                   → InterestProfile (GATED on confidence)
```

---

## 4. Schemas

### 4.1 `EventItem`
```ts
interface EventItem {
  id: string;                 // stable hash: canonical(title) + startDate + venue
  title: string;
  startDatetime: string;      // ISO 8601, America/Los_Angeles
  endDatetime?: string;
  allDay: boolean;
  venue?: string;             // "The Observatory North Park"
  address?: string;
  lat?: number; lng?: number; // geocoded at ingest (venue→latlng cache)
  category: Category;         // controlled vocab (see below)
  tags: string[];             // freeform: "indie","jazz","21+","outdoor","family"
  isFree: boolean;
  priceMin?: number; priceMax?: number; currency?: string;
  ticketUrl?: string;
  sourceUrl: string;          // page it was extracted from
  sources: { sourceId: string; url: string }[];  // unioned on dedup-merge
  performersOrTeams?: string; // "Padres vs Dodgers" / "Tycho"
  description?: string;
  imageUrl?: string;
  fetchedAt: string;          // ISO
  status: "scheduled" | "cancelled" | "postponed";
}

type Category =
  | "music" | "comedy" | "theater" | "sports" | "arts"
  | "community" | "festival" | "talk" | "film" | "other";
```

### 4.2 `ConstraintSet` (parsed from NL)
```ts
interface ConstraintSet {
  when?:   { start: string; end: string };   // resolved date range; default = next 7 days
  timeOfDay?: ("morning"|"afternoon"|"evening"|"late")[];
  categories?: Category[];                    // default = any
  tags?: string[];                            // genre/keyword hints
  near?:   { lat: number; lng: number };      // default = home
  radiusMiles?: number;                       // default = configurable (e.g. 15)
  price?:  { mode: "free" | "under" | "any"; maxUsd?: number };  // default = any
  vibe?:   string;                            // "chill","energetic" → ranking signal
  who?:    "solo" | "date" | "group" | "family";  // ranking signal
  rawQuery: string;
}
```

### 4.3 `InterestProfile.json` (editable, hand-seeded)
```ts
interface InterestProfile {
  categoryWeights: Record<Category, number>;   // -1..+1
  genreLikes: string[];                         // "indie rock","jazz","standup"
  genreDislikes: string[];
  vibeNotes: string;                            // free text the ranker reads
  homeLocation: { lat: number; lng: number; label: string };
  defaultRadiusMiles: number;
  // --- feedback section (collected but gated; see §7) ---
  learned?: {
    confident: boolean;                         // flips true only past threshold
    sampleSize: number;
    derivedCategoryWeights?: Record<Category, number>;
    lastUpdated?: string;
  };
}
```

### 4.4 Sources registry (`sources.json`)
```ts
interface EventSource {
  id: string;
  url: string;
  name: string;
  fetchTier: "api" | "rss" | "ics" | "shopify" | "spa" | "html-llm";
  categoryHint?: Category;        // e.g. comedy clubs → "comedy"
  geoHint?: string;               // default neighborhood if events lack address
  pollInterval: number;           // minutes
  lastFetched?: string;
  highValue?: boolean;            // triggers hybrid live-refresh
  enabled: boolean;
}
```

---

## 5. The 26 Sources — Fetch-Tier Classification

> ⚠️ **Hypotheses to verify at build time.** I have *not* fetched these to confirm API/RSS/ICS availability — the generic `html-llm` pipeline is the guaranteed fallback for every source. Promote to a cheaper deterministic tier only after verifying the feed/endpoint exists.

| Source | Likely tier | Note |
|--------|-------------|------|
| `mlb.com/padres/schedule` | **api** | MLB StatsAPI `statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=135`. Clean, accurate. |
| `songkick.com/metro-areas/11086-us-san-diego` | **api** | Songkick API, metro 11086. Needs API key. |
| `bandsintown.com/?lat…` | **api** | Bandsintown API. Needs app_id. |
| `americancomedyco.com/collections/shows` | **shopify** | Try `/collections/shows/products.json`. |
| `sdpressclub.org/category/news-events` | **rss?** | WordPress → try `/feed/`. |
| `kpbs.org/events/all` | **rss? / html-llm** | Public media; check for feed. |
| `voiceofsandiego.org/events` | **rss? / html-llm** | WordPress likely. |
| `inewsource.org/events` | **rss? / html-llm** | WordPress likely. |
| `sandiegoreader.com/music`, `/events/bestbets` | **rss? / html-llm** | Check feed; else LLM. |
| `theshell.org/performances/rady-shell-calendar` | **spa / ics?** | Venue calendar — check for `.ics` export. |
| `sandiegofc.com/schedule` | **spa** | MLS schedule, JS-rendered. |
| `sandiegowavefc.com/single-match-tickets` | **spa** | NWSL. |
| `sandiegogulls.com/schedule-2/schedule` | **spa** | AHL hockey. |
| `balboapark.org/thisweekatbp` | **spa / html-llm** | (listed twice in source file — dedupe to one entry) |
| `sandiegotheatres.org/events` | **spa** | |
| `thecomedystore.com/la-jolla/calendar` | **spa** | |
| `micdropcomedysandiego.com/calendar` | **spa** | |
| `daylightsandiego.org/events-calendar` | **spa / ics?** | |
| `sandiego.org/events-festivals` | **spa / html-llm** | Tourism board. |
| `dosd.com` | **html-llm** | DiscoverSD. |
| `sandiegouniontribune.com/things-to-do` (+ `/music-concerts/`, `/tag/visual-arts/`) | **html-llm** | Possibly paywalled — flag at build. |

---

## 6. Reuse Map

| Need | Reuse | Path |
|------|-------|------|
| Cross-source dedup | `ContentDeduplicator` (Jaccard + URL canonicalization) | `skills/Content/ContentAggregator/Tools/ContentDeduplicator.ts` |
| HTTP + change detection | `CachedHTTPClient`, `StateManager` | `lib/core/CachedHTTPClient.ts`, `lib/core/StateManager.ts` |
| RSS/Atom parsing | `RSSParser` (regex-based, **exists**) | `skills/Content/ContentAggregator/Tools/RSSParser.ts` |
| Multi-tier fetch (HTML/SPA/protected) | BrightData 4-tier | `skills/Data/BrightData/Tools/BrightDataTool.ts` |
| Direct SPA scraping | `PlaywrightBrowser` | `skills/Development/Browser/index.ts` |
| LLM extract + rank + NL-parse | `Inference.ts` (`standard` tier) | `lib/core/Inference.ts` (NOT `tools/` — CLAUDE.md path is stale) |
| Save → wishlist / calendar | LifeOS Router (`activity_ideas`, `CALENDAR` label) | `skills/Productivity/LifeOS/Router.ts` |
| Surfaces | Telegram, VoiceInteraction, DailyBriefing | respective skills |

### New components to build
EventItem/ConstraintSet/InterestProfile schemas · events `sources.json` · **ICS parser** (none exists) · geocoder + venue→latlng cache · `ConstraintSet` parser · ranker · `EventScout` SKILL.md + CLI entrypoint · launchd plist · save-action wiring.
*(RSS parser already exists — reuse `ContentAggregator/Tools/RSSParser.ts`. Inference at `lib/core/Inference.ts`; StateManager + CachedHTTPClient at `lib/core/`.)*

---

## 7. Feedback Gating (Jm's anti-overfit constraint — HARD requirement)

The feedback loop **collects** signal continuously but must **not influence ranking** until confident:

- **Signals collected:** `activity_log` ratings (explicit), recommendations saved → `activity_ideas` (implicit positive), recommendations shown-but-ignored/dismissed (implicit negative).
- **Gate:** `InterestProfile.learned.confident` stays `false` until a minimum sample threshold is met (e.g. ≥ N rated outings overall AND ≥ M per category before that category's weight is auto-adjusted — exact N/M TBD). Until then, ranking uses only the hand-seeded profile + query vibe.
- **No silent drift:** when the gate flips, surface it to Jm ("I now have enough data to start tuning music recommendations to your ratings") rather than quietly changing behavior.
- Manual edits to `InterestProfile.json` always allowed and always win.

---

## 8. Deferred / Open (non-blocking for v1)

- **Proactive weekend digest** (Friday push to Telegram/briefing) — fast-follow once ranking quality is proven. **BUILT 2026-08-20**: `Tools/WeekendDigest.ts`, Friday 07:35 cron, digest-tier AlertGate spool (the eval suite holds the ranking-quality gate).
- **Learned-model threshold values** (N, M) — set after observing real data volume.
- **Geocoder vendor** — Nominatim (free) vs Google vs LLM. Venue cache makes calls rare; decide at build.
- **5-min taste interview** to seed `InterestProfile.json` (genres, vibe, home location, default radius).
- **Default radius / home location** config values.
- **Paywall handling** for U-T sources.

---

## 9. v1 Vertical Slice (recommended first build)

Prove the spine end-to-end on **3 representative sources**, one per hard tier:
1. **Padres** (`api`) — MLB StatsAPI, deterministic.
2. **KPBS or Press Club** (`rss`) — exercises the new RSS parser.
3. **One venue** (`spa`) — e.g. Rady Shell or The Comedy Store, exercises BrightData tier-3 + LLM extract.

Wire: `sources.json (3)` → fetch → extract → geocode → dedup → `events-cache.json` → NL query → filter → rank (hand-seeded profile) → chat shortlist.

**Then fan out:** add remaining sources tier-by-tier · add Telegram/voice surfaces · add save-actions · add launchd prefetch · add (gated) feedback collection · (later) proactive digest.

Slice vertically — one source through all layers, verify, repeat. Never all fetchers then all extractors.

---

## 10. Build Sequence (vertical slices)

1. Schemas + `sources.json` (3 seed sources) + cache read/write (StateManager).
2. Padres API adapter → EventItem → cache. *(Verify: real games appear.)*
3. RSS parser + one RSS source → cache + dedup. *(Verify: dedup merges nothing yet, no crash.)*
4. SPA source via BrightData + LLM extract → cache + dedup. *(Verify: cross-source merge of any overlap.)*
5. Geocoder + venue cache → lat/lng on events.
6. ConstraintSet NL parser + filter + deterministic chat output. *(Verify: "this weekend" returns correct date window.)*
7. Ranker + hand-seeded `InterestProfile.json` + "why it fits". *(Verify: ordering reflects profile.)*
8. SKILL.md + CLI entrypoint; hybrid live-refresh logic.
9. launchd prefetch plist (+ liveness watchdog per repo pattern).
10. Telegram/voice surfaces + save→activity_ideas / add→Calendar actions.
11. (Gated) feedback collection wiring.
12. (Deferred) proactive weekend digest.
```
```
