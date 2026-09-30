#!/usr/bin/env bun
/**
 * RunStateReader.ts — read `MEMORY/State/youtube-curation.json`.
 *
 * A CONVENIENCE CACHE, not ground truth (events.db's `youtube_deletions`
 * ledger and the WL snapshot files are — spec.md §2). Holds: held-for-review
 * items per surface (with reasons), last-run summary, and a pointer to the
 * most recent WL snapshot (written by a future `wl` run). Losing this file
 * must degrade safely: held items are simply re-judged next run, so a
 * missing/corrupt file returns empty defaults instead of throwing.
 *
 * No DPA fields (`archiveJobId`, last-landed-export date) — the spec.md §9
 * build-time amendment permanently drops DPA from this skill.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

export interface HeldItem {
  videoId: string;
  title?: string;
  reason: string;
}

export interface LastRunSummary {
  mode: "prune" | "steer" | "wl" | "status";
  runId: string;
  /** ISO timestamp. */
  at: string;
  /** One-line human summary, e.g. "5 deleted, 2 held". */
  summary: string;
}

export interface WlSnapshotPointer {
  /** Absolute path to the snapshot JSON asset. */
  path: string;
  /** Date portion, e.g. "2026-08-09". */
  capturedAt: string;
  count: number;
}

/**
 * A cached pointer to the ONE Kaya-managed Someday playlist's YouTube id
 * (spec.md §8; slice 5's `wl` someday-verdict routing). A CONVENIENCE
 * CACHE, same doctrine as `wlSnapshot` and this whole file: losing it is
 * safe by construction — `Tools/PlaylistClient.ts`'s `ensureSomedayPlaylist()`
 * always re-validates a cached id against a live API read before trusting
 * it, and falls back to an exact-title search (never a blind create) when
 * the cache is stale/missing, so a lost pointer costs one extra paginated
 * list call, never a duplicate playlist.
 */
export interface SomedayPlaylistPointer {
  id: string;
  /** As it was titled at cache time — `ensureSomedayPlaylist()` treats a title mismatch on re-validation as "stale," not "found." */
  title: string;
}

/**
 * A per-topic top-up summary within one steer run's detail (spec.md §7.1,
 * §11 — the build's requirement to record "per-topic playlist adds"
 * alongside the generic one-line `lastRun.summary`).
 */
export interface SteerTopicResult {
  topic: string;
  playlistId: string;
  playlistTitle: string;
  /** True only when this run's top-up created the playlist (didn't already exist). */
  created: boolean;
  /** How many unwatched items the playlist already had before this run's adds. */
  existingUnwatchedCount: number;
  /** Video ids confirmed added this run (verified-state-change counting — spec.md §10). */
  added: string[];
}

/**
 * One dropped-topic playlist cleanup within a steer run (spec.md §7.4) —
 * `itemVideoIds` is the log captured BEFORE delete (DroppedTopicCleanup.ts's
 * structural log-then-delete ordering); no `youtube_deletions` ledger row
 * exists for these (Kaya-created artifacts, not Jm's data).
 */
export interface SteerDroppedTopicCleanup {
  topic: string;
  playlistId: string;
  playlistTitle: string;
  itemVideoIds: string[];
  deleted: boolean;
}

/**
 * The richer structured record of a single steer run's seeding pass (spec.md
 * §7, §11) — a CONVENIENCE CACHE like every other field on this state file,
 * feeding future `status`/report rendering. Distinct from the generic
 * `lastRun.summary` one-liner every mode writes (that one stays for
 * cross-mode consistency); this is steer-specific detail spec.md §11
 * requires be recorded: per-topic playlist adds, sweep action count,
 * searches run, dropped-topic cleanups with their logged items, and the
 * subjective check-in answer (v1's only evaluation loop — ticket 06 pt 6).
 */
export interface SteerRunDetail {
  runId: string;
  /** ISO timestamp. */
  at: string;
  topics: SteerTopicResult[];
  /** Verified-state-change home-feed sweep actions this run (spec.md §7.2; NO ledger rows — sweep clicks destroy nothing). */
  sweepActionCount: number;
  /** Seeded searches run this pass (1-2 per topic — ticket 06 pt 3). */
  searchesRun: number;
  droppedTopicCleanups: SteerDroppedTopicCleanup[];
  /** Jm's answer to "has the homepage felt better?" — null until asked/answered this run. */
  subjectiveCheckIn: string | null;
}

export interface YouTubeCurationState {
  held: {
    history: HeldItem[];
    watch_later: HeldItem[];
  };
  lastRun: LastRunSummary | null;
  wlSnapshot: WlSnapshotPointer | null;
  somedayPlaylist: SomedayPlaylistPointer | null;
  lastSteerDetail: SteerRunDetail | null;
}

export interface RunStateReadResult {
  state: YouTubeCurationState;
  /** Present when the file was missing/corrupt/partial and defaults were substituted for at least one field. */
  note: string | null;
}

const EMPTY_STATE: YouTubeCurationState = {
  held: { history: [], watch_later: [] },
  lastRun: null,
  wlSnapshot: null,
  somedayPlaylist: null,
  lastSteerDetail: null,
};

/** Resolved per call, not module-level — see IntentReader.ts's identical note. */
export function defaultRunStatePath(): string {
  return join(getKayaHome(), "MEMORY", "State", "youtube-curation.json");
}

const MODES = new Set(["prune", "steer", "wl", "status"]);

// Exported so RunStateWriter.ts validates its own write input against the
// exact same shape this reader accepts — one definition of "valid held
// item / lastRun / wlSnapshot", not two that can drift apart.
export function isHeldItem(v: unknown): v is HeldItem {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.videoId === "string"
    && typeof o.reason === "string"
    && (o.title === undefined || typeof o.title === "string");
}

export function readHeldList(v: unknown): HeldItem[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isHeldItem);
}

export function readLastRun(v: unknown): LastRunSummary | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (
    typeof o.mode === "string" && MODES.has(o.mode)
    && typeof o.runId === "string"
    && typeof o.at === "string"
    && typeof o.summary === "string"
  ) {
    return { mode: o.mode as LastRunSummary["mode"], runId: o.runId, at: o.at, summary: o.summary };
  }
  return null;
}

export function readWlSnapshot(v: unknown): WlSnapshotPointer | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path === "string" && typeof o.capturedAt === "string" && typeof o.count === "number") {
    return { path: o.path, capturedAt: o.capturedAt, count: o.count };
  }
  return null;
}

// Exported so RunStateWriter.ts validates against the exact same shape this
// reader accepts — same one-definition discipline as readWlSnapshot/readLastRun.
export function readSomedayPlaylist(v: unknown): SomedayPlaylistPointer | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id === "string" && o.id.length > 0 && typeof o.title === "string") {
    return { id: o.id, title: o.title };
  }
  return null;
}

function isSteerTopicResult(v: unknown): v is SteerTopicResult {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.topic === "string"
    && typeof o.playlistId === "string"
    && typeof o.playlistTitle === "string"
    && typeof o.created === "boolean"
    && typeof o.existingUnwatchedCount === "number"
    && Array.isArray(o.added) && o.added.every((x) => typeof x === "string")
  );
}

function isSteerDroppedTopicCleanup(v: unknown): v is SteerDroppedTopicCleanup {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.topic === "string"
    && typeof o.playlistId === "string"
    && typeof o.playlistTitle === "string"
    && Array.isArray(o.itemVideoIds) && o.itemVideoIds.every((x) => typeof x === "string")
    && typeof o.deleted === "boolean"
  );
}

// Exported so RunStateWriter.ts validates against the exact same shape this
// reader accepts — same one-definition discipline as the other read*() helpers.
export function readSteerRunDetail(v: unknown): SteerRunDetail | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (
    typeof o.runId === "string"
    && typeof o.at === "string"
    && Array.isArray(o.topics) && o.topics.every(isSteerTopicResult)
    && typeof o.sweepActionCount === "number"
    && typeof o.searchesRun === "number"
    && Array.isArray(o.droppedTopicCleanups) && o.droppedTopicCleanups.every(isSteerDroppedTopicCleanup)
    && (o.subjectiveCheckIn === null || typeof o.subjectiveCheckIn === "string")
  ) {
    return {
      runId: o.runId,
      at: o.at,
      topics: o.topics as SteerTopicResult[],
      sweepActionCount: o.sweepActionCount,
      searchesRun: o.searchesRun,
      droppedTopicCleanups: o.droppedTopicCleanups as SteerDroppedTopicCleanup[],
      subjectiveCheckIn: (o.subjectiveCheckIn as string | null) ?? null,
    };
  }
  return null;
}

/**
 * Read + validate `MEMORY/State/youtube-curation.json`. Never throws —
 * degrades to empty defaults on any missing/malformed/partial input.
 */
export function readRunState(path?: string): RunStateReadResult {
  const statePath = path ?? defaultRunStatePath();
  if (!existsSync(statePath)) {
    return { state: EMPTY_STATE, note: "no run state yet — this will be the first /youtube run" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return {
      state: EMPTY_STATE,
      note: "youtube-curation.json is malformed — treating as no state (convenience cache only, not ground truth)",
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return {
      state: EMPTY_STATE,
      note: "youtube-curation.json is malformed — treating as no state (convenience cache only, not ground truth)",
    };
  }

  const obj = parsed as Record<string, unknown>;
  const heldObj = typeof obj.held === "object" && obj.held !== null ? obj.held as Record<string, unknown> : {};

  const state: YouTubeCurationState = {
    held: {
      history: readHeldList(heldObj.history),
      watch_later: readHeldList(heldObj.watch_later),
    },
    lastRun: readLastRun(obj.lastRun),
    wlSnapshot: readWlSnapshot(obj.wlSnapshot),
    somedayPlaylist: readSomedayPlaylist(obj.somedayPlaylist),
    lastSteerDetail: readSteerRunDetail(obj.lastSteerDetail),
  };

  return { state, note: null };
}
