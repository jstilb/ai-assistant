#!/usr/bin/env bun
/**
 * taskBookkeeper.ts — Atomic status transitions and comments for the autonomous executor.
 *
 * Five operations:
 *   claimTask          — in_progress guard (idempotent-safe: returns false if already claimed/closed)
 *   deliverTask        — waiting + a reviewable Deliverable comment (branch diff or external artifact,
 *                         now also rendering the verification verdict, slice F1)
 *   failTask           — inbox reset + EXECUTOR_FAIL comment (so the next run re-picks it)
 *   recordVerification — a machine-parseable EXECUTOR_VERIFY comment (slice F1), in ADDITION to the
 *                         human-readable Deliverable comment deliverTask already writes
 *   mergeTask          — done + a comment naming the branch + merge SHA (slice F2 — Lane A auto-merge)
 *
 * All take a TaskDB instance rather than calling getTaskDB() themselves, so callers control the
 * DB lifetime and tests can inject an isolated instance.
 */

import type { TaskDB } from "../TaskDB.ts";
import type { VerifyRecord } from "./executorVerify.ts";

const CLOSED_STATUSES = new Set(["in_progress", "done", "cancelled"]);

export interface DeliverablePayload {
  /** Human-readable account of what the agent did — Jm reviews this on the board. */
  summary: string;
  /** External files the agent wrote (e.g. an Obsidian note). Rendered as [[wikilinks]]. */
  artifacts?: string[];
  /** The executor worktree branch that holds any repo code changes. */
  branch?: string;
  /** True when the run produced repo changes committed to `branch`. */
  hasChanges?: boolean;
  /** Verification verdict (slice F1) — rendered prominently above the deliverable body. */
  verify?: { verdict: "pass" | "fail" | "uncertain"; reasoning: string };
  /**
   * Set (to a short reason, e.g. "infra") when verification could not run at all — distinct
   * from a verdict. Never silently omitted: this always renders an explicit marker so Jm can
   * tell "reviewed and flagged" apart from "never reviewed."
   */
  verifySkipped?: string;
}

/**
 * Attempt to claim a task for execution.
 * Returns false (no-op) if the task is already in_progress, done, or cancelled.
 * Returns true if successfully claimed (status → in_progress).
 */
export function claimTask(db: TaskDB, taskId: string): boolean {
  const task = db.getTask(taskId);
  if (!task) return false;
  if (CLOSED_STATUSES.has(task.status)) return false;

  db.updateTask(taskId, { status: "in_progress" }, "executor");
  return true;
}

/**
 * Render the verification verdict as a single prominent line, or null when there is nothing
 * to show (no verify field and not skipped — the pre-F1 shape). Pure — exported for tests.
 */
function formatVerifyLine(payload: DeliverablePayload): string | null {
  if (payload.verifySkipped) {
    return `⚠️ verification skipped: ${payload.verifySkipped} — this delivery has not been independently reviewed.`;
  }
  if (payload.verify) {
    const { verdict, reasoning } = payload.verify;
    if (verdict === "pass") return `✅ VERIFY: PASS — ${reasoning}`;
    if (verdict === "fail") return `❌ VERIFY FAILED — ${reasoning}`;
    return `❓ VERIFY UNCERTAIN — ${reasoning}`;
  }
  return null;
}

/**
 * Build the Deliverable comment text. Pure — exported for tests.
 *
 * Two shapes:
 *   - Repo work (hasChanges + branch): names the branch + how to review/merge, so Jm can
 *     diff the work and approve. Any external artifacts are appended as wikilinks.
 *   - External-only work (note/file outside the repo): a `Deliverable: [[path]]` line so the
 *     DailyBriefing's wikilink scan surfaces it (same shape as the research-era deliverable).
 *
 * Slice F1: when `verify`/`verifySkipped` is present, a verdict line is prepended above the
 * deliverable body in either shape — prominent, never buried. Absent verify fields (pre-F1
 * callers, or the no-repo-changes path that skips verification entirely) render byte-identical
 * to the original shape.
 */
export function formatDeliverableComment(payload: DeliverablePayload): string {
  const { summary, artifacts = [], branch, hasChanges } = payload;
  const artifactLinks = artifacts.map((a) => `[[${a}]]`);
  const verifyLine = formatVerifyLine(payload);

  if (hasChanges && branch) {
    const lines: string[] = [];
    if (verifyLine) lines.push(verifyLine, "");
    lines.push(
      `Deliverable (branch \`${branch}\`):`,
      "",
      summary,
      "",
      `Review: \`git diff main...${branch}\` — merge when approved. ` +
        `To approve, mark this task done; to request changes, comment here and I'll re-engage.`,
    );
    if (artifactLinks.length > 0) {
      lines.push("", `Also wrote: ${artifactLinks.join(" ")}`);
    }
    return lines.join("\n");
  }

  // External-only deliverable (no repo changes).
  const header = artifactLinks.length > 0
    ? `Deliverable: ${artifactLinks.join(" ")}`
    : "Deliverable:";
  const body = `${header}\n\n${summary}`;
  return verifyLine ? `${verifyLine}\n\n${body}` : body;
}

/**
 * Mark the task delivered: set status to 'waiting' and add a reviewable Deliverable comment.
 * Jm reviews the result (branch diff or artifact) and either marks the task done (approve)
 * or comments feedback (which the next executor run picks up as a re-engagement).
 */
export function deliverTask(db: TaskDB, taskId: string, payload: DeliverablePayload): void {
  db.updateTask(taskId, { status: "waiting" }, "executor");
  db.addComment(taskId, formatDeliverableComment(payload), "executor");
}

/**
 * Mark the task failed: append an EXECUTOR_FAIL comment (for audit trail) then
 * reset status back to 'inbox' so the next executor run will re-pick it up.
 * Order matters: comment first so it is never missing on a DB error.
 */
export function failTask(db: TaskDB, taskId: string, reason: string): void {
  db.addComment(taskId, `EXECUTOR_FAIL: ${reason}`, "executor");
  db.updateTask(taskId, { status: "inbox" }, "executor");
}

/**
 * Persist a machine-parseable verification record as a comment (slice F1). Mirrors the
 * EXECUTOR_FAIL / EXECUTOR_PAUSED comment-tag convention: a distinct, JSON-bearing comment in
 * ADDITION to the human-readable Deliverable comment (which renders the same verdict/reasoning
 * prominently via `formatDeliverableComment`'s `verify` field). Does not touch task status —
 * status transitions stay owned by claimTask/deliverTask/failTask.
 */
export function recordVerification(db: TaskDB, taskId: string, record: VerifyRecord): void {
  db.addComment(taskId, `EXECUTOR_VERIFY: ${JSON.stringify(record)}`, "executor");
}

// ============================================================================
// mergeTask (slice F2 — Lane A auto-merge)
// ============================================================================

export interface MergedPayload {
  /** The executor task branch that was merged. */
  branch: string;
  /** The resulting main-branch commit SHA (from merge-to-main.sh's CAS update-ref). */
  sha: string;
  /** The builder agent's own EXECUTOR_VERDICT summary — carried into the merged comment. */
  summary: string;
}

/**
 * Build the auto-merge completion comment. Pure — exported for tests.
 */
export function formatMergedComment(payload: MergedPayload): string {
  return [
    `✅ Auto-merged branch \`${payload.branch}\` → main @ \`${payload.sha}\`.`,
    "",
    payload.summary,
  ].join("\n");
}

/**
 * Mark the task done after a successful Lane A auto-merge (slice F2): a comment naming the
 * branch + merge SHA, then status → 'done' (TaskDB auto-stamps completed_at on that
 * transition — see TaskDB.updateTask). Comment written BEFORE the status flip, mirroring
 * failTask's ordering: never missing on a DB error partway through.
 */
export function mergeTask(db: TaskDB, taskId: string, payload: MergedPayload): void {
  db.addComment(taskId, formatMergedComment(payload), "executor");
  db.updateTask(taskId, { status: "done" }, "executor");
}
