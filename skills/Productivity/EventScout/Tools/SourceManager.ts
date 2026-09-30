/**
 * SourceManager.ts — EventScout sources.json CRUD helper (Slice 8).
 *
 * Provides read/write access to the sources registry file. The sources.json
 * path is resolved in priority order:
 *   1. EVENTSCOUT_SOURCES_PATH env var (used in tests + ad-hoc runs)
 *   2. Default: Tools/sources.json co-located with this file
 *
 * Runtime freshness is SPLIT from config (2026-08-20): sources.json is pure
 * committed config; per-source `lastFetched` lives in State/source-state.json
 * ({sourceId: ISO}, gitignored) so a prefetch run no longer dirties the
 * working tree. loadSources() overlays the state onto each EventSource, so
 * readers (list-sources, UI, RefreshIntent) see the merged view unchanged;
 * saveSources() strips the field so freshness can never leak back into config.
 *
 * Exported API:
 *   loadSources(): EventSource[]                    — config + freshness overlay
 *   saveSources(sources: EventSource[]): void       — writes CONFIG only
 *   updateLastFetched(sourceId: string, ts: string): void
 *   updateLastFetchedBatch(updates): void
 *   addSource(source: EventSource): void            — appends, does not dedup
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { EventSourceSchema, DEFAULT_SOURCE_STATE_PATH } from "./types.ts";
import type { EventSource } from "./types.ts";
import { z } from "zod";

// ============================================================================
// Path resolution
// ============================================================================

function getSourcesPath(): string {
  if (process.env["EVENTSCOUT_SOURCES_PATH"]) {
    return process.env["EVENTSCOUT_SOURCES_PATH"];
  }
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, "sources.json");
}

function getSourceStatePath(): string {
  return process.env["EVENTSCOUT_SOURCE_STATE_PATH"] ?? DEFAULT_SOURCE_STATE_PATH;
}

// ============================================================================
// Source state (per-source lastFetched) — State/source-state.json
// ============================================================================

const SourceStateSchema = z.record(z.string(), z.string());
type SourceState = z.infer<typeof SourceStateSchema>;

function loadSourceState(): SourceState {
  const path = getSourceStatePath();
  if (!existsSync(path)) return {};
  try {
    return SourceStateSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    // A corrupt state file must not take queries down — freshness resets to
    // "never fetched" (sources refresh eagerly and reconverge), but say so.
    console.warn(`[SourceManager] Unreadable source-state at ${path}: ${(err as Error).message}`);
    return {};
  }
}

function saveSourceState(state: SourceState): void {
  const path = getSourceStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

// ============================================================================
// Load / save
// ============================================================================

export function loadSources(): EventSource[] {
  const path = getSourcesPath();
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  const sources = z.array(EventSourceSchema).parse(raw);
  const state = loadSourceState();
  // State overlays config; a legacy lastFetched still in a sources.json entry
  // (pre-split file, or a test fixture) survives as the fallback.
  return sources.map((s) => {
    const ts = state[s.id] ?? s.lastFetched;
    return ts ? { ...s, lastFetched: ts } : s;
  });
}

/**
 * Returns the ids of all sources whose `fetchTier` is "api" — the signal
 * Dedup.ts's `apiTierSourceIds` param needs to exempt structured api-tier
 * events from fuzzy merge (2026-07-10 remedy, option (a)). Reads sources.json
 * fresh each call (same freshness contract as loadSources()); callers that
 * already have an EventSource[] in hand (e.g. Ingest.ts's ingestAllCore,
 * which may run against an injected test list rather than the on-disk file)
 * should filter that list directly instead of calling this.
 */
export function loadApiTierSourceIds(): Set<string> {
  return new Set(loadSources().filter((s) => s.fetchTier === "api").map((s) => s.id));
}

export function saveSources(sources: EventSource[]): void {
  const path = getSourcesPath();
  // Validate, then strip runtime freshness — sources.json is pure config and
  // lastFetched belongs to State/source-state.json.
  const validated = z.array(EventSourceSchema).parse(sources);
  const config = validated.map(({ lastFetched: _lastFetched, ...rest }) => rest);
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ============================================================================
// Mutations
// ============================================================================

/**
 * Record lastFetched for a single source in State/source-state.json.
 * sources.json is never touched. No-ops if the source id is not registered.
 */
export function updateLastFetched(sourceId: string, ts: string): void {
  updateLastFetchedBatch({ [sourceId]: ts });
}

/**
 * Record lastFetched for MANY sources in a single read-modify-write of
 * State/source-state.json.
 *
 * Use this after a CONCURRENT refresh batch. Calling updateLastFetched() once
 * per source from parallel tasks would race on the state file (each does its
 * own load → mutate → save), so the last writer clobbers the others' updates.
 * Collect {id: ts} as the batch completes, then apply them all here once.
 *
 * No-ops for ids not present in the registry. `updates` keys are source ids.
 */
export function updateLastFetchedBatch(updates: Record<string, string>): void {
  if (Object.keys(updates).length === 0) return;
  const registered = new Set(loadSources().map((s) => s.id));
  const state = loadSourceState();
  let changed = false;
  for (const [id, ts] of Object.entries(updates)) {
    if (registered.has(id)) {
      state[id] = ts;
      changed = true;
    }
  }
  if (changed) saveSourceState(state);
}

/**
 * Append a new EventSource to sources.json.
 * Does NOT deduplicate — callers can query loadSources() first if needed.
 */
export function addSource(source: EventSource): void {
  const sources = loadSources();
  sources.push(EventSourceSchema.parse(source));
  saveSources(sources);
}
