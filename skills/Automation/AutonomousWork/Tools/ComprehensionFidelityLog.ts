#!/usr/bin/env bun
/**
 * ComprehensionFidelityLog.ts — live ISC-extraction fidelity logger (pipeline-evals Slice 4).
 *
 * Appends a one-line summary of each LIVE comprehendSpec() extraction to
 * MEMORY/MONITORING/comprehension-parity.jsonl so the nightly
 * isc-extraction-fidelity monitor can score REAL extractions over time —
 * the live source the Slice-4 eval was waiting on.
 *
 * This mirrors the Slice-1 live source (TaskDB `export-dispositions`): the
 * deterministic SpecParser was deleted, so "parity" (comprehension-vs-parser)
 * is a misnomer — we log the live extraction's rowCount + rowDescriptions for
 * fidelity scoring, keeping the historical filename.
 *
 * CONTRACT: append-only, NON-FATAL. A logging failure must NEVER break spec
 * comprehension — every path returns a boolean and swallows its own errors.
 */

import { join } from "path";
import { createAppendLog, type AppendLog } from "../../../../lib/core/AppendLog.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

/** Max row descriptions persisted per record — mirrors the golden schema (≤ 8). */
export const MAX_DESCRIPTIONS = 8;

export interface ComprehensionFidelityRecord {
  /** WorkItem / spec identifier (e.g. item.id). */
  specId: string;
  /** Number of ISC rows the LLM extracted. */
  rowCount: number;
  /** Verbatim criterion text per row (truncated to MAX_DESCRIPTIONS on write). */
  rowDescriptions: string[];
  /** Complexity hint the comprehension returned, if any. */
  complexityHint?: string;
  /** True when the spec content was truncated before comprehension. */
  truncated?: boolean;
}

/** Resolve the live-source path under the active KAYA_HOME. */
export function resolveFidelityLogPath(): string {
  const kayaHome = getKayaHome();
  return join(kayaHome, "MEMORY", "MONITORING", "comprehension-parity.jsonl");
}

/** AppendLog instances keyed by resolved path — reused across calls, one per
 *  distinct path (tests pass many distinct override paths; the live path is
 *  a single recurring key). */
const fidelityLogs = new Map<string, AppendLog>();
function getFidelityLog(path: string): AppendLog {
  let log = fidelityLogs.get(path);
  if (!log) {
    log = createAppendLog(path);
    fidelityLogs.set(path, log);
  }
  return log;
}

/**
 * Append one fidelity record as a JSONL line. Returns true on success, false on
 * ANY failure (never throws — comprehension must not break because logging did).
 *
 * @param opts.ts   - ISO timestamp override (for deterministic tests).
 * @param opts.path - target file override (for tests); defaults to the live path.
 */
export function appendComprehensionFidelity(
  record: ComprehensionFidelityRecord,
  opts: { ts?: string; path?: string } = {}
): boolean {
  try {
    const path = opts.path ?? resolveFidelityLogPath();
    getFidelityLog(path).append({
      specId: record.specId,
      rowCount: record.rowCount,
      rowDescriptions: record.rowDescriptions.slice(0, MAX_DESCRIPTIONS),
      complexityHint: record.complexityHint ?? null,
      truncated: record.truncated ?? false,
      source: "comprehension-live",
      ts: opts.ts ?? new Date().toISOString(),
    });
    return true;
  } catch {
    return false;
  }
}
