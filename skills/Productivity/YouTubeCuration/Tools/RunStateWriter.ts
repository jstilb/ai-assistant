#!/usr/bin/env bun
/**
 * RunStateWriter.ts — write `MEMORY/State/youtube-curation.json`.
 *
 * A CONVENIENCE CACHE, not ground truth (RunStateReader.ts's header, spec.md
 * §2) — losing this file must stay safe. This writer never throws on a
 * missing/corrupt EXISTING file either: it reads through `readRunState()`
 * (which already degrades safely) before merging, so a corrupt state file
 * self-heals on the very next write instead of blocking every future run.
 *
 * MERGE SEMANTICS: an update is a PARTIAL patch, per top-level field —
 * `held.history`, `held.watch_later`, `lastRun`, `wlSnapshot`, and
 * `somedayPlaylist` are each either replaced whole (when present in the
 * update) or left exactly as they were (when omitted). This is what lets a
 * `prune` run replace ONLY `held.history` with this run's fresh judgments
 * while a prior `wl` run's `held.watch_later` list, `wlSnapshot` pointer, and
 * `somedayPlaylist` cache survive untouched — a run only ever re-judges the
 * surface it actually looked at.
 *
 * Schema compatibility with the read side is enforced by CODE reuse, not
 * convention: this file imports `HeldItem`/`LastRunSummary`/
 * `WlSnapshotPointer`/`SomedayPlaylistPointer` and their exact
 * shape-validators (`isHeldItem`/`readHeldList`/`readLastRun`/
 * `readWlSnapshot`/`readSomedayPlaylist`) straight from RunStateReader.ts, so
 * the writer can never accept a shape the reader wouldn't also accept back.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  defaultRunStatePath,
  type HeldItem,
  isHeldItem,
  type LastRunSummary,
  readHeldList,
  readLastRun,
  readRunState,
  readSomedayPlaylist,
  readSteerRunDetail,
  readWlSnapshot,
  type SomedayPlaylistPointer,
  type SteerRunDetail,
  type WlSnapshotPointer,
  type YouTubeCurationState,
} from "./RunStateReader.ts";

export interface RunStateUpdate {
  held?: {
    history?: HeldItem[];
    watch_later?: HeldItem[];
  };
  lastRun?: LastRunSummary;
  wlSnapshot?: WlSnapshotPointer;
  somedayPlaylist?: SomedayPlaylistPointer;
  lastSteerDetail?: SteerRunDetail;
}

export interface WriteRunStateOptions {
  /** Overrides the resolved write path — tests pass a mkdtemp path here, never the live tree. */
  path?: string;
}

function validateHeldList(list: unknown, label: string): HeldItem[] {
  if (!Array.isArray(list)) {
    throw new Error(`RunStateWriter: held.${label} must be an array`);
  }
  const invalid = list.filter((item) => !isHeldItem(item));
  if (invalid.length > 0) {
    throw new Error(
      `RunStateWriter: held.${label} contains ${invalid.length} item(s) not shaped like a HeldItem ` +
        `({ videoId: string, reason: string, title?: string })`,
    );
  }
  return readHeldList(list);
}

/**
 * Merge `update` over the existing state and write it back. Reads the
 * existing file through `readRunState()` first (never throws — degrades to
 * empty defaults on a missing/corrupt file), so a partial update never
 * requires the caller to know the full prior state.
 *
 * A malformed `update.lastRun`/`update.wlSnapshot` (present but not shaped
 * right) THROWS rather than silently falling back to the prior value — a
 * caller that passes garbage must find out immediately, not have it quietly
 * swallowed and the old value kept as if nothing happened.
 */
export function writeRunState(update: RunStateUpdate, options: WriteRunStateOptions = {}): YouTubeCurationState {
  const statePath = options.path ?? defaultRunStatePath();
  const { state: existing } = readRunState(statePath);

  let lastRun = existing.lastRun;
  if (update.lastRun !== undefined) {
    const validated = readLastRun(update.lastRun);
    if (!validated) {
      throw new Error(
        "RunStateWriter: lastRun is not shaped like a LastRunSummary " +
          '({ mode: "prune"|"steer"|"wl"|"status", runId: string, at: string, summary: string })',
      );
    }
    lastRun = validated;
  }

  let wlSnapshot = existing.wlSnapshot;
  if (update.wlSnapshot !== undefined) {
    const validated = readWlSnapshot(update.wlSnapshot);
    if (!validated) {
      throw new Error(
        "RunStateWriter: wlSnapshot is not shaped like a WlSnapshotPointer " +
          "({ path: string, capturedAt: string, count: number })",
      );
    }
    wlSnapshot = validated;
  }

  let somedayPlaylist = existing.somedayPlaylist;
  if (update.somedayPlaylist !== undefined) {
    const validated = readSomedayPlaylist(update.somedayPlaylist);
    if (!validated) {
      throw new Error(
        "RunStateWriter: somedayPlaylist is not shaped like a SomedayPlaylistPointer " +
          "({ id: string, title: string })",
      );
    }
    somedayPlaylist = validated;
  }

  let lastSteerDetail = existing.lastSteerDetail;
  if (update.lastSteerDetail !== undefined) {
    const validated = readSteerRunDetail(update.lastSteerDetail);
    if (!validated) {
      throw new Error(
        "RunStateWriter: lastSteerDetail is not shaped like a SteerRunDetail " +
          "({ runId, at, topics: SteerTopicResult[], sweepActionCount, searchesRun, droppedTopicCleanups: SteerDroppedTopicCleanup[], subjectiveCheckIn })",
      );
    }
    lastSteerDetail = validated;
  }

  const next: YouTubeCurationState = {
    held: {
      history: update.held?.history !== undefined ? validateHeldList(update.held.history, "history") : existing.held.history,
      watch_later:
        update.held?.watch_later !== undefined
          ? validateHeldList(update.held.watch_later, "watch_later")
          : existing.held.watch_later,
    },
    lastRun,
    wlSnapshot,
    somedayPlaylist,
    lastSteerDetail,
  };

  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(next, null, 2), "utf8");
  return next;
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
  const raw = argv[0];
  if (!raw || raw.startsWith("--")) {
    console.error(
      "Usage: bun RunStateWriter.ts '<JSON update — e.g. {\"held\":{\"history\":[{\"videoId\":\"v1\",\"reason\":\"unsure\"}]},\"lastRun\":{\"mode\":\"prune\",\"runId\":\"run-1\",\"at\":\"2026-08-12T00:00:00Z\",\"summary\":\"5 deleted, 1 held\"}}>' [--path <path>]",
    );
    process.exit(1);
  }
  // Overrides defaultRunStatePath(), which resolves through getKayaHome() —
  // in a worktree session that still has KAYA_HOME/KAYA_DIR pointed at the
  // LIVE tree (the common case: only DB/state PATHS are meant to be
  // isolated per-test, not the whole env), that default is the LIVE
  // MEMORY/State/youtube-curation.json. Same rationale as LedgerWriter.ts's
  // `--db-path`/ReconcileRun.ts's `--db-path`: real `/youtube` runs omit
  // this; every test/demo against a throwaway state file must pass it.
  const path = flag(argv, "--path");

  const update = JSON.parse(raw) as RunStateUpdate;
  const state = writeRunState(update, path ? { path } : {});
  console.log(JSON.stringify(state, null, 2));
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
