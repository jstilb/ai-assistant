#!/usr/bin/env bun
/**
 * EstimationCapture — append new estimate-vs-actual pairs from LucidTasks to
 * MEMORY/LEARNING/SIGNALS/estimation-accuracy.jsonl and report the ledger's
 * current median ratio.
 *
 * Successor to hooks/EstimationAccuracyCapture.hook.ts (SessionEnd hook,
 * unregistered long before it was deleted 2026-07-03 in 85e1a288c).
 * Differences by design:
 *   - Invoked manually (the weekly learning-weekly-digest cron that ran it
 *     was deleted 2026-09-30), not per-session — batch capture needs no hook
 *     latency budget.
 *   - Dedups against the ledger itself via a title:estimated:actual composite
 *     key, so no tracker state file is needed (MEMORY/State/
 *     estimation-tracker.json was retired with the old hook).
 *   - LucidTasks only: WorkQueue items no longer carry estimatedMinutes (the
 *     field was removed in the AutonomousWork overhaul; pipeline.db has no
 *     estimate column), so the old hook's second source is gone.
 *
 * The printed summary is what refreshes the numbers in
 * MEMORY/WISDOM/FRAMES/estimation-calibration.md — by hand since the weekly
 * digest agent that did it was deleted 2026-09-30.
 * `lucidtasks stats` remains the live, DB-scoped view of the same data.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { createAppendLog } from "../../../../lib/core/AppendLog.ts";

const SIGNAL_FILE = join(getKayaHome(), "MEMORY", "LEARNING", "SIGNALS", "estimation-accuracy.jsonl");

export interface EstimationSignal {
  timestamp: string;
  taskTitle: string;
  estimatedMinutes: number;
  actualMinutes: number;
  /** estimated/actual — >1 means the estimate was high (overestimate). */
  ratio: number;
  source: "lucidtasks";
}

/** Composite dedup key — same scheme the old hook used for LucidTasks rows. */
export function dedupKey(row: { taskTitle: string; estimatedMinutes: number; actualMinutes: number }): string {
  return `${row.taskTitle}:${row.estimatedMinutes}:${row.actualMinutes}`;
}

/** Parse existing ledger rows; malformed lines are skipped. */
export function readLedgerRows(filePath: string): EstimationSignal[] {
  if (!existsSync(filePath)) return [];
  const rows: EstimationSignal[] = [];
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as EstimationSignal;
      if (typeof parsed.taskTitle === "string" && typeof parsed.ratio === "number") rows.push(parsed);
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}

/** Build signals for tasks not already in the ledger. */
export function newSignalsFrom(
  tasks: Array<{ title: string; estimated_minutes: number; actual_minutes: number; ratio: number }>,
  seen: Set<string>,
  nowIso: string,
): EstimationSignal[] {
  const signals: EstimationSignal[] = [];
  for (const task of tasks) {
    const signal: EstimationSignal = {
      timestamp: nowIso,
      taskTitle: task.title,
      estimatedMinutes: task.estimated_minutes,
      actualMinutes: task.actual_minutes,
      ratio: task.ratio,
      source: "lucidtasks",
    };
    const key = dedupKey(signal);
    if (seen.has(key)) continue;
    seen.add(key);
    signals.push(signal);
  }
  return signals;
}

/** Median of the given ratios, rounded to 2 decimals; 0 for an empty list. */
export function medianRatio(ratios: number[]): number {
  if (ratios.length === 0) return 0;
  const sorted = [...ratios].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(median * 100) / 100;
}

async function main(): Promise<void> {
  const existing = readLedgerRows(SIGNAL_FILE);
  const seen = new Set(existing.map(dedupKey));

  // Dynamic import so importing this module (e.g. from tests) never touches
  // the live LucidTasks SQLite DB.
  // cross-skill-allowed: LucidTasks' TaskDB is the sole remaining source of estimate-vs-actual pairs; a lib seam for one weekly read fails the deletion test
  const { getTaskDB } = await import("../../LucidTasks/Tools/TaskDB.ts");
  const db = getTaskDB();
  let tasks: Array<{ title: string; estimated_minutes: number; actual_minutes: number; ratio: number }>;
  try {
    tasks = db.getEstimateAccuracy().tasks;
  } finally {
    db.close();
  }

  const fresh = newSignalsFrom(tasks, seen, new Date().toISOString());
  if (fresh.length > 0) {
    const log = createAppendLog(SIGNAL_FILE);
    for (const signal of fresh) log.append(signal);
  }

  const allRows = [...existing, ...fresh];
  console.log(JSON.stringify({
    appended: fresh.length,
    totalRows: allRows.length,
    medianRatio: medianRatio(allRows.map(r => r.ratio)),
    asOf: new Date().toISOString(),
    ledger: SIGNAL_FILE,
  }, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[EstimationCapture] failed: ${err}`);
    process.exit(1);
  });
}
