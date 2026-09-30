#!/usr/bin/env bun
/**
 * Query.ts — EventScout query entry point (Slice 7; markdown-first re-intake 2026-07).
 *
 * queryHybrid(context, limit?, refresh?) → { context, events, rankedEvents, markdown, ... }
 *   1. context (QueryContext) — structured, agent-resolved query intake, built
 *      by cli.ts's buildQueryContext(). No NL parsing happens in this module —
 *      the calling agent resolves dates/refresh-intent/price-mode/category
 *      explicitness by reading SKILL.md (see "How to invoke query (agents)").
 *   2. readEvents        — load events-cache.json
 *   3. filterEvents      — apply hard constraints
 *   4. rankEvents        — score + LLM why-lines (top N)
 *   5. renderTiered — produce tiered markdown (top 10 full + rest compact)
 *
 * Note: the standalone-script entrypoint (`bun Tools/Query.ts "<nl>"`) that
 * used to live at the bottom of this file called the old NL constraint
 * parser directly and was NEVER part of the documented CLI surface (cli.ts's
 * `query` subcommand is) — it had zero callers/tests. It's removed here
 * rather than kept alive as dead, now type-incompatible code (Filter/Ranker/
 * Render all take QueryContext as of this slice); ConstraintParser.ts itself
 * is untouched and still exercised directly by constraint-resolve.test.ts
 * until Commit 3 deletes it.
 */

import { filterEvents } from "./Filter.ts";
import { renderTiered } from "./Render.ts";
import { readEvents, upsertEventsDeduped } from "./Cache.ts";
import { rankEvents } from "./Ranker.ts";
import { loadProfile } from "./InterestProfile.ts";
import { selectRefreshSources } from "./RefreshIntent.ts";
import { ingestSource } from "./Ingest.ts";
import { dedupeAndMerge } from "./Dedup.ts";
import { enrichWithGeo } from "./Geocoder.ts";
import { loadSources, loadApiTierSourceIds, updateLastFetchedBatch } from "./SourceManager.ts";
import { runWithConcurrency } from "./lib/concurrency.ts";
import type { QueryContext, EventItem, InterestProfile } from "./types.ts";
import type { RankedEvent } from "./Ranker.ts";

// ============================================================================
// queryHybrid — hybrid-aware, QueryContext-driven query (Slice 8; re-intake 2026-07)
// ============================================================================

export interface HybridQueryResult {
  /** Structured, agent-resolved query intake (see types.ts). */
  context: QueryContext;
  events: EventItem[];
  rankedEvents: RankedEvent[];
  markdown: string;
  /** Sources that were live-refreshed before reading the cache */
  refreshedSources: string[];
  /** Sources that were eligible but skipped due to the cap */
  skippedSources: string[];
}

/**
 * Persist live-refreshed events into the cache so they reach ranking — and
 * subsequent queries within the poll window. Mirrors the prefetch write tail
 * (dedup → geo-enrich → upsert). Without this, queryHybrid fetched events at
 * query time but discarded them: readEvents() only ever saw the prefetch-written
 * cache, so live refreshes (incl. highValue sources) never affected results.
 *
 * upsertEvents merges by id, so passing only the refreshed subset is safe —
 * other sources already in the cache are preserved.
 *
 * api-tier sources (sources.json fetchTier === "api") are exempt from the
 * fuzzy dedup pass below — see Dedup.ts's "api-tier exemption" note. This is
 * the FIRST dedup pass a live refresh batch hits (before it ever reaches the
 * cache), so it is the primary guard against api-tier events from the same
 * batch (e.g. MemberLifeAdapter's "Level 1 Salsa"/"Level 2 Salsa") being
 * fuzzy-collapsed with each other.
 *
 * @param events - Events fetched this query across all refreshed sources.
 * @returns Count of events written to the cache (post-dedup).
 */
export async function persistRefreshedEvents(events: EventItem[]): Promise<number> {
  if (events.length === 0) return 0;
  const merged = dedupeAndMerge(events, loadApiTierSourceIds());
  const geoEnriched = await enrichWithGeo(merged);
  // upsertEventsDeduped collapses twins across the WHOLE cache, not just this
  // batch — so cross-source duplicates already in the cache (e.g. the same show
  // from Eventbrite + Songkick + Bandsintown under different ids) get merged too.
  upsertEventsDeduped(geoEnriched);
  return geoEnriched.length;
}

/**
 * Per-source live-refresh timeout. A generous safety net against a genuinely
 * hung source (network black hole) — NOT a latency budget. Sized to NEVER
 * pre-empt the inner inference retry budget: one LLM extraction window can spend
 * up to ~2 fresh-spawn retries (≈120s each) recovering from a stalled socket, on
 * top of the BrightData/Apify fetch. 360s clears that worst-realistic path
 * (fetch ~60s + stall-and-recover extraction) so a slow-but-progressing source
 * is waited out, not dropped. Tune via EVENTSCOUT_REFRESH_TIMEOUT_MS.
 */
function refreshTimeoutMs(): number {
  const raw = process.env["EVENTSCOUT_REFRESH_TIMEOUT_MS"];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 360_000;
}

/**
 * Max sources fetched at once. The refresh set is UNCAPPED (every eligible source
 * runs), but we bound concurrent network/LLM load so we don't trip provider rate
 * limits — which would themselves surface as failures. Waves, not drops. Tune via
 * EVENTSCOUT_REFRESH_CONCURRENCY.
 */
function refreshConcurrency(): number {
  const raw = process.env["EVENTSCOUT_REFRESH_CONCURRENCY"];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 8;
}


/**
 * Hybrid-aware query pipeline:
 *   1. Take a caller-built QueryContext (structured, agent-resolved — see
 *      types.ts and cli.ts's buildQueryContext). No NL parsing happens here.
 *   2. Decide refresh: if `refresh` is true, select all enabled category-relevant
 *      sources via selectRefreshSources and live-ingest them (bounded concurrency).
 *      If `refresh` is false (default / cache-first), skip all live fetching.
 *   3. (refresh path only) Persist refreshed events to cache.
 *   4. Read cache → filter → rank → render.
 *
 * Default is CACHE-FIRST (refresh=false). The CALLER decides refresh — cli.ts
 * sets it from the `--refresh` flag ONLY (no more NL "latest"/"update" sniffing
 * inside this module).
 *
 * `highValue` no longer forces query-time refresh. It remains in the schema as a
 * prefetch-priority hint only.
 *
 * Every refreshed source is logged. `skippedSources` is retained on the result for
 * backward-compat but is always empty now (nothing is capped).
 *
 * @param context - Structured query intake (rawQuery + window + hard filters + home).
 * @param limit   - Max ranked results to return (default Infinity → return all).
 * @param refresh - Whether to live-refresh sources before reading cache (default false).
 */
export async function queryHybrid(
  context: QueryContext,
  limit = Infinity,
  refresh = false
): Promise<HybridQueryResult> {
  // ---- cache-first decision ----
  const allSources = loadSources();
  const toRefresh = selectRefreshSources({ refresh, sources: allSources, constraints: context });

  // Nothing is capped — kept on the result for interface compatibility.
  const skippedSources: string[] = [];

  if (!refresh) {
    console.log(
      "[hybrid] cache-only — reading cache (pass --refresh or say 'latest/update' to fetch live)"
    );
  } else if (toRefresh.length > 0) {
    console.log(
      `[hybrid] Refreshing ${toRefresh.length} source(s) live ` +
      `(parallel, up to ${refreshConcurrency()} at once, ${Math.round(refreshTimeoutMs() / 1000)}s timeout each):`
    );
  }

  const refreshedSources: string[] = [];
  const refreshedEvents: EventItem[] = [];
  const lastFetchedUpdates: Record<string, string> = {};
  const timeoutMs = refreshTimeoutMs();

  await runWithConcurrency(toRefresh, refreshConcurrency(), async (source) => {
    console.log(`[hybrid]   refreshing: ${source.id} (${source.url})`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        ingestSource(source),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timeout after ${Math.round(timeoutMs / 1000)}s`)),
            timeoutMs
          );
        }),
      ]);
      const fetched = result as EventItem[];
      // Stage lastFetched; written in one atomic batch after the pool drains so
      // parallel tasks don't clobber sources.json (read-modify-write race).
      lastFetchedUpdates[source.id] = new Date().toISOString();
      refreshedEvents.push(...fetched);
      refreshedSources.push(source.id);
      console.log(`[hybrid]   done: ${source.id} — ${fetched.length} event(s) fetched`);
    } catch (err) {
      const msg = (err as Error).message;
      console.warn(`[hybrid]   skipped: ${source.id} — ${msg}`);
    } finally {
      if (timer) clearTimeout(timer); // stop a stray timer from holding the event loop
    }
  });

  // Single atomic write for all sources refreshed this query.
  if (Object.keys(lastFetchedUpdates).length > 0) {
    updateLastFetchedBatch(lastFetchedUpdates);
  }

  // Persist what we just fetched so it actually reaches ranking (and warms the
  // cache for later queries). Best-effort: a cache-write failure must not sink
  // the query — we still rank over whatever the on-disk cache already holds.
  if (refreshedEvents.length > 0) {
    try {
      const persisted = await persistRefreshedEvents(refreshedEvents);
      console.log(`[hybrid] Persisted ${persisted} refreshed event(s) to cache`);
    } catch (err) {
      console.warn(`[hybrid] Persist failed (ranking from existing cache): ${(err as Error).message}`);
    }
  }

  // ---- filter + rank + render from (updated) cache ----
  const allEvents = readEvents();
  const events = filterEvents(allEvents, context);

  let profile: InterestProfile;
  try {
    profile = await loadProfile();
  } catch {
    profile = {
      homeLocation: { lat: 32.7157, lng: -117.1611, label: "San Diego (default)" },
      defaultRadiusMiles: 15,
    };
  }

  const rankedEvents = await rankEvents(events, context, profile, limit);
  const markdown = renderTiered(rankedEvents, context);

  return { context, events, rankedEvents, markdown, refreshedSources, skippedSources };
}

