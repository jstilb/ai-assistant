/**
 * PrefetchGuard.ts — Liveness guard for the EventScout prefetch wrapper.
 *
 * Determines whether the most recent prefetch run was healthy:
 *   1. The cache file exists.
 *   2. Its mtime is within `sinceMs` milliseconds of `now` (i.e. it was
 *      written during this run, not left over from a prior run).
 *   3. The cache contains at least one event (count > 0).
 *
 * All three conditions must pass; any failure returns false (unhealthy).
 *
 * Used by `bin/eventscout-prefetch.sh` to gate the exit code:
 *   exit 0  → healthy
 *   exit 1  → unhealthy (non-zero so monitors see failure, not silent green)
 */

import { existsSync, statSync, readFileSync } from "fs";

export interface PrefetchGuardResult {
  healthy: boolean;
  /** Human-readable reason when healthy=false */
  reason?: string;
  /** Number of events found in cache (undefined when file missing) */
  eventCount?: number;
  /** Milliseconds since cache was last written (undefined when file missing) */
  ageMs?: number;
}

/**
 * Check whether the prefetch cache at `cachePath` was refreshed within
 * the last `sinceMs` milliseconds and contains at least one event.
 *
 * @param cachePath  Absolute path to `events-cache.json`.
 * @param sinceMs    Freshness window in milliseconds (default: 15 minutes).
 *                   The wrapper should pass the actual wall-clock duration of
 *                   the prefetch run, but 15 min is a safe upper bound for
 *                   the scheduled job.
 * @param now        Reference time for age calculation (defaults to Date.now()).
 */
export function isPrefetchHealthy(
  cachePath: string,
  sinceMs: number = 15 * 60 * 1000,
  now: number = Date.now()
): PrefetchGuardResult {
  // 1. File must exist.
  if (!existsSync(cachePath)) {
    return { healthy: false, reason: `cache file not found: ${cachePath}` };
  }

  // 2. File must have been written within the freshness window.
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(cachePath);
  } catch (err) {
    return { healthy: false, reason: `stat failed: ${(err as Error).message}` };
  }
  const ageMs = now - stat.mtimeMs;
  if (ageMs > sinceMs) {
    return {
      healthy: false,
      reason: `cache is stale: ${Math.round(ageMs / 1000)}s old, freshness window is ${Math.round(sinceMs / 1000)}s`,
      ageMs,
    };
  }

  // 3. Cache must contain at least one event.
  let eventCount = 0;
  try {
    const raw = readFileSync(cachePath, "utf-8").trim();
    if (raw !== "") {
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "events" in (parsed as Record<string, unknown>)
      ) {
        const events = (parsed as { events: unknown[] }).events;
        if (Array.isArray(events)) {
          eventCount = events.length;
        }
      }
    }
  } catch (err) {
    return {
      healthy: false,
      reason: `failed to parse cache: ${(err as Error).message}`,
      ageMs,
    };
  }

  if (eventCount === 0) {
    return {
      healthy: false,
      reason: "cache exists and is fresh but contains 0 events",
      eventCount: 0,
      ageMs,
    };
  }

  return { healthy: true, eventCount, ageMs };
}
