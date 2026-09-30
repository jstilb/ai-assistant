#!/usr/bin/env bun
/**
 * Ingest.ts — EventScout ingest pipeline (Slice 3+9).
 *
 * Dispatches each EventSource to the correct adapter by fetchTier, runs
 * dedupeAndMerge on the combined results, then upserts into the cache.
 *
 * Exports:
 *   ingestSource(source: EventSource): Promise<EventItem[]>
 *       Fetch a single source. Returns raw EventItem[] (no cache write).
 *       - "api" + id === "padres-mlb"  → PadresAdapter.fetchPadresEvents()
 *       - "rss"                        → RSSAdapter.fetchRSSEvents()
 *       - "spa" | "html-llm"           → SPAAdapter.fetchSPAEvents()
 *       - other tiers                  → throws "not yet implemented"
 *
 *   ingestAll(sources?: EventSource[]): Promise<IngestResult>
 *       Ingest all enabled sources, dedupe+merge, upsert to cache.
 *       Best-effort: each source is wrapped in a per-source timeout; one
 *       failure/timeout does NOT abort the pipeline. Failures are recorded
 *       in IngestResult.failureReasons.
 *       If sources not provided, reads from the co-located sources.json.
 *
 *   ingestAllWithAdapters(sources, adapters, opts): Promise<IngestResult>
 *       Testable overload — injects per-source adapter functions so unit
 *       tests can run without any network calls. Used exclusively in tests.
 *
 * Script mode (bun Tools/Ingest.ts):
 *   Ingests all sources from sources.json, prints per-source counts
 *   + merge count, exits 0 on success.
 *
 * Cache env:
 *   Set EVENTSCOUT_CACHE_PATH=/tmp/test-cache.json to avoid touching the
 *   real cache during tests or ad-hoc runs.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { fetchPadresEvents } from "./adapters/PadresAdapter.ts";
import { fetchSdfcEvents } from "./adapters/SdfcAdapter.ts";
import { fetchPike13Events } from "./adapters/Pike13Adapter.ts";
import { fetchMemberLifeEvents } from "./adapters/MemberLifeAdapter.ts";
import { fetchRSSEvents } from "./adapters/RSSAdapter.ts";
import { fetchSPAEvents } from "./adapters/SPAAdapter.ts";
import { fetchWordPressTecEvents } from "./adapters/WordPressTecAdapter.ts";
import { fetchEvvntEvents } from "./adapters/EvvntAdapter.ts";
import { fetchICSEvents } from "./adapters/ICSAdapter.ts";
import { fetchApifyEvents } from "./adapters/ApifyAdapter.ts";
import { trackApifySourceHealth } from "./ApifyHealth.ts";
import { fetchCtycmsEvents } from "./adapters/CtycmsAdapter.ts";
import { fetchActiveNetEvents } from "./adapters/ActiveNetAdapter.ts";
import { fetchDanceStudioProEvents } from "./adapters/DanceStudioProAdapter.ts";
import { fetchNineteenHzEvents } from "./adapters/NineteenHzAdapter.ts";
import { fetchSitemapLlmEvents } from "./adapters/SitemapLlmAdapter.ts";
import { fetchEdmtrainEvents } from "./adapters/EdmtrainAdapter.ts";
import { fetchRaCoEvents } from "./adapters/RaCoAdapter.ts";
import { dedupeAndMerge } from "./Dedup.ts";
import { enrichWithGeo } from "./Geocoder.ts";
import { upsertEventsDeduped } from "./Cache.ts";
import { withinHorizon, horizonDays } from "./Horizon.ts";
import { runWithConcurrency } from "./lib/concurrency.ts";
import { EventSourceSchema } from "./types.ts";
import type { EventItem, EventSource } from "./types.ts";
import { z } from "zod";

// ============================================================================
// Types
// ============================================================================

export interface IngestResult {
  /** Total events written to cache after dedup */
  written: number;
  /** Per-source raw fetch counts (before dedup). 0 for failed/empty sources. */
  perSource: Record<string, number>;
  /** Number of events collapsed by dedupeAndMerge */
  merges: number;
  /**
   * Per-source failure reasons. Only populated for sources that threw or timed out.
   * Sources that succeeded (even with 0 events) do NOT have an entry here.
   */
  failureReasons?: Record<string, string>;
}

/**
 * Default per-source timeout for production prefetch runs (600 seconds).
 *
 * Raised from 360s to 600s for Slice 8: with Slices 6–7 uncapping pagination,
 * multi-page SPA sources (e.g. Eventbrite 20 pages × up to 12 LLM windows ×
 * potential 2 retry spawns) can legitimately need 8–10 minutes. The earlier
 * 360s cap guillotined slow-but-working sources mid-extraction. Prefetch is
 * scheduled (non-interactive, runs overnight), so the longer budget is safe.
 *
 * Override via EVENTSCOUT_PREFETCH_TIMEOUT_MS environment variable.
 */
const DEFAULT_PER_SOURCE_TIMEOUT_MS = 600_000;

/**
 * Default max concurrent sources during prefetch (6).
 *
 * Bounded concurrency replaces the old sequential for…await. Six lanes let
 * fast API/RSS sources overlap with slow SPA sources without overwhelming
 * provider rate limits. Override via EVENTSCOUT_PREFETCH_CONCURRENCY.
 */
const DEFAULT_PREFETCH_CONCURRENCY = 6;

/** Read per-source timeout from env, falling back to the default. */
function prefetchTimeoutMs(): number {
  const raw = process.env["EVENTSCOUT_PREFETCH_TIMEOUT_MS"];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PER_SOURCE_TIMEOUT_MS;
}

/** Read prefetch concurrency from env, falling back to the default. */
function prefetchConcurrency(): number {
  const raw = process.env["EVENTSCOUT_PREFETCH_CONCURRENCY"];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PREFETCH_CONCURRENCY;
}

/**
 * Options for ingestAllWithAdapters (test-injection overload).
 */
export interface IngestWithAdaptersOpts {
  /** Skip writing to the cache (for unit tests). Default: false. */
  skipCacheWrite?: boolean;
  /** Per-source timeout in ms. Default: DEFAULT_PER_SOURCE_TIMEOUT_MS. */
  perSourceTimeoutMs?: number;
  /**
   * Max concurrent sources to fetch in parallel.
   * In tests, pass a small value (e.g. 2–4) to verify the cap deterministically.
   * In production, controlled by EVENTSCOUT_PREFETCH_CONCURRENCY.
   * Default: DEFAULT_PREFETCH_CONCURRENCY (6).
   */
  concurrency?: number;
}

// ============================================================================
// Per-source timeout helper
// ============================================================================

/**
 * Race a promise against a timeout.
 * Rejects with a timeout error if the promise does not resolve within timeoutMs.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[Ingest] timeout (${timeoutMs}ms) exceeded for source "${label}"`));
    }, timeoutMs);

    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ============================================================================
// Source dispatcher
// ============================================================================

/**
 * Fetch events for a single source, then apply the horizon filter.
 *
 * This is the TRUE single chokepoint for all production paths:
 *   - Scheduled prefetch:    ingestAll → ingestAllCore → ingestSource
 *   - Query-time refresh:    queryHybrid → ingestSource (directly)
 *
 * Both paths receive horizon-filtered results. The post-adapter cap in
 * ingestAllCore handles the injected-adapter test path (where adapters bypass
 * this function entirely).
 *
 * Slice 9: both "spa" and "html-llm" now route to SPAAdapter.fetchSPAEvents(),
 * which uses BrightData tiered fetch + LLM extraction. The distinction between
 * the two tiers is informational (html-llm = no JS required, spa = may need
 * Playwright) but the same adapter handles both gracefully.
 */
export async function ingestSource(source: EventSource): Promise<EventItem[]> {
  const rawEvents = await fetchRawEvents(source);

  // Horizon filter — uniform post-adapter cap. Applied here (not just in
  // ingestAllCore) so queryHybrid's direct ingestSource calls are also bounded.
  // withinHorizon takes `now` explicitly so it stays unit-testable.
  const days = horizonDays();
  const events = withinHorizon(rawEvents, new Date(), days);
  const dropped = rawEvents.length - events.length;
  if (dropped > 0) {
    console.log(
      `  [ingest] ${source.id}: dropped ${dropped} event(s) beyond ${days}-day horizon`
    );
  }
  return events;
}

/**
 * Dispatch a source to its adapter and return raw (unfiltered) events.
 * Private to this module — callers use ingestSource which applies the horizon.
 */
async function fetchRawEvents(source: EventSource): Promise<EventItem[]> {
  switch (source.fetchTier) {
    case "api": {
      if (source.id === "padres-mlb") {
        return fetchPadresEvents();
      }
      if (source.id === "sandiego-fc") {
        return fetchSdfcEvents();
      }
      if (source.id === "majestyinmotion-classes") {
        return fetchMemberLifeEvents();
      }
      if (source.id === "ra-co-sandiego") {
        return fetchRaCoEvents();
      }
      if (source.id === "edmtrain-sd") {
        return fetchEdmtrainEvents();
      }
      throw new Error(`[Ingest] API source "${source.id}" has no adapter yet`);
    }

    case "rss": {
      return fetchRSSEvents(source);
    }

    case "spa":
    case "html-llm": {
      // Both SPA (JS-rendered) and html-llm (static HTML + LLM extract) use
      // the same BrightData tiered fetch + Inference extraction pipeline.
      // SPAAdapter escalates to Playwright only when lighter tiers fail.
      return fetchSPAEvents(source);
    }

    case "wp-tribe": {
      return fetchWordPressTecEvents(source);
    }

    case "ics": {
      return fetchICSEvents(source);
    }

    case "evvnt": {
      return fetchEvvntEvents(source);
    }

    case "apify": {
      return fetchApifyEvents(source);
    }

    case "pike13": {
      // Pike13 widget API (dance/fitness studio schedules). One source today
      // (Culture Shock SD); the adapter holds its studio-specific config.
      return fetchPike13Events();
    }

    case "ctycms": {
      // ctycms "Picnic" calendar widget (community/arts district sites). One
      // source today (Liberty Station); tag→category config keyed by source id.
      return fetchCtycmsEvents(source);
    }

    case "activenet": {
      // ActiveNet/ActiveCommunities rec catalog (paginated JSON list API). One
      // source today (SD Parks & Rec); the adapter holds its city-specific config.
      return fetchActiveNetEvents();
    }

    case "dancestudio-pro": {
      // DanceStudio-Pro studio schedule widget (AJAX POST + shared LLM
      // extraction). One source today (The Dancehouse); the studio id/s
      // params come from the source's own url.
      return fetchDanceStudioProEvents(source);
    }

    case "sitemap-llm": {
      // XML-sitemap-enumerated detail pages + shared LLM extraction, for
      // sites with no events page/feed at all (San Diego Writers, Ink CPT
      // sitemaps). The adapter walks each fresh detail page for the exact
      // TIME/VENUE/PRICE blocks the listing pages omit.
      return fetchSitemapLlmEvents(source);
    }

    case "nineteenhz": {
      // 19hz.info structured chronological table — deterministic row parser,
      // no LLM (the dense listing chronically blew the LLM window budget).
      // SoCal-wide page; the adapter keeps only San Diego-county rows.
      return fetchNineteenHzEvents(source);
    }

    case "shopify":
      throw new Error(
        `[Ingest] fetchTier "shopify" for source "${source.id}" is not yet implemented`
      );

    default: {
      // TypeScript exhaustiveness guard
      const _: never = source.fetchTier;
      throw new Error(`[Ingest] Unknown fetchTier: ${String(_)}`);
    }
  }
}

// ============================================================================
// Default sources loader
// ============================================================================

function loadDefaultSources(): EventSource[] {
  // Resolve sources.json relative to this file's location
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const sourcesPath = resolve(thisDir, "sources.json");
  const raw = JSON.parse(readFileSync(sourcesPath, "utf-8")) as unknown;
  return z.array(EventSourceSchema).parse(raw);
}

// ============================================================================
// ingestAll — the main pipeline entry point
// ============================================================================

/**
 * Ingest all enabled sources, merge duplicates, and upsert the result.
 *
 * Best-effort: each source is wrapped in a per-source timeout
 * (DEFAULT_PER_SOURCE_TIMEOUT_MS). One failing/hanging source does NOT abort
 * the pipeline. Failures are recorded in result.failureReasons.
 *
 * @param sources - Optional explicit list. Defaults to sources.json.
 */
export async function ingestAll(sources?: EventSource[]): Promise<IngestResult> {
  const allSources = sources ?? loadDefaultSources();
  return ingestAllCore(allSources, undefined, {});
}

/**
 * Testable overload: inject per-source adapter functions.
 * Each key in `adapters` is a source.id; the value is a factory that returns
 * a Promise<EventItem[]> for that source. Sources not in `adapters` fall back
 * to the real ingestSource() — this keeps the test focused and minimal.
 *
 * @param sources  - Full list of EventSource objects.
 * @param adapters - Map of sourceId → adapter factory.
 * @param opts     - Options for test isolation.
 */
export async function ingestAllWithAdapters(
  sources: EventSource[],
  adapters: Record<string, () => Promise<EventItem[]>>,
  opts: IngestWithAdaptersOpts = {},
): Promise<IngestResult> {
  return ingestAllCore(sources, adapters, opts);
}

// ============================================================================
// Core implementation shared by ingestAll + ingestAllWithAdapters
// ============================================================================

async function ingestAllCore(
  allSources: EventSource[],
  adapters: Record<string, () => Promise<EventItem[]>> | undefined,
  opts: IngestWithAdaptersOpts,
): Promise<IngestResult> {
  const enabledSources = allSources.filter((s) => s.enabled);
  // Respect the caller-supplied concurrency (test injection) or read from env
  const concurrencyLimit = opts.concurrency ?? prefetchConcurrency();
  const timeoutMs = opts.perSourceTimeoutMs ?? prefetchTimeoutMs();

  const perSource: Record<string, number> = {};
  const failureReasons: Record<string, string> = {};
  const allEvents: EventItem[] = [];

  // Bounded-concurrency worker pool — replaces the old sequential for…await.
  // Each lane grabs the next source index until all sources are claimed.
  // Mutations to perSource/failureReasons/allEvents between awaits are safe:
  // the JS event loop is single-threaded; only one continuation runs at a time.
  // The cache WRITE happens after the pool drains (below), so there is no
  // write race — all per-source results are collected first.
  await runWithConcurrency(enabledSources, concurrencyLimit, async (source) => {
    try {
      // Use injected adapter if provided, otherwise dispatch normally
      const fetchFn = adapters?.[source.id]
        ? adapters[source.id]!
        : () => ingestSource(source);

      const rawEvents = await withTimeout(fetchFn(), timeoutMs, source.id);

      // Horizon filter — applied here for injected-adapter test paths that bypass
      // ingestSource. When the production fetchFn delegates to ingestSource(), the
      // filter has already run inside ingestSource; applying it again is harmless
      // (all events are already within horizon, so nothing extra gets dropped).
      // withinHorizon takes `now` explicitly so it stays unit-testable.
      const days = horizonDays();
      const events = withinHorizon(rawEvents, new Date(), days);
      const dropped = rawEvents.length - events.length;
      if (dropped > 0) {
        console.log(
          `  [ingest] ${source.id}: dropped ${dropped} event(s) beyond ${days}-day horizon`
        );
      }

      perSource[source.id] = events.length;
      allEvents.push(...events);
      console.log(`  [ingest] ${source.id}: fetched ${events.length} event(s)`);

      // Apify-tier per-source health streaks (T2-09) — scoped to fetchTier
      // "apify" only; the other 35 tiers are out of scope for this slice.
      // Wrapped in its own try/catch, separate from the fetch-failure catch
      // below: a bug in the health-tracking side-channel must never get
      // misattributed as a fetch failure for a source that actually
      // succeeded (which would corrupt perSource/failureReasons).
      if (source.fetchTier === "apify") {
        try {
          await trackApifySourceHealth(
            source.id,
            source.url,
            events.length === 0
              ? { kind: "zero-result" }
              : { kind: "success", count: events.length },
          );
        } catch (healthErr) {
          console.error(
            `[Ingest] apify-health tracking failed for "${source.id}" (fetch itself succeeded) — ` +
              `streak counters NOT updated this run:`,
            healthErr,
          );
        }
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      perSource[source.id] = 0;
      failureReasons[source.id] = message;
      console.error(`  [ingest] ${source.id}: FAILED — ${message}`);

      if (source.fetchTier === "apify") {
        try {
          await trackApifySourceHealth(source.id, source.url, { kind: "hard-fail", error: err });
        } catch (healthErr) {
          console.error(
            `[Ingest] apify-health tracking failed for "${source.id}" (hard-fail branch) — ` +
              `streak counters NOT updated this run:`,
            healthErr,
          );
        }
      }
    }
  });

  // api-tier sources (fetchTier === "api") are exempt from fuzzy dedup — see
  // Dedup.ts's "api-tier exemption" note. Computed from `allSources` (the
  // actual list this run is ingesting — respects test injection) rather than
  // re-reading sources.json, so ingestAllWithAdapters' test-supplied sources
  // are honored exactly.
  const apiTierSourceIds = new Set(
    allSources.filter((s) => s.fetchTier === "api").map((s) => s.id)
  );

  const beforeDedup = allEvents.length;
  const merged = dedupeAndMerge(allEvents, apiTierSourceIds);
  const merges = beforeDedup - merged.length;

  let written: number;
  if (opts.skipCacheWrite) {
    // Test mode: don't touch the cache
    written = merged.length;
  } else {
    // Production: geo-enrich then upsert
    const geoEnriched = await enrichWithGeo(merged);
    // Dedup across the whole cache (not just this prefetch batch) so twins that
    // already accumulated from earlier runs / other sources collapse too.
    upsertEventsDeduped(geoEnriched);
    written = geoEnriched.length;
  }

  const result: IngestResult = {
    written,
    perSource,
    merges,
  };

  // Only include failureReasons in result if there are any
  if (Object.keys(failureReasons).length > 0) {
    result.failureReasons = failureReasons;
  }

  return result;
}

// ============================================================================
// Script entry point
// ============================================================================

const IS_SCRIPT =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("Ingest.ts") ||
    process.argv[1].endsWith("Ingest"));

if (IS_SCRIPT) {
  console.log("\nEventScout — Ingest Pipeline (Slice 3)\n");

  try {
    const result = await ingestAll();

    console.log("\n--- Results ---");
    console.log(`Per-source counts:`);
    for (const [id, count] of Object.entries(result.perSource)) {
      console.log(`  ${id}: ${count}`);
    }
    console.log(`\nMerges (events collapsed by dedup): ${result.merges}`);
    console.log(`Written to cache: ${result.written}`);
    console.log("\nDone.\n");
    process.exit(0);
  } catch (err) {
    console.error(`\nFATAL: ${(err as Error).message}`);
    process.exit(1);
  }
}
