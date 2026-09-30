#!/usr/bin/env bun
/**
 * WigTargets.ts — discover the current media WIG's targets from LifeOS's
 * wig_status.json.
 *
 * The goal is discovered by shape (any G* entry with
 * targets.low_value.target_min_per_day), not by a hardcoded ID — a quarterly
 * rollover that renames G42 must not leave consumers stale. That drift class
 * bit three times at the 2026-07-06 Q3 flip: Freshness printed the retired
 * "G37 ≤ 270" note, DashboardServer hardcoded G37-G41, and GoalsBlock's
 * G37 lookup silently stopped overriding the briefing's media line.
 *
 * Deliberately dependency-free (no Db.ts / DuckDB): DailyBriefing's
 * GoalsBlock imports this cross-skill and must not drag the native DuckDB
 * module into the briefing's import graph.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

export interface MediaWigTargets {
  goalId: string;
  /** targets.low_value.target_min_per_day — the 4-wk-avg sub-target. */
  lowValue: number;
  /** targets.total_media_incl_youtube.target_min_per_day, if present. */
  totalMedia: number | null;
}

/** Resolved per call (not module-level) so test sandboxes that repoint
 *  KAYA_HOME between imports are honored — a module-level const would pin the
 *  first import's env for the whole process (see shared-process test-home
 *  pinning gotchas). */
function defaultWigStatusPath(): string {
  return join(
    getKayaHome(), "skills", "Productivity", "LifeOS", "config", "wig_status.json",
  );
}

/** Read the current media WIG's targets from wig_status.json. Returns null if
 *  the file is missing, malformed, or no goal has a low_value target — the
 *  caller decides whether that absence is loud (Freshness prints a ⚠ note)
 *  or quiet (GoalsBlock treats it as "no media WIG this quarter"). */
export function readMediaWigTargets(path?: string): MediaWigTargets | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path ?? defaultWigStatusPath(), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  for (const [key, goal] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^G\d+$/.test(key) || typeof goal !== "object" || goal === null) continue;
    const targets = (goal as Record<string, unknown>).targets;
    if (typeof targets !== "object" || targets === null) continue;
    const t = targets as Record<string, { target_min_per_day?: unknown } | undefined>;
    const lowValue = t.low_value?.target_min_per_day;
    if (typeof lowValue !== "number") continue;
    const totalMedia = t.total_media_incl_youtube?.target_min_per_day;
    return {
      goalId: key,
      lowValue,
      totalMedia: typeof totalMedia === "number" ? totalMedia : null,
    };
  }
  return null;
}
