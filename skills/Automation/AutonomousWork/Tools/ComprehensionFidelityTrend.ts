#!/usr/bin/env bun
/**
 * ComprehensionFidelityTrend.ts — trend reader for comprehension-parity.jsonl (L4).
 *
 * ComprehensionFidelityLog.ts (Slice 4) appends one JSONL line per LIVE
 * comprehendSpec() extraction so "the nightly isc-extraction-fidelity monitor
 * can score REAL extractions over time" (see that file's docstring). Nothing
 * turned the append-only stream into a human-readable trend — this does:
 * record/spec counts, rowCount avg/min/max, truncation rate, complexity-hint
 * breakdown, and the ts range covered.
 *
 * NON-FATAL by the same contract as the writer: malformed/blank lines are
 * skipped, a missing file degrades to an empty summary — never throws.
 *
 * Usage:
 *   bun run ComprehensionFidelityTrend.ts <path> [--json]
 *   bun run ComprehensionFidelityTrend.ts            # defaults to the live path
 */

import { readFileSync, existsSync } from "fs";
import { resolveFidelityLogPath, type ComprehensionFidelityRecord } from "./ComprehensionFidelityLog.ts";

type StoredRecord = ComprehensionFidelityRecord & { source?: string; ts?: string };

export interface ComprehensionTrendSummary {
  totalRecords: number;
  uniqueSpecs: number;
  firstTs: string | null;
  lastTs: string | null;
  avgRowCount: number;
  minRowCount: number;
  maxRowCount: number;
  truncatedRate: number;
  complexityBreakdown: Record<string, number>;
}

const EMPTY_SUMMARY: ComprehensionTrendSummary = {
  totalRecords: 0,
  uniqueSpecs: 0,
  firstTs: null,
  lastTs: null,
  avgRowCount: 0,
  minRowCount: 0,
  maxRowCount: 0,
  truncatedRate: 0,
  complexityBreakdown: {},
};

/** Aggregate already-parsed fidelity records into a trend summary. Never throws. */
export function computeTrend(records: StoredRecord[]): ComprehensionTrendSummary {
  if (records.length === 0) return { ...EMPTY_SUMMARY, complexityBreakdown: {} };

  const rowCounts = records.map((r) => r.rowCount);
  const specIds = new Set(records.map((r) => r.specId));
  const truncatedCount = records.filter((r) => r.truncated === true).length;
  const timestamps = records.map((r) => r.ts).filter((t): t is string => typeof t === "string").sort();

  const complexityBreakdown: Record<string, number> = {};
  for (const r of records) {
    const key = r.complexityHint ?? "unknown";
    complexityBreakdown[key] = (complexityBreakdown[key] ?? 0) + 1;
  }

  return {
    totalRecords: records.length,
    uniqueSpecs: specIds.size,
    firstTs: timestamps.length > 0 ? timestamps[0] : null,
    lastTs: timestamps.length > 0 ? timestamps[timestamps.length - 1] : null,
    avgRowCount: rowCounts.reduce((a, b) => a + b, 0) / rowCounts.length,
    minRowCount: Math.min(...rowCounts),
    maxRowCount: Math.max(...rowCounts),
    truncatedRate: truncatedCount / records.length,
    complexityBreakdown,
  };
}

/**
 * Read + parse a comprehension-parity.jsonl-shaped file and compute its trend.
 * NON-FATAL: a missing file, unreadable file, or malformed/blank lines never throw —
 * malformed lines are skipped; a missing file yields the empty summary.
 */
export function readTrend(path: string): ComprehensionTrendSummary {
  if (!existsSync(path)) return { ...EMPTY_SUMMARY, complexityBreakdown: {} };

  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return { ...EMPTY_SUMMARY, complexityBreakdown: {} };
  }

  const records: StoredRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as StoredRecord);
    } catch {
      // malformed line — skip, never throw (matches the writer's NON-FATAL contract)
    }
  }

  return computeTrend(records);
}

// ============================================================================
// CLI
// ============================================================================

function formatHuman(summary: ComprehensionTrendSummary, path: string): string {
  const lines = [
    `Comprehension fidelity trend — ${path}`,
    `Records: ${summary.totalRecords}  Unique specs: ${summary.uniqueSpecs}`,
    `Window: ${summary.firstTs ?? "n/a"} → ${summary.lastTs ?? "n/a"}`,
    `rowCount avg/min/max: ${summary.avgRowCount.toFixed(2)} / ${summary.minRowCount} / ${summary.maxRowCount}`,
    `Truncated: ${(summary.truncatedRate * 100).toFixed(1)}%`,
    `Complexity breakdown: ${Object.entries(summary.complexityBreakdown).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`,
  ];
  return lines.join("\n");
}

async function main() {
  const args = Bun.argv.slice(2);
  const asJson = args.includes("--json");
  const positional = args.find((a) => !a.startsWith("--"));
  const path = positional ?? resolveFidelityLogPath();

  const summary = readTrend(path);
  if (asJson) {
    console.log(JSON.stringify({ path, ...summary }, null, 2));
  } else {
    console.log(formatHuman(summary, path));
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
