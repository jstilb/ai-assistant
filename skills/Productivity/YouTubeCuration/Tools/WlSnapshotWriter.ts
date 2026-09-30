#!/usr/bin/env bun
/**
 * WlSnapshotWriter.ts — write a fresh Watch Later snapshot after a `wl` run
 * scrapes the playlist (spec.md §8, SKILL.md's `wl` runbook step 2/7).
 *
 * File shape and location are DELIBERATELY identical to ticket 07's proven
 * asset (`.scratch/youtube-curation/assets/wl-snapshot-2026-08-09.json` —
 * see `.scratch/youtube-curation/assets/07-snapshot-runbook.md`'s output
 * contract): `{ captured_at, engine, header_count, complete, items[] }`,
 * written into `SnapshotReader.ts`'s `wlSnapshotDir()` (the SAME directory
 * function `SnapshotReader.ts`'s fallback path already resolves through —
 * not a hardcoded second copy of that path). Two consequences of matching
 * the ticket-07 shape exactly:
 *   1. `.scratch/youtube-curation/assets/SummarizeSnapshot.ts` (built for
 *      ticket 07) can summarize every future `wl` run's snapshot without
 *      modification.
 *   2. `SnapshotReader.ts`'s fallback-file reader (`readFallbackFile()`)
 *      already knows how to parse this shape — no reader-side change needed.
 *
 * After writing the file, updates `MEMORY/State/youtube-curation.json`'s
 * `wlSnapshot` pointer via `RunStateWriter.ts` (partial-patch merge — every
 * other state field, including `held.*` and `somedayPlaylist`, is left
 * untouched). This is what lets `SnapshotReader.ts`'s "prefer the state
 * pointer, fall back to the ticket-07 asset" logic pick up the fresh
 * snapshot on the very next `status`/`wl` run.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wlSnapshotDir } from "./SnapshotReader.ts";
import { writeRunState } from "./RunStateWriter.ts";

/** Same field shape as ticket-07's `wl-snapshot-<date>.json` items (07-snapshot-runbook.md's output contract) — kept identical so SummarizeSnapshot.ts and SnapshotReader.ts need no changes to read a `wl`-run-written file. */
export interface WlSnapshotItem {
  position: number;
  video_id: string | null;
  title: string | null;
  channel: string | null;
  channel_url: string | null;
  duration: string | null;
  progress_pct: number | null;
}

export interface WriteWlSnapshotInput {
  items: WlSnapshotItem[];
  /** The "N videos" header count read from the WL page; null if the header showed none. */
  headerCount: number | null;
  /** True only when `items.length === headerCount` — mirrors ticket-07's assert-before-write discipline (§3 of the runbook): a mismatch after retries still gets written, just flagged `false`, never silently dropped. */
  complete: boolean;
}

export interface WriteWlSnapshotOptions {
  /** Overrides the resolved snapshot directory — tests pass an mkdtemp dir, never the live `.scratch/youtube-curation/assets`. */
  dir?: string;
  /** Overrides the resolved run-state path, passed straight through to `writeRunState()` — tests pass an mkdtemp path, never the live tree. */
  statePath?: string;
  /** Injectable clock for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
}

export interface WriteWlSnapshotResult {
  /** Absolute path to the written snapshot JSON. */
  path: string;
  /** Date portion of captured_at, e.g. "2026-08-12" — matches `WlSnapshotPointer.capturedAt`'s format. */
  capturedAt: string;
  count: number;
}

/**
 * Write `wl-snapshot-<date>.json` and update the run-state `wlSnapshot`
 * pointer to it in one call. Pure side effects, no verdict logic — this
 * module only persists what was already scraped; the SKILL.md runbook
 * decides what to do with each item via Rubric.md §Watch Later.
 */
export function writeWlSnapshot(
  input: WriteWlSnapshotInput,
  options: WriteWlSnapshotOptions = {},
): WriteWlSnapshotResult {
  const now = options.now ?? new Date();
  const capturedAtIso = now.toISOString();
  const dateOnly = capturedAtIso.slice(0, 10);

  const dir = options.dir ?? wlSnapshotDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `wl-snapshot-${dateOnly}.json`);

  const fileContent = {
    captured_at: capturedAtIso,
    engine: "claude-in-chrome",
    header_count: input.headerCount,
    complete: input.complete,
    items: input.items,
  };
  writeFileSync(path, JSON.stringify(fileContent, null, 2), "utf8");

  writeRunState(
    { wlSnapshot: { path, capturedAt: dateOnly, count: input.items.length } },
    options.statePath ? { path: options.statePath } : {},
  );

  return { path, capturedAt: dateOnly, count: input.items.length };
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const itemsRaw = argv[0];
  if (!itemsRaw || itemsRaw.startsWith("--")) {
    console.error(
      "Usage: bun WlSnapshotWriter.ts '<items JSON array>' [--header-count N] [--incomplete] " +
        "[--dir <path>] [--state-path <path>]",
    );
    process.exit(1);
  }

  const items = JSON.parse(itemsRaw) as WlSnapshotItem[];
  const headerCountRaw = flag(argv, "--header-count");
  const headerCount = headerCountRaw !== undefined ? Number(headerCountRaw) : null;
  const complete = !argv.includes("--incomplete");
  const dir = flag(argv, "--dir");
  const statePath = flag(argv, "--state-path");

  const result = writeWlSnapshot(
    { items, headerCount, complete },
    { ...(dir ? { dir } : {}), ...(statePath ? { statePath } : {}) },
  );
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
