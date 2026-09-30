#!/usr/bin/env bun
/**
 * SnapshotReader.ts — last Watch Later snapshot count + date.
 *
 * Today the only snapshot in existence is the ticket-07 asset
 * (`.scratch/youtube-curation/assets/wl-snapshot-2026-08-09.json`), captured
 * as a one-off read-only proof run. A future `wl` run will write a fresher
 * pointer into the run-state file (`RunStateReader.ts`'s `wlSnapshot` field)
 * — that pointer is preferred when present and its file still exists; this
 * reader falls back to the ticket-07 asset otherwise.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import type { WlSnapshotPointer } from "./RunStateReader.ts";

export type WlSnapshotSource = "state-pointer" | "ticket-07-fallback" | "none";

export interface WlSnapshotResult {
  count: number | null;
  /** Date portion, e.g. "2026-08-09". */
  capturedAt: string | null;
  source: WlSnapshotSource;
  note: string | null;
}

/**
 * The directory every WL snapshot file lives in — the ticket-07 asset
 * AND every snapshot a future `wl` run writes (`WlSnapshotWriter.ts`).
 * Exported so the writer never hardcodes a second copy of this path; both
 * sides of the snapshot lifecycle resolve the same directory through the
 * same function.
 */
export function wlSnapshotDir(): string {
  return join(getKayaHome(), ".scratch", "youtube-curation", "assets");
}

/** Resolved per call, not module-level — see IntentReader.ts's identical note. */
export function defaultFallbackSnapshotPath(): string {
  return join(wlSnapshotDir(), "wl-snapshot-2026-08-09.json");
}

interface SnapshotFileShape {
  items: unknown[];
  captured_at: string;
}

function isSnapshotFileShape(v: unknown): v is SnapshotFileShape {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.items) && typeof o.captured_at === "string";
}

function readFallbackFile(path: string): WlSnapshotResult {
  if (!existsSync(path)) {
    return {
      count: null,
      capturedAt: null,
      source: "none",
      note: "no WL snapshot found — run `/youtube wl` from the claude-browser session to capture one",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { count: null, capturedAt: null, source: "none", note: "WL snapshot file is malformed" };
  }
  if (!isSnapshotFileShape(parsed)) {
    return { count: null, capturedAt: null, source: "none", note: "WL snapshot file is missing items/captured_at" };
  }
  return {
    count: parsed.items.length,
    capturedAt: parsed.captured_at.slice(0, 10),
    source: "ticket-07-fallback",
    note: null,
  };
}

/**
 * Resolve the last WL snapshot's item count + capture date. Prefers a
 * state-file pointer (when given and its file still exists) over the
 * ticket-07 fallback asset. Never throws — degrades to `{ count: null,
 * source: "none" }` on any missing/malformed input.
 */
export function readWlSnapshotCount(
  statePointer: WlSnapshotPointer | null,
  fallbackPath?: string,
): WlSnapshotResult {
  if (statePointer && existsSync(statePointer.path)) {
    return { count: statePointer.count, capturedAt: statePointer.capturedAt, source: "state-pointer", note: null };
  }
  return readFallbackFile(fallbackPath ?? defaultFallbackSnapshotPath());
}
