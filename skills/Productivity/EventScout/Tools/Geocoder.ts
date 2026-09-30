/**
 * Geocoder.ts — Slice 5: venue→lat/lng via Nominatim (OpenStreetMap, keyless).
 *
 * Public API:
 *   buildNominatimQuery(venue, hint?) → string
 *       Pure helper: returns the query string (venue + ", " + hint).
 *
 *   geocodeVenue(venue, hint?) → Promise<{lat,lng} | null>
 *       Cache-first: checks venue-cache.json for a stored result.
 *       On miss: calls Nominatim, caches the result (even null), returns it.
 *       Best-effort: on network error → returns null, does NOT throw.
 *       Throttle: the caller (enrichWithGeo) enforces ≥1 req/sec between
 *       live calls; geocodeVenue itself is not throttled so tests can call
 *       it freely without timing waits.
 *
 *   enrichWithGeo(events) → Promise<EventItem[]>
 *       For each event with venue but missing lat/lng: geocode (cache-first,
 *       1-req/sec throttle on live calls) and stamp lat/lng when found.
 *       Events already having coords or lacking a venue are left unchanged.
 *       Logs an enrichment summary when complete.
 *
 * Cache:
 *   Default: State/venue-cache.json (next to this file in the skill dir).
 *   Override: EVENTSCOUT_GEOCACHE_PATH env var (used in tests + live runs).
 *   Key: normalized "<venue>, <hint>" (or "<venue>, San Diego, CA").
 *   Negative results (no match) are cached as null.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import type { EventItem } from "./types.ts";

// ============================================================================
// Constants
// ============================================================================

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "EventScout/1.0 (Kaya personal assistant; [user-email])";
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

/**
 * Build the Nominatim query string from venue + hint.
 * Returns a plain (non-URL-encoded) string; callers encode it into the URL.
 */
export function buildNominatimQuery(venue: string, hint: string | undefined): string {
  return `${venue}, ${hint ?? DEFAULT_GEO_HINT}`;
}

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

/**
 * Pick the most geocodable query string for an event. Nominatim resolves a
 * street address far more reliably than a bare venue name ("Belly Up Tavern"
 * fails; "143 S. Cedros Avenue, Solana Beach" resolves), so prefer:
 *   1. event.address, if it contains a street number,
 *   2. event.venue, if IT embeds a street number,
 *   3. venue + "San Diego, CA" hint (legacy behavior; often the failing case).
 * Returns "" when there is nothing geocodable (no venue and no address).
 * Exported for unit testing.
 */
export function buildGeoQuery(event: { venue?: string; address?: string }): string {
  const addr = event.address?.trim();
  if (addr && hasStreetAddress(addr)) {
    let q = dedupeAddressSegments(fromStreetNumber(addr));
    if (!/\b(CA|California)\b/i.test(q)) q += ", CA";
    return q;
  }
  const venue = event.venue?.trim();
  if (venue && hasStreetAddress(venue)) {
    let q = dedupeAddressSegments(fromStreetNumber(venue));
    if (!/\b(CA|California)\b/i.test(q)) q += ", San Diego, CA";
    return q;
  }
  return venue ? buildNominatimQuery(venue, undefined) : "";
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
// geocodeVenue — main export
// ============================================================================

/**
 * Geocode a venue via Nominatim (keyless), backed by a local cache.
 *
 * @param venue - Venue name, e.g. "Petco Park".
 * @param hint  - Geographic hint, e.g. "San Diego, CA". Defaults to "San Diego, CA".
 * @returns { lat, lng } on success; null if unresolvable or on network error.
 */
export async function geocodeVenue(
  venue: string,
  hint?: string
): Promise<{ lat: number; lng: number } | null> {
  return geocodeQuery(buildNominatimQuery(venue, hint));
}

/**
 * Geocode an arbitrary, already-built query string via Nominatim (keyless),
 * backed by the same local cache (keyed by the normalized query). This is the
 * core path; geocodeVenue() is a thin wrapper. Best-effort: returns null on no
 * match or network error, never throws.
 */
export async function geocodeQuery(
  query: string
): Promise<{ lat: number; lng: number } | null> {
  const normalizedKey = query.toLowerCase().trim();
  if (normalizedKey === "") return null;

  // --- Cache lookup ---
  const cache = loadGeoCache();
  if (Object.prototype.hasOwnProperty.call(cache, normalizedKey)) {
    return cache[normalizedKey];
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
      if (!isNaN(lat) && !isNaN(lng)) {
        result = { lat, lng };
      }
    }
  } catch (err) {
    console.warn(`[Geocoder] Network error for "${query}": ${(err as Error).message}`);
    // Don't cache errors (may be monkeypatched test throw); return null
    return null;
  }

  // Cache result (including null for "no results" — valid negative)
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
 * Respects Nominatim's 1 req/sec throttle via the geocodeVenue throttle state.
 * Best-effort: geocode failures leave the event unchanged (no throw).
 *
 * Logs a summary: n enriched / n cache-hits / n failed / n skipped.
 */
export async function enrichWithGeo(events: EventItem[]): Promise<EventItem[]> {
  let enriched = 0;
  let cacheHits = 0;
  let failed = 0;

  const result: EventItem[] = [];

  for (const event of events) {
    // Skip if already has coords
    if (event.lat !== undefined && event.lng !== undefined) {
      result.push(event);
      continue;
    }

    // Build the most geocodable query (address preferred over bare venue name).
    const query = buildGeoQuery(event);
    if (query === "") {
      result.push(event);
      continue;
    }

    // Check cache before calling geocodeQuery (to count cache hits separately)
    const normalizedKey = query.toLowerCase().trim();
    const cache = loadGeoCache();
    const wasCached = Object.prototype.hasOwnProperty.call(cache, normalizedKey);

    try {
      const coords = await geocodeQuery(query);
      if (coords !== null) {
        result.push({ ...event, lat: coords.lat, lng: coords.lng });
        if (wasCached) {
          cacheHits++;
        } else {
          enriched++;
        }
      } else {
        result.push(event);
        failed++;
      }
    } catch {
      result.push(event);
      failed++;
    }
  }

  const total = enriched + cacheHits;
  console.log(
    `[Geocoder] enrichWithGeo: ${total} enriched (${cacheHits} cache-hits, ${enriched} live), ${failed} failed/no-result`
  );

  return result;
}
