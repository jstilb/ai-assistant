#!/usr/bin/env bun
/**
 * executorMerge.ts — Lane A auto-merge (slice F2).
 *
 * Today (post-F1) a verified ("pass") Lane A deliverable still just sits as a "merge when
 * approved" comment on a waiting task forever (the 17-tasks/138-days problem this slice fixes).
 * This module adds the auto-merge DECISION + EXECUTION for a verdict==="pass" delivery, while
 * leaving fail/uncertain/skipped-infra untouched (exactly today's F1 waiting+comment behavior).
 *
 * Design (single orchestration entry point, `runAutoMerge`, mirrors executorVerify.ts's
 * `runVerification` shape — one function, one deps bag, every side effect injectable):
 *
 *   1. verdict !== "pass"                 → { kind: "skipped" }, no side effects at all.
 *   2. interactive session lock is live   → { kind: "deferred" }, writes a STRUCTURED
 *      `MERGE_DEFERRED: {branch, wtPath, verdict, summary, ts}` marker comment (human-readable
 *      text follows the JSON on the next lines — see formatMergeDeferredComment), task status
 *      untouched (stays re-engageable — the caller still runs today's normal deliverTask()
 *      waiting+comment path). The marker is what lets executor.ts's poll()-time pending-merge
 *      sweep (F2 fix round) find and retry this exact merge once the lock clears, without
 *      re-running the builder — see executor.ts's sweepPendingMerges docstring.
 *   3. otherwise: run `bin/merge-to-main.sh <branch> <repoRoot>` from repoRoot (NEVER a
 *      worktree — a known failure mode syncs the wrong tree), then POST-MERGE DISK
 *      VERIFICATION, SCOPED to this merge only (`git diff --stat HEAD -- <changed files>`
 *      empty AND the merged branch is an ancestor of main via
 *      `git merge-base --is-ancestor <branch> main` — see defaultVerifyDisk's docstring for why
 *      this replaced an earlier repo-GLOBAL `git log --all --not main` sweep, which
 *      false-positived on every unrelated in-flight branch elsewhere in the repo):
 *        - merge script exits non-zero      → recordFailure, MERGE_FAILED comment,
 *          { kind: "merge-failed" }, task NOT marked done (falls back to the human path).
 *        - disk verification is not clean   → recordFailure, MERGE_FAILED comment,
 *          { kind: "verify-failed" }, task NOT marked done (same fallback).
 *        - both clean                       → mergeTask() (status done + comment naming
 *          branch/sha), markWorktreeMerged(wtPath), notify() AFTER the fact (Telegram, plain
 *          send, title + sha, no keyboard), append a lane-a-merged cross-ref event carrying the
 *          sha, { kind: "merged", sha }.
 *
 * Callers (executor.ts's runTask): call this ONLY when there IS a real verify verdict
 * (hasChanges && not infra-skipped). On any outcome other than "merged", runTask proceeds to
 * its normal deliverTask() call unchanged — this module never blocks or replaces that path
 * except on a clean, verified, fully-merged success. executor.ts's poll() ALSO calls this
 * (via sweepPendingMerges) to retry a previously-deferred merge — never to (re)run the builder.
 *
 * Lane A cross-ref events (`appendLaneAEvent`) give the shared pipeline_events audit trail
 * visibility into Lane A activity WITHOUT a pipeline_items row (see
 * PipelineRepository.appendCrossRefEvent's JSDoc for why this is safe / by-design invisible to
 * PipelineIntegrity's guard-bypass detector). Best-effort by convention: every call site wraps
 * failures in recordFailure() and never lets an event-write failure block the executor.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

import { getKayaHome } from "../../../../../lib/core/KayaHome.ts";
import { recordFailure } from "../../../../../lib/core/FailureLog.ts";
import { notify as realNotify } from "../../../../../lib/core/NotificationService.ts";
import { markWorktreeMerged as realMarkWorktreeMerged, gcWorktreeForBranch } from "../../../../../lib/core/WorktreeManager.ts";
import {
  revParseRef,
  changedFilesBetween,
  verifyMergeOnDisk,
  type DiskVerifyResult,
} from "../../../../../lib/core/MergeSafety.ts";
// cross-skill-allowed: Lane-A executor updates QueueRouter's pipeline state on merge by design (07-02 overhaul)
import { getPipelineRepository } from "../../../../Automation/QueueRouter/Tools/PipelineRepository.ts";
import type { TaskDB } from "../TaskDB.ts";
import { mergeTask } from "./taskBookkeeper.ts";

// ============================================================================
// Interactive session lock
//
// FAITHFUL REPLICA (not an import) of Integrator.checkInteractiveSessionLock()
// (Integrator.ts:147-162). NOT imported directly: that method lives on a class whose
// constructor defaults to `new WorkQueue()`, which would pull the entire
// Automation/AutonomousWork stack into the LucidTasks executor just to read one lock file —
// Lane A is deliberately TaskDB-native and decoupled from that stack (see module docstring).
// Same path, same 2h staleness threshold, same corrupt-JSON-is-safe-to-proceed behavior.
// DRIFT GUARD: Integrator.ts's checkInteractiveSessionLock carries a matching cross-reference
// comment pointing back here — if the lock semantics change in one place, update the other.
// ============================================================================

export interface InteractiveLockInfo {
  sessionId: string;
  startedAt: string;
  pid: number;
}

const INTERACTIVE_LOCK_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours — matches Integrator.ts

export function checkInteractiveSessionLock(): InteractiveLockInfo | null {
  const lockPath = join(getKayaHome(), "MEMORY", "STATE", "interactive-session.lock");
  if (!existsSync(lockPath)) return null;
  try {
    const stat = statSync(lockPath);
    if (Date.now() - stat.mtimeMs > INTERACTIVE_LOCK_STALE_MS) return null; // stale
    return JSON.parse(readFileSync(lockPath, "utf-8"));
  } catch {
    return null; // corrupt or race — safe to proceed
  }
}

// ============================================================================
// Lane A cross-ref events
// ============================================================================

export const LANE_A_ACTOR_PREFIX = "executor:";

export type LaneAToStage = "lane-a-started" | "lane-a-verified" | "lane-a-merged";

export type AppendEventFn = (input: {
  itemId: string;
  toStage: string;
  actor: string;
  note?: string | null;
}) => void;

const defaultAppendEvent: AppendEventFn = (input) => getPipelineRepository().appendCrossRefEvent(input);

/**
 * Best-effort Lane A cross-ref event write — never throws. Used at three points in the
 * executor's lifecycle: claim (lane-a-started), post-verdict (lane-a-verified, note carries
 * the verdict), and post-merge (lane-a-merged, note carries the SHA — written internally by
 * runAutoMerge via its own injected `appendEvent` dep, not this function directly, but the
 * shape and defaulting are identical).
 */
export function appendLaneAEvent(
  input: { taskId: string; toStage: LaneAToStage; note?: string | null },
  appendFn: AppendEventFn = defaultAppendEvent,
): void {
  try {
    appendFn({
      itemId: input.taskId,
      toStage: input.toStage,
      actor: `${LANE_A_ACTOR_PREFIX}${input.taskId}`,
      note: input.note ?? null,
    });
  } catch (err) {
    recordFailure({
      source: "executor:laneAEvent",
      error: err,
      context: { taskId: input.taskId, toStage: input.toStage },
    });
  }
}

// ============================================================================
// Merge script runner
// ============================================================================

export interface MergeScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `bin/merge-to-main.sh <branch> <repoRoot>` with cwd=repoRoot (NEVER a worktree —
 * the known failure mode this guards against syncs the wrong tree). merge-to-main.sh is
 * repo-agnostic (it takes repo-root as an explicit second argument and resolves everything
 * from it), so this is safe to point at any git repository, not just the live kaya tree.
 */
function defaultRunMergeScript(branch: string, repoRoot: string): MergeScriptResult {
  const scriptPath = join(repoRoot, "bin", "merge-to-main.sh");
  try {
    const stdout = execFileSync(scriptPath, [branch, repoRoot], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: unknown; stderr?: unknown; message?: string };
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout != null ? String(e.stdout) : "",
      stderr: e.stderr != null ? String(e.stderr) : e.message ?? String(err),
    };
  }
}

// ============================================================================
// Post-merge disk verification (CLAUDE.md's documented recipe)
//
// SLICE S13: this used to be a self-contained implementation living entirely in this file.
// It is now a thin delegation to lib/core/MergeSafety.ts, extracted so AutonomousWork's
// Integrator.ts (pr/direct merge modes) can share the EXACT same scoped ancestor+disk-diff
// check instead of re-deriving it (Integrator had no equivalent check at all before S13) — see
// MergeSafety.ts's module docstring for the full "why scoped, not repo-global" history (found
// and fixed twice during the F2 fix round). Behavior here is byte-identical to the pre-S13
// version: same git invocations, same defaults (base defaults to "main").
// ============================================================================

export type { DiskVerifyResult } from "../../../../../lib/core/MergeSafety.ts";

function defaultRevParseMain(repoRoot: string): string {
  return revParseRef(repoRoot, "main");
}

function defaultChangedFiles(repoRoot: string, beforeSha: string, afterSha: string): string[] {
  return changedFilesBetween(repoRoot, beforeSha, afterSha);
}

function defaultVerifyDisk(repoRoot: string, changedFiles: string[], branch: string): DiskVerifyResult {
  return verifyMergeOnDisk(repoRoot, changedFiles, branch, "main");
}

// ============================================================================
// AutoMergeDeps — everything injectable (unit tests fake all of it)
// ============================================================================

export interface AutoMergeDeps {
  runMergeScript?: (branch: string, repoRoot: string) => MergeScriptResult;
  checkInteractiveLock?: () => InteractiveLockInfo | null;
  notify?: (message: string, opts?: { channel?: string }) => Promise<void>;
  appendEvent?: AppendEventFn;
  markWorktreeMerged?: (wtPath: string) => Promise<void>;
  verifyDisk?: (repoRoot: string, changedFiles: string[], branch: string) => DiskVerifyResult;
  changedFiles?: (repoRoot: string, beforeSha: string, afterSha: string) => string[];
  revParseMain?: (repoRoot: string) => string;
}

export interface AutoMergeParams {
  taskId: string;
  title: string;
  branch: string;
  /** The isolated per-task worktree path — only used for markWorktreeMerged, never as merge cwd. */
  wtPath: string;
  /** The REAL repo root (e.g. kayaHome()) — merge-to-main.sh runs here, never in a worktree. */
  repoRoot: string;
  /** The builder agent's own EXECUTOR_VERDICT summary — carried into the merged comment. */
  summary: string;
  verdict: "pass" | "fail" | "uncertain";
}

export type AutoMergeOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "deferred"; reason: string; lock: InteractiveLockInfo }
  | { kind: "merged"; sha: string }
  | { kind: "merge-failed"; reason: string }
  | { kind: "verify-failed"; reason: string };

// ============================================================================
// Comment formatting (pure — exported for tests)
// ============================================================================

/**
 * Structured payload embedded in a deferred-merge comment (F2 fix round, defect 2). This is
 * everything executor.ts's poll()-time pending-merge sweep (sweepPendingMerges) needs to retry
 * ONLY the merge step later — never the builder — read back purely from the persisted comment
 * trail (never from in-memory state, which would not survive a process restart).
 */
export interface MergeDeferredMarker {
  branch: string;
  wtPath: string;
  verdict: "pass";
  /** The builder agent's own EXECUTOR_VERDICT summary — needed to complete mergeTask()'s comment on retry. */
  summary: string;
  ts: string;
}

const MERGE_DEFERRED_MARKER_PREFIX = "MERGE_DEFERRED: ";

/**
 * The pre-F2-fix-round prose-only deferred comment text (no JSON marker) — kept as an exported
 * constant so executor.ts's legacy-detection (migration path for tasks that got stuck under the
 * OLD, unbacked-promise deferred flow) can match it without duplicating the literal string.
 */
export const LEGACY_MERGE_DEFERRED_PHRASE = "merge deferred: interactive session live";

export function formatMergeDeferredComment(lock: InteractiveLockInfo, marker: MergeDeferredMarker): string {
  return [
    `${MERGE_DEFERRED_MARKER_PREFIX}${JSON.stringify(marker)}`,
    "",
    `${LEGACY_MERGE_DEFERRED_PHRASE} (session ${lock.sessionId}, started ${lock.startedAt}) — ` +
      `will retry once the session ends.`,
  ].join("\n");
}

/**
 * Parse a MERGE_DEFERRED marker back out of a comment's text (pure — exported for tests and for
 * executor.ts's pending-merge sweep). Returns null for anything that isn't a well-formed marker
 * — including the legacy prose-only comment this format replaces (see
 * LEGACY_MERGE_DEFERRED_PHRASE and executor.ts's detectPendingMerge for how that shape is still
 * recognized and migrated).
 */
export function parseMergeDeferredMarker(commentText: string): MergeDeferredMarker | null {
  if (!commentText.startsWith(MERGE_DEFERRED_MARKER_PREFIX)) return null;
  const jsonLine = commentText.slice(MERGE_DEFERRED_MARKER_PREFIX.length).split("\n", 1)[0];
  try {
    const parsed = JSON.parse(jsonLine);
    if (
      parsed &&
      typeof parsed.branch === "string" &&
      typeof parsed.wtPath === "string" &&
      typeof parsed.summary === "string" &&
      typeof parsed.ts === "string" &&
      parsed.verdict === "pass"
    ) {
      return parsed as MergeDeferredMarker;
    }
    return null;
  } catch {
    return null;
  }
}

export function formatMergeFailedComment(reason: string): string {
  return `MERGE_FAILED: ${reason} — falling back to manual review.`;
}

// ============================================================================
// runAutoMerge — the ONE orchestration entry point
// ============================================================================

export async function runAutoMerge(
  db: TaskDB,
  params: AutoMergeParams,
  deps: AutoMergeDeps = {},
): Promise<AutoMergeOutcome> {
  // 1. Only a genuine "pass" verdict attempts a merge — fail/uncertain get exactly today's
  //    F1 behavior (the caller still runs its normal waiting+comment deliverTask() path).
  if (params.verdict !== "pass") {
    return { kind: "skipped", reason: `verdict is "${params.verdict}" — no merge attempt` };
  }

  const checkLock = deps.checkInteractiveLock ?? checkInteractiveSessionLock;
  const runScript = deps.runMergeScript ?? defaultRunMergeScript;
  const verifyDisk = deps.verifyDisk ?? defaultVerifyDisk;
  const getChangedFiles = deps.changedFiles ?? defaultChangedFiles;
  const revParseMain = deps.revParseMain ?? defaultRevParseMain;
  const notify =
    deps.notify ?? ((message: string, opts?: { channel?: string }) => realNotify(message, { channel: (opts?.channel as never) ?? "telegram" }));
  const markMerged = deps.markWorktreeMerged ?? realMarkWorktreeMerged;
  const appendEvent = deps.appendEvent ?? defaultAppendEvent;

  // 2. Interactive-session guard (plan M2's E2-style defer) — keep the item re-engageable.
  //    The structured marker (defect 2 fix) is what lets executor.ts's pending-merge sweep find
  //    and retry THIS exact merge later, purely by re-reading the comment trail.
  const lock = checkLock();
  if (lock) {
    const marker: MergeDeferredMarker = {
      branch: params.branch,
      wtPath: params.wtPath,
      verdict: "pass",
      summary: params.summary,
      ts: new Date().toISOString(),
    };
    db.addComment(params.taskId, formatMergeDeferredComment(lock, marker), "executor");
    return { kind: "deferred", reason: "interactive session live", lock };
  }

  // 3. Merge attempt — ALWAYS from repoRoot, never wtPath (the documented worktree-cwd failure
  //    mode). Capture main's sha before/after so disk verification and the merged comment can
  //    both reference exact commits, not the script's truncated echoed short-shas.
  const beforeSha = revParseMain(params.repoRoot);
  const scriptResult = runScript(params.branch, params.repoRoot);

  if (scriptResult.exitCode !== 0) {
    const reason = `merge-to-main.sh exited ${scriptResult.exitCode}: ${(scriptResult.stderr || scriptResult.stdout).slice(0, 500)}`;
    recordFailure({
      source: "executor:merge",
      error: reason,
      context: { taskId: params.taskId, branch: params.branch, repoRoot: params.repoRoot },
    });
    db.addComment(params.taskId, formatMergeFailedComment(reason), "executor");
    return { kind: "merge-failed", reason };
  }

  // 4. Post-merge disk verification — CLAUDE.md's documented recipe, SCOPED to this merge only
  //    (see defaultVerifyDisk's docstring for why a repo-global sweep was wrong).
  const afterSha = revParseMain(params.repoRoot);
  const changed = getChangedFiles(params.repoRoot, beforeSha, afterSha);
  const diskResult = verifyDisk(params.repoRoot, changed, params.branch);

  if (!diskResult.clean) {
    const reason = "post-merge disk verification failed (diff-stat non-empty or branch is not an ancestor of main)";
    recordFailure({
      source: "executor:merge:verify",
      error: reason,
      context: {
        taskId: params.taskId,
        branch: params.branch,
        diffOutput: diskResult.diffOutput.slice(0, 1000),
        isAncestor: diskResult.isAncestor,
      },
    });
    db.addComment(params.taskId, formatMergeFailedComment(reason), "executor");
    return { kind: "verify-failed", reason };
  }

  // 5. Merged — close the task, mark the worktree, notify, cross-ref event. Each of the last
  //    three is best-effort: the merge itself already succeeded and must not be undone or
  //    reported as a failure because a downstream notification/bookkeeping step hiccuped.
  mergeTask(db, params.taskId, { branch: params.branch, sha: afterSha, summary: params.summary });

  try {
    await markMerged(params.wtPath);
  } catch (err) {
    recordFailure({ source: "executor:merge:worktree", error: err, context: { taskId: params.taskId, wtPath: params.wtPath } });
  }

  try {
    // Reclaim the just-merged worktree (liveness-gated) so stale dirs don't accumulate —
    // mirrors the Integrator's post-merge GC. Best-effort: a GC hiccup must never undo or
    // fail the completed merge above.
    await gcWorktreeForBranch(params.branch, getKayaHome());
  } catch (err) {
    recordFailure({ source: "executor:merge:gc", error: err, context: { taskId: params.taskId, branch: params.branch } });
  }

  try {
    await notify(`Auto-merged: ${params.title} → main @ ${afterSha.slice(0, 8)}`, { channel: "telegram" });
  } catch (err) {
    recordFailure({ source: "executor:merge:notify", error: err, context: { taskId: params.taskId } });
  }

  appendLaneAEvent({ taskId: params.taskId, toStage: "lane-a-merged", note: afterSha }, appendEvent);

  return { kind: "merged", sha: afterSha };
}
