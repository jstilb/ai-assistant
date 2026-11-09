#!/usr/bin/env bun
/**
 * Ingest.ts — EventScout ingest pipeline (Slice 3+9).
 *
 * Resolves each Event Source to its Source Adapter, checks source identity,
 * applies the horizon once, runs dedupeAndMerge on the combined results, then
 * upserts into the cache. Vocabulary: ../CONTEXT.md; decision:
 * ../docs/adr/0001-source-adapter-seam.md.
 *
 * Exports:
 *   adapterFor(source): SourceAdapter
 *       The production AdapterResolver: TIER_ADAPTERS by fetchTier, or
 *       API_ADAPTERS by source id for the "api" tier. Throws for an "api"
 *       source with no adapter.
 *
 *   ingestSource(source, resolve = adapterFor): Promise<EventItem[]>
 *       Fetch one source: resolve → call → identity check → horizon.
 *       No cache write.
 *
 *   ingestAll(sources?, opts?): Promise<IngestResult>
 *       Ingest all enabled sources, dedupe+merge, upsert to cache.
 *       Best-effort: each source is wrapped in a per-source timeout; one
 *       failure/timeout does NOT abort the pipeline. Failures are recorded
 *       in IngestResult.failureReasons.
 *       If sources not provided, reads from the co-located sources.json.
 *       Tests pass opts.adapterFor (a fake resolver) and skipCacheWrite.
 *
 * Script mode:
 *   bun Tools/Ingest.ts               — ingest all sources from sources.json,
 *                                       print per-source counts + merge count.
 *   bun Tools/Ingest.ts --source <id> — probe one source: one ingestSource,
 *                                       print count + 3 samples, no cache
 *                                       write, exit 1 on throw.
 *
 * Cache env:
 *   Set EVENTSCOUT_CACHE_PATH=/tmp/test-cache.json to avoid touching the
 *   real cache during tests or ad-hoc runs.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPadresEvents, SOURCE_ID as PADRES_ID } from "./adapters/PadresAdapter.ts";
import { fetchSdfcEvents, SOURCE_ID as SDFC_ID } from "./adapters/SdfcAdapter.ts";
import { fetchPike13Events } from "./adapters/Pike13Adapter.ts";
import { fetchMemberLifeEvents, SOURCE_ID as MEMBERLIFE_ID } from "./adapters/MemberLifeAdapter.ts";
import { fetchRSSEvents } from "./adapters/RSSAdapter.ts";
import { fetchSPAEvents } from "./adapters/SPAAdapter.ts";
import { fetchWordPressTecEvents } from "./adapters/WordPressTecAdapter.ts";
import { fetchEvvntEvents } from "./adapters/EvvntAdapter.ts";
import { fetchICSEvents } from "./adapters/ICSAdapter.ts";
import { fetchCtycmsEvents } from "./adapters/CtycmsAdapter.ts";
import { fetchActiveNetEvents } from "./adapters/ActiveNetAdapter.ts";
import { fetchDanceStudioProEvents } from "./adapters/DanceStudioProAdapter.ts";
import { fetchNineteenHzEvents } from "./adapters/NineteenHzAdapter.ts";
import { fetchSitemapLlmEvents } from "./adapters/SitemapLlmAdapter.ts";
import { fetchEdmtrainEvents, SOURCE_ID as EDMTRAIN_ID } from "./adapters/EdmtrainAdapter.ts";
import { fetchRaCoEvents, SOURCE_ID as RACO_ID } from "./adapters/RaCoAdapter.ts";
import { dedupeAndMerge } from "./Dedup.ts";
import { enrichWithGeo } from "./Geocoder.ts";
import { upsertEventsDeduped } from "./Cache.ts";
import { withinHorizon, horizonDays } from "./Horizon.ts";
import { runWithConcurrency } from "./lib/concurrency.ts";
import { EventSourceSchema } from "./types.ts";
import type { AdapterResolver, EventItem, EventSource, FetchTier, SourceAdapter } from "./types.ts";
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
 * Options for ingestAll.
 */
export interface IngestOpts {
  /** Source Adapter resolver. Default: adapterFor. Tests pass a fake resolver. */
  adapterFor?: AdapterResolver;
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
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ============================================================================
// Source dispatcher
// ============================================================================

/**
 * Source Adapters keyed by Fetch Tier. `satisfies` makes the map exhaustive
 * at compile time: a new tier without an adapter does not compile.
 * ICS is wrapped so its optional `deps` (a Tier-4 breaker that tests
 * inject) keeps its production default.
 *
 * "spa" and "html-llm" share SPAAdapter (BrightData tiered fetch + LLM
 * extraction); the distinction is informational (html-llm = no JS required,
 * spa = may need Playwright).
 */
const TIER_ADAPTERS = {
  rss: fetchRSSEvents,
  ics: (source) => fetchICSEvents(source),
  spa: fetchSPAEvents,
  "html-llm": fetchSPAEvents,
  "wp-tribe": fetchWordPressTecEvents,
  evvnt: fetchEvvntEvents,
  pike13: fetchPike13Events,
  ctycms: fetchCtycmsEvents,
  activenet: fetchActiveNetEvents,
  "dancestudio-pro": fetchDanceStudioProEvents,
  nineteenhz: fetchNineteenHzEvents,
  "sitemap-llm": fetchSitemapLlmEvents,
} satisfies Record<Exclude<FetchTier, "api">, SourceAdapter>;

/** Source Adapters for the "api" tier, keyed by each adapter's own SOURCE_ID. */
const API_ADAPTERS: Record<string, SourceAdapter> = {
  [PADRES_ID]: fetchPadresEvents,
  [SDFC_ID]: fetchSdfcEvents,
  [MEMBERLIFE_ID]: fetchMemberLifeEvents,
  [RACO_ID]: fetchRaCoEvents,
  [EDMTRAIN_ID]: fetchEdmtrainEvents,
};

/** The production AdapterResolver: pick the Source Adapter for one Event Source. */
export function adapterFor(source: EventSource): SourceAdapter {
  if (source.fetchTier !== "api") return TIER_ADAPTERS[source.fetchTier];
  const adapter = API_ADAPTERS[source.id];
  if (!adapter) throw new Error(`[Ingest] no Source Adapter for api source "${source.id}"`);
  return adapter;
}

/**
 * Fetch one Event Source: resolve → call → identity check → horizon.
 *
 * This is the single chokepoint for every path:
 *   - Scheduled prefetch:    ingestAll → ingestSource
 *   - Query-time refresh:    queryHybrid → ingestSource (directly)
 *   - Tests:                 ingestAll(…, { adapterFor: fake }) → ingestSource
 *
 * The identity check runs before the horizon, so drift fails even when every
 * item lies beyond the horizon. It guards the api-tier dedup exemption
 * (Dedup.ts), which matches `sources[0].sourceId` against sources.json ids.
 */
export async function ingestSource(
  source: EventSource,
  resolve: AdapterResolver = adapterFor,
): Promise<EventItem[]> {
  const rawEvents = await resolve(source)(source);

  const foreign = rawEvents.find((e) => e.sources[0]?.sourceId !== source.id);
  if (foreign) {
    throw new Error(
      `[Ingest] Source Adapter for "${source.fetchTier}" stamped sourceId "${String(foreign.sources[0]?.sourceId)}" on source "${source.id}"`,
    );
  }

  // Horizon filter — applied once, here, for every path.
  // withinHorizon takes `now` explicitly so it stays unit-testable.
  const days = horizonDays();
  const events = withinHorizon(rawEvents, new Date(), days);
  const dropped = rawEvents.length - events.length;
  if (dropped > 0) {
    console.log(`  [ingest] ${source.id}: dropped ${dropped} event(s) beyond ${days}-day horizon`);
  }
  return events;
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
 * @param opts    - Resolver (tests pass a fake), cache write, timeout, concurrency.
 */
export async function ingestAll(sources?: EventSource[], opts: IngestOpts = {}): Promise<IngestResult> {
  const allSources = sources ?? loadDefaultSources();
  const resolve = opts.adapterFor ?? adapterFor;
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
      const events = await withTimeout(ingestSource(source, resolve), timeoutMs, source.id);

      perSource[source.id] = events.length;
      allEvents.push(...events);
      console.log(`  [ingest] ${source.id}: fetched ${events.length} event(s)`);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      perSource[source.id] = 0;
      failureReasons[source.id] = message;
      console.error(`  [ingest] ${source.id}: FAILED — ${message}`);
    }
  });

  // api-tier sources (fetchTier === "api") are exempt from fuzzy dedup — see
  // Dedup.ts's "api-tier exemption" note. Computed from `allSources` (the
  // actual list this run is ingesting — respects test injection) rather than
  // re-reading sources.json, so test-supplied sources are honored exactly.
  const apiTierSourceIds = new Set(allSources.filter((s) => s.fetchTier === "api").map((s) => s.id));

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
  (process.argv[1].endsWith("Ingest.ts") || process.argv[1].endsWith("Ingest"));

/**
 * Probe one Event Source through the seam: one ingestSource (identity check +
 * horizon included), no cache write. Prints the count and 3 samples.
 */
async function probeSource(id: string): Promise<void> {
  const source = loadDefaultSources().find((s) => s.id === id);
  if (!source) throw new Error(`[Ingest] no source "${id}" in sources.json`);
  console.log(`\nEventScout — probe ${source.id} (${source.fetchTier})\n`);
  const events = await ingestSource(source);
  console.log(`${source.id}: ${events.length} event(s)`);
  for (const e of events.slice(0, 3)) {
    console.log(`  - ${e.title} | ${e.startDatetime} | ${e.sources[0]?.sourceId ?? "(no sourceId)"}`);
  }
}

const sourceFlag = process.argv.indexOf("--source");

if (IS_SCRIPT && sourceFlag !== -1) {
  const id = process.argv[sourceFlag + 1];
  try {
    if (!id) throw new Error("[Ingest] --source needs a source id");
    await probeSource(id);
    process.exit(0);
  } catch (err) {
    console.error(`\nFATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
} else if (IS_SCRIPT) {
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
