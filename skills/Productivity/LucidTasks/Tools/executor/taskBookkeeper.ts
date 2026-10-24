#!/usr/bin/env bun
/**
 * taskBookkeeper.ts — Atomic status transitions and comments for the autonomous executor.
 *
 * deliverTask and mergeTask also record the task's Outcome (Task Outcome Card) in the same
 * updateTask call as their status change.
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
import { getKayaHome } from "../../../../../lib/core/KayaHome.ts";
import {
  OutcomeSchema,
  createForJmTasks,
  linkFromTarget,
  readOutcome,
  serializeOutcome,
  type ForJmItem,
  type Outcome,
  type OutcomeLink,
} from "../TaskOutcome.ts";
import { recordFailure } from "../../../../../lib/core/FailureLog.ts";
import { deriveHeadline } from "./verdictParser.ts";

const CLOSED_STATUSES = new Set(["in_progress", "done", "cancelled"]);

/** The agent-authored part of an outcome (from the EXECUTOR_VERDICT), plus run context. */
export interface OutcomeDraft {
  /** One plain sentence for Jm. */
  headline: string;
  /** One command or step for Jm to check the work. */
  check?: string;
  /** Files Jm opens first (repo-relative or absolute). Mapped to links. */
  deliverables?: string[];
  /** Items that need Jm's decision or action — each becomes a child task. */
  forJm?: string[];
  /** Changed files from `git diff --name-only <headBefore>..HEAD`; used ONLY when `deliverables` is empty. */
  fallbackFiles?: string[];
  /** The executor worktree path — absolute deliverables under it are really repo-relative. */
  wtPath?: string;
}

/** Why a merge was attempted but did not complete (runAutoMerge's non-merged outcome kinds). */
export type MergeAttemptKind = "deferred" | "merge-failed" | "verify-failed";

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
  /** The agent-authored outcome fields. When absent, the headline is derived from `summary`. */
  outcome?: OutcomeDraft;
  /** Set when runAutoMerge tried and did NOT merge — so the outcome's merge.state is accurate. */
  mergeAttempt?: MergeAttemptKind;
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

// ============================================================================
// Outcome record (Task Outcome Card) — pure builder
// ============================================================================

export interface ExecutorOutcomeInput {
  draft: OutcomeDraft;
  /** For-Jm items AFTER their child tasks were created (carry `taskId`). */
  forJm: ForJmItem[];
  /** The full report (already carries the fallback-model label, if any). */
  details: string;
  branch?: string;
  /** True when the run produced repo changes committed to `branch`. */
  hasChanges: boolean;
  verify?: { verdict: "pass" | "fail" | "uncertain"; reasoning: string };
  /** Reason verification could not run (e.g. "infra"). */
  verifySkipped?: string;
  /** Set to the merge SHA when the branch was merged to main. */
  mergedSha?: string;
  /** Set when a merge was attempted and did not complete. */
  mergeAttempt?: MergeAttemptKind;
  kayaHome: string;
  /** ISO timestamp; defaults to now. */
  at?: string;
}

const MAX_LINKS = 20; // OutcomeSchema's links limit
const MAX_FOR_JM = 20; // OutcomeSchema's forJm limit
const MAX_DELIVERABLE_LINKS = MAX_LINKS - 1; // one slot stays free for the diff/commit link
const MAX_FALLBACK_FILES = 5;

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

function mapDeliverable(raw: string, input: ExecutorOutcomeInput, ref: string | undefined): OutcomeLink {
  const t = raw.trim();
  const under = (root: string | undefined): string | null => {
    if (!root) return null;
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return t.startsWith(prefix) ? t.slice(prefix.length) : null;
  };
  const rel = under(input.draft.wtPath) ?? under(input.kayaHome);
  if (rel !== null && rel !== "") {
    return ref ? { kind: "repo", target: rel, ref } : { kind: "repo", target: rel };
  }
  const link = linkFromTarget(t);
  return link.kind === "repo" && ref ? { ...link, ref } : link;
}

/**
 * Build the Outcome the executor records for a delivery or auto-merge. Pure — exported for tests.
 *
 * Links: the agent's deliverables (absolute path inside the worktree/repo -> "repo" with the
 * relative path; other absolute -> "path"; relative -> "repo"; `ref` = branch while the work is
 * not on main), then one "branch" link (label "Diff") when there are repo changes that are not
 * merged, or one "commit" link (label "Commit") when merged. With no deliverables, falls back
 * to up to 5 changed files. Merge state comes from what the executor DID, never from prose.
 */
export function buildExecutorOutcome(input: ExecutorOutcomeInput): Outcome {
  const { draft, hasChanges } = input;
  // Blank branch/sha count as absent: a whitespace branch must not throw, and an empty sha must
  // not claim "merged".
  const branch = input.branch?.trim() || undefined;
  const mergedSha = input.mergedSha?.trim() || undefined;
  const merged = mergedSha !== undefined;
  const ref = !merged && hasChanges ? branch : undefined;

  const targets =
    draft.deliverables && draft.deliverables.length > 0
      ? draft.deliverables
      : (draft.fallbackFiles ?? []).slice(0, MAX_FALLBACK_FILES);
  const links: OutcomeLink[] = [];
  for (const target of targets) {
    if (target.trim() === "") continue;
    const link = mapDeliverable(target, input, ref);
    if (!links.some((l) => l.kind === link.kind && l.target === link.target)) links.push(link);
  }
  links.splice(MAX_DELIVERABLE_LINKS);
  if (mergedSha) {
    links.push({ kind: "commit", target: mergedSha, label: "Commit" });
  } else if (hasChanges && branch) {
    links.push({ kind: "branch", target: branch, label: "Diff" });
  }

  let mergeState: NonNullable<Outcome["merge"]>["state"];
  if (merged) mergeState = "merged";
  else if (input.mergeAttempt === "deferred") mergeState = "deferred";
  else if (input.mergeAttempt === "merge-failed" || input.mergeAttempt === "verify-failed") mergeState = "failed";
  else mergeState = hasChanges ? "pending" : "none";

  let verify: Outcome["verify"];
  if (input.verifySkipped) {
    verify = { verdict: "skipped", note: clip(`verification skipped: ${input.verifySkipped}`, 600) };
  } else if (input.verify) {
    verify = { verdict: input.verify.verdict, note: clip(input.verify.reasoning, 600) };
  }

  const check = draft.check?.trim();
  return OutcomeSchema.parse({
    v: 1,
    headline: clip(draft.headline.trim(), 200),
    links,
    ...(links.length === 0 ? { noArtifact: "no files changed; see the report" } : {}),
    ...(verify ? { verify } : {}),
    merge: {
      state: mergeState,
      ...(branch && hasChanges ? { branch } : {}),
      ...(mergedSha ? { sha: mergedSha } : {}),
    },
    ...(check ? { check: clip(check, 300) } : {}),
    forJm: input.forJm,
    details: clip(input.details, 12000),
    by: "executor",
    at: input.at ?? new Date().toISOString(),
    source: "executor",
  });
}

/**
 * Mark the task delivered: set status to 'waiting' and add a reviewable Deliverable comment.
 * Jm reviews the result (branch diff or artifact) and either marks the task done (approve)
 * or comments feedback (which the next executor run picks up as a re-engagement).
 *
 * The Outcome is written in the SAME updateTask call as the status change (a re-engagement
 * delivery replaces any earlier outcome). For-Jm child tasks are created first, so their ids
 * land in `outcome.forJm`; createForJmTasks dedupes, so re-delivery adds no duplicates.
 */
export function deliverTask(db: TaskDB, taskId: string, payload: DeliverablePayload): void {
  const task = db.getTask(taskId);
  const draft: OutcomeDraft = payload.outcome ?? { headline: "" };
  const headline = pickHeadline(draft.headline, payload.summary, task?.title);
  const hasChanges = Boolean(payload.hasChanges && payload.branch);
  const outcomeJson = outcomeJsonOrFallback(db, taskId, {
    forJm: draft.forJm ?? [],
    build: (forJm) =>
      buildExecutorOutcome({
        draft: { ...draft, headline, deliverables: [...(draft.deliverables ?? []), ...(payload.artifacts ?? [])] },
        forJm,
        details: payload.summary,
        branch: payload.branch,
        hasChanges,
        verify: payload.verify,
        verifySkipped: payload.verifySkipped,
        mergeAttempt: payload.mergeAttempt,
        kayaHome: getKayaHome(),
      }),
    branch: payload.branch,
    fallback: (forJm, note) =>
      buildExecutorOutcome({
        draft: { headline },
        forJm,
        details: `${note}\n\n${payload.summary}`,
        branch: payload.branch,
        hasChanges,
        mergeAttempt: payload.mergeAttempt,
        kayaHome: getKayaHome(),
      }),
  });
  db.updateTask(taskId, { status: "waiting", outcome: outcomeJson }, "executor");
  db.addComment(taskId, formatDeliverableComment(payload), "executor");
}

/** A non-empty headline: the draft's, else the summary's first sentence, else the task title. */
function pickHeadline(draftHeadline: string, summary: string, taskTitle: string | undefined): string {
  return (
    draftHeadline.trim() ||
    deriveHeadline(summary) ||
    clip((taskTitle ?? "").trim(), 200) ||
    "Delivered (no summary)"
  );
}

/**
 * Produce the outcome JSON for a status write — and NEVER throw because of the outcome (a throw
 * after a real merge would strand the task not-done). Order matters:
 *   1. build once with text-only for-Jm items to VALIDATE before any child task exists,
 *   2. create the child tasks, 3. rebuild with their ids and serialize.
 * Any failure falls back to a minimal valid outcome and is logged via recordFailure, so the
 * degradation is visible and the caller's status transition still happens. The fallback keeps
 * Jm's for-Jm items as TEXT-ONLY items (no child tasks) and carries a note for `details`, so
 * the card itself shows the problem. Items over the 20-item cap are dropped — and logged.
 */
function outcomeJsonOrFallback(
  db: TaskDB,
  taskId: string,
  opts: {
    forJm: string[];
    /** Run context for the failure log. */
    branch?: string;
    sha?: string;
    build: (forJm: ForJmItem[]) => Outcome;
    fallback: (forJm: ForJmItem[], note: string) => Outcome;
  },
): string {
  const all = opts.forJm.map((t) => t.trim().slice(0, 300).trim()).filter((t) => t !== "");
  const texts = all.slice(0, MAX_FOR_JM);
  if (all.length > texts.length) {
    recordFailure({
      source: "executor:outcome",
      error: `forJm over cap: dropped ${all.length - texts.length} items`,
      context: { taskId, dropped: all.length - texts.length },
    });
  }
  const textOnly: ForJmItem[] = texts.map((text) => ({ text }));
  try {
    opts.build(textOnly); // validate first; throws on a bad outcome
    const task = db.getTask(taskId);
    const items = task && texts.length > 0 ? createForJmTasks(db, task, texts) : [];
    return serializeOutcome(opts.build(items));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordFailure({
      source: "executor:outcome",
      error: err,
      context: { taskId, branch: opts.branch, sha: opts.sha, forJm: texts.length },
    });
    const note = `Kaya could not build the full outcome: ${message.slice(0, 200)}. See the failure log.`;
    try {
      return serializeOutcome(opts.fallback(textOnly, note));
    } catch (err2) {
      recordFailure({ source: "executor:outcome", error: err2, context: { taskId, stage: "fallback" } });
      return serializeOutcome(opts.fallback([], note));
    }
  }
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
  /** Agent-authored outcome fields for a FRESH build. Absent on the pending-merge sweep, which
   *  updates the outcome already on the task instead. */
  outcome?: OutcomeDraft;
  /** The verification verdict that cleared the merge (fresh build only). */
  verify?: { verdict: "pass" | "fail" | "uncertain"; reasoning: string };
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
 * The outcome to record on a merge. Fresh build (`payload.outcome`): built from scratch.
 * Pending-merge sweep (no draft): the deferred delivery's outcome is kept field-for-field, with
 * `merge` -> merged (sha, branch) and the "branch" link swapped for a "commit" link. A task with
 * no outcome yet (delivered before the Outcome Card existed) gets one built from the summary.
 */
function buildMergeOutcome(
  taskTitle: string | undefined,
  existingRaw: string | null | undefined,
  payload: MergedPayload,
  forJm: ForJmItem[],
): Outcome {
  if (payload.outcome) {
    return buildExecutorOutcome({
      draft: { ...payload.outcome, headline: pickHeadline(payload.outcome.headline, payload.summary, taskTitle) },
      forJm,
      details: payload.summary,
      branch: payload.branch,
      hasChanges: true,
      verify: payload.verify,
      mergedSha: payload.sha,
      kayaHome: getKayaHome(),
    });
  }

  const existing = readOutcome(existingRaw).outcome;
  if (!existing) {
    return buildExecutorOutcome({
      draft: { headline: pickHeadline("", payload.summary, taskTitle) },
      forJm: [],
      details: payload.summary,
      branch: payload.branch,
      hasChanges: true,
      mergedSha: payload.sha,
      kayaHome: getKayaHome(),
    });
  }

  // Swap the branch link for the commit link; keep the total within the schema's 20-link limit
  // (no branch link to swap: drop the last link to make room).
  const commit: OutcomeLink = { kind: "commit", target: payload.sha, label: "Commit" };
  let links: OutcomeLink[];
  if (existing.links.some((l) => l.kind === "branch")) {
    links = existing.links.map((l) => (l.kind === "branch" ? commit : l));
  } else {
    links = [...existing.links.slice(0, MAX_LINKS - 1), commit];
  }
  return OutcomeSchema.parse({
    ...existing,
    links,
    merge: { state: "merged", branch: payload.branch, sha: payload.sha },
  });
}

/**
 * Mark the task done after a successful Lane A auto-merge (slice F2): a comment naming the
 * branch + merge SHA, then status → 'done' (TaskDB auto-stamps completed_at on that
 * transition — see TaskDB.updateTask). Comment written BEFORE the status flip, mirroring
 * failTask's ordering: never missing on a DB error partway through. The Outcome rides in the
 * SAME updateTask call as the status flip (see buildMergeOutcome). The outcome can never make
 * this throw — the merge to main already happened — see outcomeJsonOrFallback.
 */
export function mergeTask(db: TaskDB, taskId: string, payload: MergedPayload): void {
  db.addComment(taskId, formatMergedComment(payload), "executor");
  const task = db.getTask(taskId);
  const outcomeJson = outcomeJsonOrFallback(db, taskId, {
    forJm: payload.outcome?.forJm ?? [],
    build: (forJm) => buildMergeOutcome(task?.title, task?.outcome, payload, forJm),
    branch: payload.branch,
    sha: payload.sha,
    fallback: (forJm, note) =>
      buildExecutorOutcome({
        draft: { headline: pickHeadline(payload.outcome?.headline ?? "", payload.summary, task?.title) },
        // Sweep path (no draft): keep the for-Jm items already on the task's outcome.
        forJm: payload.outcome ? forJm : (readOutcome(task?.outcome).outcome?.forJm ?? []),
        details: `${note}\n\n${payload.summary}`,
        branch: payload.branch,
        hasChanges: true,
        mergedSha: payload.sha,
        kayaHome: getKayaHome(),
      }),
  });
  db.updateTask(taskId, { status: "done", outcome: outcomeJson }, "executor");
}
