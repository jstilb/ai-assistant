/**
 * types.ts — Zod schemas + inferred TypeScript types for EventScout.
 *
 * Schemas defined per SPEC §4. Both schema and inferred type are exported
 * for each entity.
 */

import { z } from "zod";

// ============================================================================
// Category
// ============================================================================

export const CategorySchema = z.enum([
  "music",
  "comedy",
  "theater",
  "sports",
  "arts",
  "community",
  "festival",
  "talk",
  "film",
  "food",
  "other",
]);
export type Category = z.infer<typeof CategorySchema>;

// ============================================================================
// EventItem (SPEC §4.1)
// ============================================================================

export const EventItemSchema = z.object({
  /** Stable hash: canonical(title) + startDate + venue */
  id: z.string(),
  title: z.string(),
  /** ISO 8601, America/Los_Angeles */
  startDatetime: z.string(),
  endDatetime: z.string().optional(),
  allDay: z.boolean(),
  /** e.g. "The Observatory North Park" */
  venue: z.string().optional(),
  address: z.string().optional(),
  /** Geocoded at ingest */
  lat: z.number().optional(),
  lng: z.number().optional(),
  /** Controlled vocabulary */
  category: CategorySchema,
  /** Freeform: "indie", "jazz", "21+", "outdoor", "family" */
  tags: z.array(z.string()),
  isFree: z.boolean(),
  priceMin: z.number().optional(),
  priceMax: z.number().optional(),
  currency: z.string().optional(),
  ticketUrl: z.string().optional(),
  /** Page it was extracted from */
  sourceUrl: z.string(),
  /** Unioned on dedup-merge */
  sources: z.array(
    z.object({
      sourceId: z.string(),
      url: z.string(),
    })
  ),
  /** "Padres vs Dodgers" / "Tycho" */
  performersOrTeams: z.string().optional(),
  description: z.string().optional(),
  imageUrl: z.string().optional(),
  /** ISO timestamp of when this record was fetched */
  fetchedAt: z.string(),
  status: z.enum(["scheduled", "cancelled", "postponed"]),
});
export type EventItem = z.infer<typeof EventItemSchema>;

// ============================================================================
// ConstraintSet (SPEC §4.2)
// ============================================================================

export const TimeOfDaySchema = z.enum(["morning", "afternoon", "evening", "late"]);
export type TimeOfDay = z.infer<typeof TimeOfDaySchema>;

export const ConstraintSetSchema = z.object({
  /** Resolved date range; default = next 7 days */
  when: z
    .object({ start: z.string(), end: z.string() })
    .optional(),
  timeOfDay: z.array(TimeOfDaySchema).optional(),
  /** Default = any */
  categories: z.array(CategorySchema).optional(),
  /**
   * True only when the user named a category/genre directly ("comedy shows",
   * "Padres game"). False/absent when the category was INFERRED from a vibe or
   * goal ("meet people" → community). Explicit categories are a hard filter;
   * inferred categories are a soft ranking signal only (so a "meet people" query
   * still surfaces a salsa night or a comedy show, not just `community`).
   */
  categoriesExplicit: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  /** Default = home */
  near: z.object({ lat: z.number(), lng: z.number() }).optional(),
  /** Default = configurable (e.g. 15) */
  radiusMiles: z.number().optional(),
  /** Default = any */
  price: z
    .object({
      mode: z.enum(["free", "under", "any"]),
      maxUsd: z.number().optional(),
    })
    .optional(),
  /** Ranking signal */
  vibe: z.string().optional(),
  /** Ranking signal */
  who: z.enum(["solo", "date", "group", "family"]).optional(),
  rawQuery: z.string(),
});
export type ConstraintSet = z.infer<typeof ConstraintSetSchema>;

// ============================================================================
// QueryContext (markdown-first de-determinization, 2026-07)
// ============================================================================

/**
 * Structured, agent-resolved query intake. Replaces ConstraintSet as the
 * shape consumed by the query pipeline (Filter → Ranker → Render): the
 * CALLING AGENT resolves all natural-language interpretation (dates, refresh
 * intent, price mode, explicit-vs-inferred category) by reading SKILL.md and
 * passing structured CLI flags. This schema is the thin, LOUDLY-validated
 * contract for what survives that resolution — code no longer guesses.
 *
 * `rawQuery` still flows to Ranker.ts verbatim so semantic nuance ("near
 * Balboa Park", "meet people to date") still reaches LLM judgment; only the
 * date/price/category axes below are pulled out as structured hard filters.
 *
 * `window`, `home`, and `radiusMiles` are always resolved by the caller
 * (cli.ts defaults `window` to the next 14 days and `home`/`radiusMiles` from
 * InterestProfile.json) — never left undefined here.
 */
export const QueryContextSchema = z.object({
  rawQuery: z.string(),
  window: z.object({ start: z.string(), end: z.string() }),
  /** Hard filter: only isFree===true events. Mutually exclusive with maxPrice
   *  by SKILL.md convention (not enforced here — both may be AND-combined). */
  free: z.boolean().optional(),
  /** Hard filter: isFree OR (priceMin ?? priceMax) <= maxPrice. */
  maxPrice: z.number().optional(),
  /** Hard filter iff present — the agent has already decided this is explicit. */
  categories: z.array(CategorySchema).optional(),
  timeOfDay: z.array(TimeOfDaySchema).optional(),
  home: z.object({ lat: z.number(), lng: z.number() }),
  radiusMiles: z.number(),
});
export type QueryContext = z.infer<typeof QueryContextSchema>;

// ============================================================================
// InterestProfile (markdown-first de-determinization, Slice 4 2026-07)
// ============================================================================

/**
 * Just home/radius — the only two fields any code reads. The former
 * hand-seeded taste fields and the gated feedback-learning section were
 * deleted in Slice 4: Ranker.ts never read them (ranking is pure LLM scoring
 * against the raw query text — "query is everything", see SKILL.md's Ranking
 * section), and the module that wrote the learning section had zero
 * consumers of its output.
 */
export const InterestProfileSchema = z.object({
  homeLocation: z.object({
    lat: z.number(),
    lng: z.number(),
    label: z.string(),
  }),
  defaultRadiusMiles: z.number(),
});
export type InterestProfile = z.infer<typeof InterestProfileSchema>;

// ============================================================================
// EventSource (SPEC §4.4)
// ============================================================================

export const FetchTierSchema = z.enum([
  "api",
  "rss",
  "ics",
  "shopify",
  "spa",
  "html-llm",
  "wp-tribe",
  "evvnt",
  "apify",
  "pike13",
  "ctycms",
  "activenet",
  "dancestudio-pro",
  "nineteenhz",
  "sitemap-llm",
]);
export type FetchTier = z.infer<typeof FetchTierSchema>;

export const EventSourceSchema = z.object({
  id: z.string(),
  url: z.string(),
  name: z.string(),
  fetchTier: FetchTierSchema,
  categoryHint: CategorySchema.optional(),
  /** Default neighborhood if events lack address */
  geoHint: z.string().optional(),
  /** Minutes */
  pollInterval: z.number(),
  lastFetched: z.string().optional(),
  /** Prefetch-priority hint only — does NOT force query-time refresh (RefreshIntent.ts ignores it). */
  highValue: z.boolean().optional(),
  /**
   * Override for the number of LLM extraction windows (chunks) the SPA/html-llm
   * adapter scans. Defaults to LLM_MAX_CHUNKS (4). Raise for content-dense pages
   * whose listing exceeds ~150KB (e.g. kpbs-events at 782KB) so events past the
   * first 4 windows aren't silently dropped. Costs one inference call per window.
   */
  maxLlmWindows: z.number().int().positive().optional(),
  /**
   * Optional pagination spec for listing pages that return one page of results
   * at a time (e.g. Eventbrite's ?page=N). When set, the adapter fetches pages
   * `start .. start+pages-1`, accumulates, and dedups. Stops early on an empty
   * page. Omit for sources that render all events on a single URL.
   */
  paginate: z
    .object({
      /** Query-string param that selects the page, e.g. "page". */
      param: z.string(),
      /** Number of pages to fetch (including the first). */
      pages: z.number().int().positive(),
      /** First page index (default 1). */
      start: z.number().int().optional(),
    })
    .optional(),
  /**
   * Route this source's fetch through the Bright Data Web Unlocker REST API
   * (residential proxy + bot-wall bypass) instead of a plain datacenter fetch.
   * Set for feeds behind a WAF that returns 403/406 to datacenter IPs — e.g.
   * Songkick's per-user `/users/<name>/calendars.ics` feed, which 406s to
   * curl/fetch but resolves through the unlocker. Currently honored by the
   * `ics` tier (ICSAdapter); costs one Bright Data request per fetch.
   */
  unblock: z.boolean().optional(),
  enabled: z.boolean(),
});
export type EventSource = z.infer<typeof EventSourceSchema>;

// ============================================================================
// Cache store shape (used internally by Cache.ts)
// ============================================================================

export const EventCacheSchema = z.object({
  events: z.array(EventItemSchema),
  lastUpdated: z.string(),
});
export type EventCache = z.infer<typeof EventCacheSchema>;

// ============================================================================
// Saved-events store shape (used by SavedEvents.ts)
// ============================================================================

/**
 * A saved ("interested") event. Snapshots the FULL EventItem — not just the
 * id — because the cache is regenerated on every prefetch and prunes past
 * events: a saved pick must stay viewable after it rotates out of the cache.
 * Readers prefer the fresh cache copy when one still exists.
 */
export const SavedEventEntrySchema = z.object({
  /** ISO timestamp of when Jm saved it. Preserved across re-saves. */
  savedAt: z.string(),
  event: EventItemSchema,
});
export type SavedEventEntry = z.infer<typeof SavedEventEntrySchema>;

export const SavedEventsStoreSchema = z.object({
  saved: z.array(SavedEventEntrySchema),
});
export type SavedEventsStore = z.infer<typeof SavedEventsStoreSchema>;

// ============================================================================
// Constants
// ============================================================================

export const KAYA_HOME = process.env["KAYA_DIR"] ?? `${process.env["HOME"]}/.claude`;
export const DEFAULT_CACHE_PATH = `${KAYA_HOME}/skills/Productivity/EventScout/State/events-cache.json`;
export const DEFAULT_SAVED_PATH = `${KAYA_HOME}/skills/Productivity/EventScout/State/saved-events.json`;
/** Per-source runtime freshness ({sourceId: lastFetched ISO}) — kept OUT of committed sources.json. */
export const DEFAULT_SOURCE_STATE_PATH = `${KAYA_HOME}/skills/Productivity/EventScout/State/source-state.json`;
