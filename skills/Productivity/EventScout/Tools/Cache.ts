/**
 * Cache.ts — EventScout events cache module.
 *
 * Persists EventItem[] to a JSON file. Round-trip is lossless (Zod-validated).
 *
 * Cache file location (in priority order):
 *   1. process.env.EVENTSCOUT_CACHE_PATH  — used in tests to scope to /tmp
 *   2. DEFAULT_CACHE_PATH (State/events-cache.json in this skill dir)
 *
 * Exposed API:
 *   writeEvents(items: EventItem[]): void
 *   readEvents(): EventItem[]
 *   pruneExpired(now?: Date): void
 *   upsertEvents(incoming: EventItem[]): void  — merge by id, richest wins
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EventItemSchema, EventCacheSchema, DEFAULT_CACHE_PATH } from "./types.ts";
import type { EventItem, EventCache } from "./types.ts";
import { calendarDay, dedupeAndMerge } from "./Dedup.ts";
import { loadSources } from "./SourceManager.ts";

// ============================================================================
// Internal helpers
// ============================================================================

function getCachePath(): string {
  return process.env["EVENTSCOUT_CACHE_PATH"] ?? DEFAULT_CACHE_PATH;
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadRaw(cachePath: string): EventCache {
  if (!existsSync(cachePath)) {
    return { events: [], lastUpdated: new Date().toISOString() };
  }
  const raw = readFileSync(cachePath, "utf-8").trim();
  if (raw === "") {
    return { events: [], lastUpdated: new Date().toISOString() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { events: [], lastUpdated: new Date().toISOString() };
  }
  const result = EventCacheSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Cache file corrupt: ${result.error.message}`);
  }
  return result.data;
}

function saveRaw(cache: EventCache, cachePath: string): void {
  ensureDir(cachePath);
  const validated = EventCacheSchema.parse(cache);
  writeFileSync(cachePath, JSON.stringify(validated, null, 2), "utf-8");
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Write (overwrite) the full events list to the cache.
 * Each item is validated against EventItemSchema before saving.
 */
export function writeEvents(items: EventItem[]): void {
  // Validate each item
  const validated = items.map((item, i) => {
    const result = EventItemSchema.safeParse(item);
    if (!result.success) {
      throw new Error(`Invalid EventItem at index ${i}: ${result.error.message}`);
    }
    return result.data;
  });

  const cache: EventCache = {
    events: validated,
    lastUpdated: new Date().toISOString(),
  };
  saveRaw(cache, getCachePath());
}

/**
 * Read all events from the cache. Returns [] if cache doesn't exist or is empty.
 */
export function readEvents(): EventItem[] {
  const cache = loadRaw(getCachePath());
  return cache.events;
}

/**
 * Prune events whose effective end time is in the past.
 *
 * Rule: use endDatetime if present, otherwise startDatetime.
 * An event is pruned when that datetime < now.
 * Future and ongoing events are kept.
 *
 * @param now - Reference time for "now" (defaults to current UTC time).
 */
export function pruneExpired(now: Date = new Date()): void {
  const cachePath = getCachePath();
  const cache = loadRaw(cachePath);

  const nowMs = now.getTime();

  const kept = cache.events.filter((event) => {
    const effectiveDateStr = event.endDatetime ?? event.startDatetime;
    const effectiveMs = new Date(effectiveDateStr).getTime();
    return effectiveMs >= nowMs;
  });

  const updated: EventCache = {
    events: kept,
    lastUpdated: new Date().toISOString(),
  };
  saveRaw(updated, cachePath);
}

/**
 * Upsert events into the cache by id — incoming wins when merging.
 *
 * Items with a matching id have their entry replaced; new items are appended.
 * This enables incremental adapter runs without full rewrites.
 */
export function upsertEvents(incoming: EventItem[]): void {
  const cachePath = getCachePath();
  const cache = loadRaw(cachePath);

  const incomingValidated = incoming.map((item, i) => {
    const result = EventItemSchema.safeParse(item);
    if (!result.success) {
      throw new Error(`Invalid EventItem at index ${i}: ${result.error.message}`);
    }
    return result.data;
  });

  // Build map of existing events by id
  const byId = new Map<string, EventItem>();
  for (const event of cache.events) {
    byId.set(event.id, event);
  }

  // Upsert incoming (incoming wins)
  for (const event of incomingValidated) {
    byId.set(event.id, event);
  }

  const updated: EventCache = {
    events: Array.from(byId.values()),
    lastUpdated: new Date().toISOString(),
  };
  saveRaw(updated, cachePath);
}

/**
 * Upsert incoming events, then collapse duplicates across the ENTIRE cache.
 *
 * `upsertEvents` merges only by `id`, so the same real-world event fetched from
 * two sources (distinct ids) — or from the same source across two batches —
 * accumulates as separate rows that never get compared. Each ingest path
 * previously deduped only its own batch, so cross-source/cross-batch twins
 * survived in the persisted cache. This re-runs the dedup engine over the full
 * cache after the upsert, so the catalog stays duplicate-free regardless of
 * which source or run a twin arrived in. Self-healing: a cache that already
 * holds accumulated twins is cleaned on the next ingest.
 *
 * api-tier sources (sources.json fetchTier === "api") are exempt from this
 * fuzzy re-dedup pass — see Dedup.ts's "api-tier exemption" note. Their
 * dedup already happened above via upsertEvents' exact-id upsert.
 *
 * Finally prunes expired events — the SPEC's "pruned each cycle". Every ingest
 * path (cron prefetch, UI refresh, CLI --refresh) lands here, so this is the
 * cycle boundary. Until 2026-10-04 nothing called pruneExpired, and the cache
 * grew to 32k events (86% past, 30 MB per /api/data). The grace window keeps
 * today's all-day / no-end-time events (effective end = startDatetime) visible
 * after the afternoon prefetch.
 */
export function upsertEventsDeduped(incoming: EventItem[]): void {
  const sources = loadSources();
  const apiTierSourceIds = new Set(sources.filter((s) => s.fetchTier === "api").map((s) => s.id));
  const icsSourceIds = new Set(sources.filter((s) => s.fetchTier === "ics").map((s) => s.id));

  // Superseded rows go BEFORE the id upsert and the whole-cache dedup: once a
  // stale row sits next to its fresh twin, dedupeAndMerge can merge them with
  // the stale time winning (2026-11-08: a weekly demonstration moved
  // 14:00 → 13:30 on its source; the table kept 14:00 on 5 future dates).
  const cached = readEvents();
  const superseded = supersededRowIds(cached, incoming, icsSourceIds);
  if (superseded.ids.size > 0) {
    writeEvents(cached.filter((e) => !superseded.ids.has(e.id)));
    console.log(
      `[cache] dropped ${superseded.ids.size} superseded row(s): ${superseded.sameDay} same-day (newest fetch wins), ` +
        `${superseded.leftFeed} left an ICS feed`,
    );
  }

  upsertEvents(incoming);
  writeEvents(dedupeAndMerge(readEvents(), apiTierSourceIds));
  pruneExpired(new Date(Date.now() - PRUNE_GRACE_MS));
}

const PRUNE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface SupersededRows {
  ids: Set<string>;
  /** Dropped by rule 1: the source re-listed the same title on the same LA day at another time. */
  sameDay: number;
  /** Dropped by rule 2: an ICS feed returned events through a later date, but not this one. */
  leftFeed: number;
}

/**
 * A row not seen for this long while its source re-lists the same title that
 * day is stale (Kaya's heuristic, 2026-11-08): a daily prefetch that misses one
 * session 7 runs in a row is not a chance miss.
 */
const STALE_ROW_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ICSAdapter's MAX_EVENTS_SAFETY: a feed that hits it is truncated in feed
 * order, so its latest start does not bound what it covered (rule 2 skips it).
 * tests/cache.test.ts pins this to the adapter's constant.
 */
export const ICS_FEED_CAP = 3000;

/** Lowercase letters and digits of any script — the same-source title match for rule 1. */
function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** "<sourceId>|<title>|<LA day>", or null when the title has no letters or digits. */
function sessionKey(sourceId: string, event: EventItem): string | null {
  const title = titleKey(event.title);
  return title === "" ? null : `${sourceId}|${title}|${calendarDay(event.startDatetime)}`;
}

function addStart(map: Map<string, Set<number>>, key: string, startMs: number): void {
  let starts = map.get(key);
  if (!starts) {
    starts = new Set<number>();
    map.set(key, starts);
  }
  starts.add(startMs);
}

/**
 * Cached rows that this run's fetch makes stale (pure; no I/O).
 *
 * A cached row is a candidate only when ONE source lists it, it starts after
 * `now`, and this run did not return its id. Rows of a source that failed or
 * returned 0 events never qualify (the source is absent from `incoming`), and a
 * row another source also lists keeps that source's independent evidence.
 *
 * Rule 1 (every source) — the session moved: the row's source re-listed the
 * same title on the same LA day this run, AND either it lists at least as many
 * start times that day as the cache holds (a moved time keeps the count), or
 * the row was last fetched ≥ 7 days ago. A scraped source that returns only one
 * of two real sessions (fewer times than the cache holds) keeps the other row.
 *
 * Rule 2 (ICS feeds only) — the event left the feed: the source returned events
 * through a date at or after this row's start, but not this row. A calendar
 * feed lists every event, so absence means cancelled or moved. Not applied to
 * LLM/scrape tiers: their runs miss events by chance (2026-11-08 live cache:
 * eventbrite-sd alone had 328 future rows its latest run did not return).
 */
export function supersededRowIds(
  cached: readonly EventItem[],
  incoming: readonly EventItem[],
  icsSourceIds: ReadonlySet<string>,
  now: Date = new Date(),
): SupersededRows {
  const incomingIds = new Set<string>();
  const freshStarts = new Map<string, Set<number>>();
  const incomingCount = new Map<string, number>();
  const icsLatestStartMs = new Map<string, number>();

  for (const event of incoming) {
    incomingIds.add(event.id);
    const startMs = new Date(event.startDatetime).getTime();
    for (const sourceId of new Set(event.sources.map((s) => s.sourceId))) {
      incomingCount.set(sourceId, (incomingCount.get(sourceId) ?? 0) + 1);
      if (!Number.isFinite(startMs)) continue;
      const key = sessionKey(sourceId, event);
      if (key !== null) addStart(freshStarts, key, startMs);
      if (icsSourceIds.has(sourceId)) {
        icsLatestStartMs.set(sourceId, Math.max(icsLatestStartMs.get(sourceId) ?? -Infinity, startMs));
      }
    }
  }

  // Start times the cache holds per session key (only keys this run re-listed).
  const cachedStarts = new Map<string, Set<number>>();
  for (const row of cached) {
    const startMs = new Date(row.startDatetime).getTime();
    if (!Number.isFinite(startMs)) continue;
    for (const sourceId of new Set(row.sources.map((s) => s.sourceId))) {
      const key = sessionKey(sourceId, row);
      if (key !== null && freshStarts.has(key)) addStart(cachedStarts, key, startMs);
    }
  }

  const result: SupersededRows = { ids: new Set<string>(), sameDay: 0, leftFeed: 0 };
  const nowMs = now.getTime();

  for (const row of cached) {
    if (incomingIds.has(row.id)) continue;
    const rowSourceIds = new Set(row.sources.map((s) => s.sourceId));
    if (rowSourceIds.size !== 1) continue;
    const [sourceId] = rowSourceIds;
    if (sourceId === undefined) continue;
    const startMs = new Date(row.startDatetime).getTime();
    if (!Number.isFinite(startMs) || startMs <= nowMs) continue;
    const returned = incomingCount.get(sourceId) ?? 0;
    if (returned === 0) continue; // the source failed or returned nothing this run

    const key = sessionKey(sourceId, row);
    const fresh = key === null ? undefined : freshStarts.get(key);
    if (key !== null && fresh) {
      const held = cachedStarts.get(key)?.size ?? 0;
      const fetchedMs = new Date(row.fetchedAt).getTime();
      const old = Number.isFinite(fetchedMs) && nowMs - fetchedMs >= STALE_ROW_AGE_MS;
      if (fresh.size >= held || old) {
        result.ids.add(row.id);
        result.sameDay++;
        continue;
      }
    }

    const latestMs = icsLatestStartMs.get(sourceId);
    if (latestMs !== undefined && returned < ICS_FEED_CAP && startMs <= latestMs) {
      result.ids.add(row.id);
      result.leftFeed++;
    }
  }

  return result;
}
