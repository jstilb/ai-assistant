#!/usr/bin/env bun
/**
 * backfillGeo.ts — one-shot geocode backfill over the existing event cache.
 *
 * ~50% of cached events have no coords because Nominatim can't resolve bare
 * venue names. `enrichWithGeo` now prefers a street address (see
 * Geocoder.buildGeoQuery), so re-running it over the cache recovers coords for
 * events that DO carry an address. Cache-first + 1.1s throttle on live calls.
 *
 * Usage:
 *   bun skills/Productivity/EventScout/Tools/backfillGeo.ts
 *
 * Idempotent: events that already have coords are skipped; negative results are
 * cached so a second run is fast.
 */

import { readEvents, writeEvents } from "./Cache.ts";
import { enrichWithGeo } from "./Geocoder.ts";

const before = readEvents();
const missingBefore = before.filter((e) => e.lat === undefined || e.lng === undefined).length;
console.log(`[backfillGeo] ${before.length} events; ${missingBefore} missing coords. Geocoding (address-preferred, throttled)…`);

const enriched = await enrichWithGeo(before);

const missingAfter = enriched.filter((e) => e.lat === undefined || e.lng === undefined).length;
const recovered = missingBefore - missingAfter;
writeEvents(enriched);

console.log(`[backfillGeo] DONE — recovered ${recovered} coords; ${missingAfter} still missing (no address / unresolvable). Cache written.`);
