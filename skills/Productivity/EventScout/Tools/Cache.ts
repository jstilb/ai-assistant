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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { EventItemSchema, EventCacheSchema, DEFAULT_CACHE_PATH } from "./types.ts";
import type { EventItem, EventCache } from "./types.ts";
import { dedupeAndMerge } from "./Dedup.ts";
import { loadApiTierSourceIds } from "./SourceManager.ts";

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
 */
export function upsertEventsDeduped(incoming: EventItem[]): void {
  upsertEvents(incoming);
  writeEvents(dedupeAndMerge(readEvents(), loadApiTierSourceIds()));
}
