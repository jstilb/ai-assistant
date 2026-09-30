#!/usr/bin/env bun
/**
 * Status.ts — `/youtube` (bare) and `/youtube status`.
 *
 * ZERO writes of any kind, zero browser/API calls — local reads only
 * (spec.md §12.4). Renders: declared intent + staleness lead line (>~30d),
 * WL count from the last snapshot (with date), ledger totals per surface,
 * held-for-review counts, and the last-run summary from state.
 *
 * No DPA/grant line anywhere — spec.md §9's build-time amendment drops DPA
 * from this skill entirely (Google DPA is region-blocked for Jm's US
 * account; ledger rows + manual Takeout are the whole archive story).
 *
 * A ledger read failure (e.g. events.db locked by the AppUsage pipeline) is
 * caught here and rendered as a loud, clearly-labeled line rather than
 * crashing the whole report — the rest of status (intent, WL snapshot,
 * state) is independent local file reads and should still render.
 */

import { readIntent } from "./IntentReader.ts";
import { readRunState } from "./RunStateReader.ts";
import { readLedgerTotals } from "./LedgerReader.ts";
import { readWlSnapshotCount } from "./SnapshotReader.ts";

const STALE_INTENT_DAYS = 30;

export interface StatusOverrides {
  intentPath?: string;
  statePath?: string;
  dbPath?: string;
  fallbackSnapshotPath?: string;
  /** Injectable clock for staleness-window tests. Defaults to `new Date()`. */
  now?: Date;
}

function daysSince(iso: string, now: Date): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

/** Pure composition — reads local sources only, never writes. Exported (not
 *  just run via main()) so tests can drive it hermetically with explicit
 *  path overrides instead of touching the live tree. */
export async function buildStatusReport(overrides: StatusOverrides = {}): Promise<string[]> {
  const now = overrides.now ?? new Date();
  const lines: string[] = [];
  lines.push("YouTube curation — status");
  lines.push("");

  // Intent
  const { intent, note: intentNote } = readIntent(overrides.intentPath);
  if (intent) {
    const age = daysSince(intent.declaredAt, now);
    if (age !== null && age > STALE_INTENT_DAYS) {
      const weeks = Math.floor(age / 7);
      lines.push(`⚠ intent is ${weeks} week${weeks === 1 ? "" : "s"} old (declared ${intent.declaredAt}) — still current?`);
    }
    lines.push(`Intent: ${intent.topics.join(", ")} (declared ${intent.declaredAt})`);
  } else {
    lines.push(`Intent: ${intentNote ?? "no intent declared"} — declare one with \`/youtube steer <what you want to see more of>\``);
  }
  lines.push("");

  // Run state (read once, feeds both the WL-snapshot pointer and the
  // held/last-run sections below).
  const { state, note: stateNote } = readRunState(overrides.statePath);

  // WL snapshot
  const snap = readWlSnapshotCount(state.wlSnapshot, overrides.fallbackSnapshotPath);
  if (snap.count !== null) {
    const provenance = snap.source === "ticket-07-fallback"
      ? ", ticket-07 asset — no wl run has captured a fresher one yet"
      : "";
    lines.push(`Watch Later: ${snap.count} items (snapshot ${snap.capturedAt}${provenance})`);
  } else {
    lines.push(`Watch Later: unknown — ${snap.note}`);
  }
  lines.push("");

  // Ledger totals — fail loud but don't crash the rest of the report.
  try {
    const { totals, note: ledgerNote } = await readLedgerTotals(overrides.dbPath);
    lines.push(`Ledger totals — history: ${totals.history} deleted, watch_later: ${totals.watch_later} pruned`);
    if (ledgerNote) lines.push(`  (${ledgerNote})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lines.push(`Ledger totals — READ FAILED (fail-loud, not silently retried): ${message}`);
  }
  lines.push("");

  // Held-for-review
  const heldHistory = state.held.history.length;
  const heldWl = state.held.watch_later.length;
  if (heldHistory > 0 || heldWl > 0) {
    lines.push(`Held for review: ${heldHistory} history, ${heldWl} watch_later (from a prior run — bulk-approve next run)`);
    lines.push("");
  }

  // Last run
  if (state.lastRun) {
    lines.push(`Last run: ${state.lastRun.mode} at ${state.lastRun.at} — ${state.lastRun.summary}`);
  } else {
    lines.push(`Last run: ${stateNote ?? "none yet"}`);
  }

  return lines;
}

async function main(): Promise<void> {
  const lines = await buildStatusReport();
  console.log(lines.join("\n"));
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
