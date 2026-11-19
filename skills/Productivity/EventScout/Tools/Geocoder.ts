/**
 * Geocoder.ts — Slice 5: venue→lat/lng via Nominatim (OpenStreetMap, keyless).
 *
 * Public API:
 *   buildGeoQueries(event) → GeoQuery[]
 *       Pure helper: the Nominatim queries to try, best first (street address,
 *       venue text, then — for text naming another region — its place part).
 *
 *   usableMatch(query, point) → boolean
 *       Pure helper: a match for a query whose San Diego region WE assumed
 *       must land in the San Diego area; a city-level query must land outside.
 *
 *   enrichWithGeo(events) → Promise<EventItem[]>
 *       For each event with a venue/address but missing lat/lng: try its
 *       queries (cache-first, 1-req/sec throttle on live calls) and stamp the
 *       first usable match. Events already having coords or lacking a venue
 *       and address are left unchanged. Logs an enrichment summary.
 *
 * Cache:
 *   Default: State/venue-cache.json (next to this file in the skill dir).
 *   Override: EVENTSCOUT_GEOCACHE_PATH env var (used in tests + live runs).
 *   Key: the lowercased query. Values are Nominatim's raw first match (or null
 *   for no match); usableMatch() decides per query whether a match stands.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSources } from "./SourceManager.ts";
import type { EventItem } from "./types.ts";

// ============================================================================
// Constants
// ============================================================================

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
// Nominatim's usage policy asks for an app-identifying User-Agent; a contact is
// optional, so no personal data goes out (F-006, 2026-11-18).
const USER_AGENT = "EventScout/1.0 (personal event finder)";
const DEFAULT_GEO_HINT = "San Diego, CA";

// Throttle state — minimum ms between live network calls
const MIN_REQUEST_GAP_MS = 1100; // slightly over 1 s to be safe
let lastRequestAt = 0;

// ============================================================================
// Cache path resolution
// ============================================================================

function getGeoCachePath(): string {
  if (process.env["EVENTSCOUT_GEOCACHE_PATH"]) {
    return process.env["EVENTSCOUT_GEOCACHE_PATH"];
  }
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, "../State/venue-cache.json");
}

// ============================================================================
// Cache I/O
// ============================================================================

type GeoCacheEntry = { lat: number; lng: number } | null;
type GeoCache = Record<string, GeoCacheEntry>;

function loadGeoCache(): GeoCache {
  const path = getGeoCachePath();
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8").trim();
  if (raw === "") return {};
  try {
    return JSON.parse(raw) as GeoCache;
  } catch {
    // corrupt cache file: start with an empty cache
    return {};
  }
}

function saveGeoCache(cache: GeoCache): void {
  const path = getGeoCachePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(cache, null, 2), "utf-8");
}

// ============================================================================
// Query builder (pure, exported for tests)
// ============================================================================

/** A street-address shape: a 2–6 digit number followed by a word (e.g. "143 S. Cedros"). */
const STREET_RE = /\b\d{2,6}\s+\S+/;
function hasStreetAddress(s: string): boolean {
  return STREET_RE.test(s);
}

/**
 * Slice a string so it STARTS at its street number. Nominatim resolves
 * "143 S. Cedros Avenue, Solana Beach" but fails when a venue name leads
 * ("Belly Up Tavern, 143 S. Cedros…"), so drop everything before the number.
 */
function fromStreetNumber(s: string): string {
  const m = s.match(STREET_RE);
  return m ? s.slice(s.indexOf(m[0])) : s;
}

/** Drop repeated comma-segments, keeping first occurrence ("601 Orange Ave,
 *  Coronado, CA, Coronado, CA" → "601 Orange Ave, Coronado, CA"). */
function dedupeAddressSegments(addr: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of addr.split(",")) {
    const p = raw.trim();
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.join(", ");
}

/** "Suite 101", "Ste. 1121", "#200", "Unit B", "Room 3": Nominatim misses addresses that keep them. */
const UNIT_RE = /\s*,?\s*(?:#\s*[\w-]+|\b(?:suite|ste|unit|apt|room|rm)\b\.?\s*#?\s*[\w-]+)/gi;

/** A comma segment that names a state or country: "CA", "NV 89109", "California", "Mexico", "USA". */
function isRegionSegment(segment: string): boolean {
  return (
    /^[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/.test(segment) ||
    /^(?:california|nevada|arizona|oregon|baja california|mexico|méxico|canada|usa|united states)$/i.test(segment)
  );
}

/** Segments split at commas and at " - " ("Queen Mary Waterfront - Long Beach, CA"). */
function segmentsOf(text: string): string[] {
  return text
    .split(/,|\s+-\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when the text itself names a state or country after its first segment. */
function namesRegion(text: string): boolean {
  return segmentsOf(text).slice(1).some(isRegionSegment);
}

/**
 * One Nominatim query. `assumed` = the San Diego region came from us, not from
 * the source text, so a match far from San Diego is a wrong place, not the
 * event's place. `placeOnly` = a city-level query, usable only to place an event
 * OUTSIDE the San Diego area (inside it, a city centre would fake a distance).
 */
export interface GeoQuery {
  q: string;
  assumed: boolean;
  placeOnly?: true;
}

function withRegion(text: string, suffix: string): GeoQuery {
  return namesRegion(text) ? { q: text, assumed: false } : { q: `${text}, ${suffix}`, assumed: true };
}

/**
 * The queries to try for an event, best first; the first usable match wins.
 *   1. event.address from its street number (units removed),
 *   2. a street number embedded in event.venue,
 *   3. the venue text, with ", San Diego, CA" only when it names no region,
 *      then the bare venue text ("San Diego Civic Theatre" resolves only bare),
 *   4. for text that names another region, its place part ("Long Beach, CA"),
 *   5. the source's geoHint when it is a street address: a single-venue
 *      source's own address ("Mic Drop Comedy" alone matches a club in Texas).
 * Nominatim resolves a street far more reliably than a bare venue name
 * ("Belly Up Tavern" fails; "143 S. Cedros Avenue, Solana Beach" resolves).
 * Returns [] when there is nothing geocodable. Exported for unit testing.
 */
export function buildGeoQueries(event: { venue?: string; address?: string }, sourceGeoHint?: string): GeoQuery[] {
  const out: GeoQuery[] = [];
  const add = (query: GeoQuery) => {
    if (!out.some((existing) => existing.q.toLowerCase() === query.q.toLowerCase())) out.push(query);
  };
  const address = event.address?.trim();
  const venue = event.venue?.trim();
  const street = (text: string) => dedupeAddressSegments(fromStreetNumber(text).replace(UNIT_RE, ""));
  if (address && hasStreetAddress(address)) add(withRegion(street(address), "CA"));
  if (venue && hasStreetAddress(venue)) add(withRegion(street(venue), DEFAULT_GEO_HINT));
  if (venue && !hasStreetAddress(venue)) {
    add(withRegion(venue, DEFAULT_GEO_HINT));
    // Region still assumed: usableMatch rejects a namesake outside the San Diego area.
    if (!namesRegion(venue)) add({ q: venue, assumed: true });
  }
  for (const text of [venue, address]) {
    if (!text || !namesRegion(text)) continue;
    // The place = the segment before the first region segment, to the end.
    const segments = segmentsOf(text);
    const firstRegion = segments.findIndex((segment, i) => i > 0 && isRegionSegment(segment));
    add({ q: segments.slice(firstRegion - 1).join(", "), assumed: false, placeOnly: true });
  }
  if (sourceGeoHint && hasStreetAddress(sourceGeoHint)) add(withRegion(street(sourceGeoHint), "CA"));
  return out;
}

/**
 * sourceId → geoHint, for sources whose hint is a street address. In
 * sources.json only single-venue sources carry one (clubs, studios, bars), so
 * it is the venue's own address (F-006, 2026-11-18).
 */
function streetGeoHints(): Map<string, string> {
  const hints = new Map<string, string>();
  try {
    for (const source of loadSources()) {
      if (source.geoHint && hasStreetAddress(source.geoHint)) hints.set(source.id, source.geoHint);
    }
  } catch (err) {
    console.warn(`[Geocoder] sources.json unreadable; no source addresses: ${(err as Error).message}`);
  }
  return hints;
}

// ============================================================================
// Nominatim response shape (minimal)
// ============================================================================

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
}

// ============================================================================
// Throttle helper
// ============================================================================

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (lastRequestAt > 0 && elapsed < MIN_REQUEST_GAP_MS) {
    const waitMs = MIN_REQUEST_GAP_MS - elapsed;
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }
  lastRequestAt = Date.now();
}

// ============================================================================
// Nominatim lookup (cache-first)
// ============================================================================

/** Downtown San Diego; the centre for the "is this match in the San Diego area" check. */
const SAN_DIEGO = { lat: 32.7157, lng: -117.1611 };
/** Beyond this, a match is outside the San Diego area (the county reaches ~60 mi). */
const SAN_DIEGO_AREA_MILES = 75;

function milesFromSanDiego(point: { lat: number; lng: number }): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const a =
    Math.sin(rad(point.lat - SAN_DIEGO.lat) / 2) ** 2 +
    Math.cos(rad(SAN_DIEGO.lat)) * Math.cos(rad(point.lat)) * Math.sin(rad(point.lng - SAN_DIEGO.lng) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(a));
}

/**
 * Whether a Nominatim match may stand for the event's place: a query whose
 * region we assumed must land in the San Diego area (else it matched a
 * namesake elsewhere); a city-level query must land outside it.
 */
export function usableMatch(query: GeoQuery, point: { lat: number; lng: number }): boolean {
  const inArea = milesFromSanDiego(point) <= SAN_DIEGO_AREA_MILES;
  if (query.placeOnly) return !inArea;
  return query.assumed ? inArea : true;
}

/**
 * Nominatim's first match for a query, backed by the local cache (keyed by
 * the lowercased query; misses are cached as null). Best-effort: returns null
 * on no match or network error, never throws; errors are not cached.
 */
async function geocodeQuery(query: string, cache: GeoCache): Promise<{ lat: number; lng: number } | null> {
  const normalizedKey = query.toLowerCase().trim();
  if (normalizedKey === "") return null;

  // --- Cache lookup ---
  if (Object.hasOwn(cache, normalizedKey)) {
    return cache[normalizedKey] ?? null;
  }

  // --- Live Nominatim call ---
  // Throttle to respect Nominatim's 1 req/sec policy
  await throttle();

  const encodedQ = encodeURIComponent(query);
  const url = `${NOMINATIM_URL}?q=${encodedQ}&format=json&limit=1`;

  let result: { lat: number; lng: number } | null = null;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en",
      },
    });

    if (!response.ok) {
      console.warn(`[Geocoder] Nominatim HTTP ${response.status} for "${query}"`);
      // Don't cache HTTP errors — may be transient
      return null;
    }

    const data = (await response.json()) as NominatimResult[];

    if (data.length > 0 && data[0]) {
      const lat = parseFloat(data[0].lat);
      const lng = parseFloat(data[0].lon);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        result = { lat, lng };
      }
    }
  } catch (err) {
    console.warn(`[Geocoder] Network error for "${query}": ${(err as Error).message}`);
    // Don't cache errors (may be monkeypatched test throw); return null
    return null;
  }

  // Cache result (including null for "no results" — valid negative). Re-read
  // the file first so a concurrent run's new keys are kept.
  cache[normalizedKey] = result;
  const updatedCache = loadGeoCache();
  updatedCache[normalizedKey] = result;
  saveGeoCache(updatedCache);

  return result;
}

// ============================================================================
// enrichWithGeo — batch enrichment for ingest pipeline
// ============================================================================

/**
 * For each event that has a venue but no lat/lng, geocode and stamp coordinates.
 * Events already having coords or lacking a venue are left unchanged.
 * Respects Nominatim's 1 req/sec throttle via the module throttle (geocodeQuery).
 * Best-effort: geocode failures leave the event unchanged (no throw).
 *
 * Logs a summary: n enriched / n cache-hits / n failed / n skipped.
 */
export async function enrichWithGeo(events: EventItem[]): Promise<EventItem[]> {
  let enriched = 0;
  let cacheHits = 0;
  let failed = 0;
  let rejected = 0;

  const cache = loadGeoCache();
  const sourceHints = streetGeoHints();
  const result: EventItem[] = [];
  // Progress at most once a minute: live lookups run at 1/s, and a silent
  // ~34-min geocode phase looked hung from outside (F-002, 2026-11-08).
  let lastProgressMs = Date.now();

  for (const event of events) {
    if (Date.now() - lastProgressMs >= 60_000) {
      lastProgressMs = Date.now();
      console.log(
        `[Geocoder] enrichWithGeo progress: ${result.length}/${events.length} events ` +
          `(${cacheHits} cache-hits, ${enriched} live, ${failed} failed/no-result)`,
      );
    }
    // Skip if already has coords
    if (event.lat !== undefined && event.lng !== undefined) {
      result.push(event);
      continue;
    }

    // Try the queries best-first (street address before bare venue name).
    const queries = buildGeoQueries(event, sourceHints.get(event.sources[0]?.sourceId ?? ""));
    if (queries.length === 0) {
      result.push(event);
      continue;
    }

    let placed: { lat: number; lng: number } | null = null;
    let fromCache = true;
    for (const query of queries) {
      fromCache &&= Object.hasOwn(cache, query.q.toLowerCase().trim());
      const coords = await geocodeQuery(query.q, cache);
      if (coords === null) continue;
      if (usableMatch(query, coords)) {
        placed = coords;
        break;
      }
      rejected++;
    }
    if (placed !== null) {
      result.push({ ...event, lat: placed.lat, lng: placed.lng });
      if (fromCache) cacheHits++;
      else enriched++;
    } else {
      result.push(event);
      failed++;
    }
  }

  const total = enriched + cacheHits;
  console.log(
    `[Geocoder] enrichWithGeo: ${total} enriched (${cacheHits} cache-hits, ${enriched} live), ${failed} failed/no-result, ` +
      `${rejected} match(es) rejected (namesake outside the San Diego area, or a city centre inside it)`,
  );

  return result;
}
