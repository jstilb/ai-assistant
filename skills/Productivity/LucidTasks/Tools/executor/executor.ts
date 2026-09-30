#!/usr/bin/env bun
/**
 * executor.ts — Autonomous executor CLI entry point.
 *
 * Usage:
 *   bun executor.ts run <taskId>
 *   bun executor.ts poll [--limit <n>]
 *
 * The executor EXECUTES work (build/code/act/research) within a reversible-action boundary.
 * There is NO output-verification gate — Jm verifies the result manually on the board and steers
 * with feedback comments (re-engagement). Only loud-fails on "the agent didn't run / didn't report".
 *
 * Flow (single task):
 *   1. Load task; assert disposition==='autonomous'
 *   2. Claim (in_progress guard)
 *   3. Isolate into a per-task git worktree (branch executor/task-<id>) — never touches live tree
 *   4. Build prompt + spawn opus agent in the worktree; if the opus spawn is
 *      infra-unavailable (e.g. 529 Overloaded), retry ONCE on sonnet and label the
 *      delivery accordingly — see spawnBuilderAgent (timeout is the one reason that
 *      does not fall back)
 *   5. Parse verdict (loud-fail only if no EXECUTOR_VERDICT block)
 *   6. Capture work: commit repo changes to the branch (or tear down if no changes)
 *   6b. Verify (slice F1): when there ARE committed repo changes, spawn a SECOND, SKEPTICAL
 *       opus agent (executorVerify.ts) against the same worktree to try to REFUTE completion.
 *       Infra-unavailable (rate limit) never delivers silently unverified — it delivers with an
 *       explicit "verification skipped: infra" marker + recordFailure. This is verification
 *       only, not merge policy — slice F2 (not this one) decides what fail/uncertain DOES.
 *   7. Deliver (waiting + reviewable comment: branch diff or external artifact, now including
 *      the verification verdict)
 *   8. Append JSONL run record (now including the verification verdict)
 *
 * Flow (poll):
 *   1. Acquire run lock (PID file); exit 0 if already running
 *   1a. sweepZombieTasks(): reclaim autonomous tasks stranded in_progress by a run that died
 *       after claim but before reset (timeout-SIGKILL / sleep kill — bit t-mt1pnmvb on 08-23).
 *       Reset to inbox with an EXECUTOR_RECLAIM comment so selectTasks() re-picks them THIS
 *       poll. Runs FIRST so a reclaimed task is eligible in the same batch.
 *   1b. sweepPendingMerges() (slice F2 fix round): retry any previously-deferred Lane A
 *       auto-merge whose interactive-session lock has since cleared. Merge step ONLY — never
 *       spawns a builder agent. Runs BEFORE selectTasks() so a merge stuck on an
 *       always-executor-authored comment trail (see sweepPendingMerges's docstring) doesn't
 *       silently starve behind it.
 *   2. selectTasks() — fresh autonomous tasks + re-engagements
 *   3. runTask() each in series, catching errors so one failure doesn't abort the batch
 *   4. Release lock in finally block
 *
 * Fails loud on every infra/spawn/parse error class — no silent containment.
 * runTask() returns a result object (never calls process.exit internally) so it is
 * safe to call in a loop. The `run <taskId>` CLI wrapper translates result → exit code.
 */

import { execFileSync } from "child_process";
import { join } from "path";

import { getTaskDB } from "../TaskDB.ts";
import type { TaskDB } from "../TaskDB.ts";
import { getKayaHome } from "../../../../../lib/core/KayaHome.ts";
import { sendAlert } from "../../../../../lib/core/AlertGate.ts";
import { isRateLimited } from "../../../../../lib/core/RateLimitGuard.ts";
import { getOrCreateWorktree, removeWorktree } from "../../../../../lib/core/WorktreeManager.ts";
import { recordFailure } from "../../../../../lib/core/FailureLog.ts";
import { createAppendLog, type AppendLog } from "../../../../../lib/core/AppendLog.ts";
import type { InfraReason } from "../../../../../lib/core/AgentSpawner.ts";
import { spawnAgent, type SpawnAgentOpts, type SpawnAgentResult } from "./spawnAgent.ts";
import { parseVerdict } from "./verdictParser.ts";
import { buildAgentPrompt } from "./agentPrompt.ts";
import { claimTask, deliverTask, failTask, recordVerification } from "./taskBookkeeper.ts";
import { acquireLock, releaseLock } from "./runLock.ts";
import { runVerification } from "./executorVerify.ts";
import {
  runAutoMerge,
  appendLaneAEvent,
  checkInteractiveSessionLock,
  parseMergeDeferredMarker,
  LEGACY_MERGE_DEFERRED_PHRASE,
  type AutoMergeOutcome,
  type AutoMergeDeps,
  type InteractiveLockInfo,
} from "./executorMerge.ts";

// ============================================================================
// Types
// ============================================================================

export type TaskResult = {
  taskId: string;
  status: "delivered" | "failed" | "skipped";
  reason?: string;
};

export type SelectedTask = {
  taskId: string;
  isReEngagement: boolean;
};

// ============================================================================
// Builder spawn — opus with one-shot sonnet fallback
// ============================================================================

/** Primary model for builder spawns — opus, matching the settings.json default model. */
export const PRIMARY_MODEL = "opus";
/**
 * Fallback model when the PRIMARY_MODEL spawn is infra-unavailable (the 08-23
 * defect: all 4 queued tasks died on fable-529 Overloaded because the model was
 * hardcoded with no fallback). Sonnet's headless path is independent of the primary's
 * overload state and is judged good enough for autonomous lane work — see
 * memory project_autonomous_executor_diagnosis_20260823.
 */
export const FALLBACK_MODEL = "sonnet";

export interface BuilderSpawnOutcome {
  /** The result the rest of runTask() consumes — the fallback's result when it ran. */
  res: SpawnAgentResult;
  /** Which model produced `res`. */
  model: typeof PRIMARY_MODEL | typeof FALLBACK_MODEL;
  /** True when the FALLBACK_MODEL retry ran (regardless of whether it then succeeded). */
  fellBack: boolean;
  /**
   * WHY the primary spawn was infra-unavailable — set only when fellBack. undefined
   * inside a fellBack outcome is the (theoretical) pre-spawn-gated case, which has no
   * InfraReason of its own; spawnAgent sets skipRateLimitGate so it never gates here.
   */
  primaryInfraReason?: InfraReason;
}

/**
 * Spawn the builder agent on PRIMARY_MODEL; if THAT spawn is infra-unavailable, retry
 * exactly once on FALLBACK_MODEL instead of failing the whole lane.
 *
 * Timeout is the ONE infra reason that does NOT fall back: a 90-minute timeout means
 * the model RAN (it isn't unavailable), and an immediate same-batch retry would double
 * the batch's wall-clock for a task the existing pause path (6a) already resets to
 * inbox for a next-poll retry. Every other reason (network, rate-limit, quota/overload,
 * no-output) fails fast, so the extra attempt costs seconds at worst — even when the
 * outage is shared (network down, pooled rate limit) and sonnet fails too.
 *
 * If the fallback spawn is ALSO infra-unavailable, the returned res carries that state
 * and runTask()'s existing pause path handles it — reset to inbox + page.
 */
export function spawnBuilderAgent(
  prompt: string,
  opts: Omit<SpawnAgentOpts, "model">,
  spawn: (prompt: string, opts: SpawnAgentOpts) => SpawnAgentResult = spawnAgent,
): BuilderSpawnOutcome {
  const primary = spawn(prompt, { ...opts, model: PRIMARY_MODEL });
  if (!primary.infraUnavailable || primary.infraReason === "timeout") {
    return { res: primary, model: PRIMARY_MODEL, fellBack: false };
  }
  const fallback = spawn(prompt, { ...opts, model: FALLBACK_MODEL });
  return {
    res: fallback,
    model: FALLBACK_MODEL,
    fellBack: true,
    primaryInfraReason: primary.infraReason,
  };
}

/**
 * Prefix the builder's verdict summary with a fallback label so EVERY downstream
 * delivery shape (Deliverable comment, auto-merged comment, verify builderSummary)
 * tells Jm the work was built by the fallback model. Pure — exported for tests.
 */
export function labelFallbackSummary(summary: string, primaryInfraReason?: InfraReason): string {
  return (
    `[model fallback: built by ${FALLBACK_MODEL} — ${PRIMARY_MODEL} headless spawn unavailable` +
    ` (${primaryInfraReason ?? "unknown"})]\n\n${summary}`
  );
}

// ============================================================================
// Helpers
// ============================================================================

function kayaHome(): string {
  return getKayaHome();
}

/** Per-path AppendLog instances, keyed by absolute path (path varies with KAYA_HOME in tests). */
const runRecordLogs = new Map<string, AppendLog>();

function appendRunRecord(record: Record<string, unknown>): void {
  const logDir = join(kayaHome(), "MEMORY/daemon/cron/logs");
  const logPath = join(logDir, "autonomous-executor.jsonl");
  try {
    let log = runRecordLogs.get(logPath);
    if (!log) {
      log = createAppendLog(logPath);
      runRecordLogs.set(logPath, log);
    }
    log.append(record);
  } catch (err) {
    console.warn(`[executor] failed to append run record: ${err instanceof Error ? err.message : err}`);
  }
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Best-effort `git rev-parse HEAD` — returns "" if it fails (e.g. detached/empty). */
function headSha(wtPath: string): string {
  try {
    return git(["rev-parse", "HEAD"], wtPath).trim();
  } catch {
    return "";
  }
}

/** Best-effort worktree teardown — never throws (cleanup must not mask the real outcome). */
async function cleanupWorktree(wtPath: string): Promise<void> {
  try {
    await removeWorktree(wtPath);
  } catch (err) {
    console.warn(`[executor] worktree cleanup failed for ${wtPath}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Commit any changes the agent left in the worktree and report whether the branch diverged
 * from where it started (`headBefore`). Catches both agent-committed work and work the agent
 * left uncommitted. Pure-ish — touches only git in the isolated worktree.
 */
export function captureWorktreeChanges(
  wtPath: string,
  headBefore: string,
  commitMessage: string
): boolean {
  let dirty = false;
  try {
    dirty = git(["status", "--porcelain"], wtPath).trim().length > 0;
  } catch {
    dirty = false;
  }

  if (dirty) {
    try {
      git(["add", "-A"], wtPath);
      git(["commit", "--no-verify", "-m", commitMessage], wtPath);
    } catch (err) {
      console.warn(`[executor] commit failed in ${wtPath}: ${err instanceof Error ? err.message : err}`);
    }
  }

  const headAfter = headSha(wtPath);
  return dirty || (headAfter !== "" && headAfter !== headBefore);
}

// ============================================================================
// Task selection (exported for tests)
// ============================================================================

/**
 * Select up to `limit` autonomous tasks to run in this batch.
 *
 * STATUS-BASED model (Slice 4b):
 *
 * Work tasks (isReEngagement=false):
 *   disposition='autonomous', status IN ('inbox','next').
 *   This covers both never-worked (fresh) AND previously-failed/paused (retry) uniformly —
 *   failTask and the credit-pool pause both reset status to 'inbox', so they are
 *   automatically re-eligible without any activity-log exclusion.
 *
 * Explicitly excluded:
 *   status='in_progress' — a run is/was working it; claimTask also double-guards.
 *   status IN ('done','cancelled','someday') — closed.
 *
 * Re-engagements (isReEngagement=true):
 *   disposition='autonomous', status='waiting'.
 *   We inspect the newest COMMENT (action='comment') on the task — NOT newest-any-activity
 *   (so a plain updateTask edit by Jm doesn't falsely trigger re-engagement).
 *   If newest comment actor !== 'executor' → Jm or system left feedback → RE-ENGAGE.
 *   If newest comment actor === 'executor' (last delivery, awaiting Jm's review) → SKIP.
 *   If no comments at all → SKIP (delivered state unknown; treat conservatively).
 *
 * Order: inbox/next (work) first, then re-engagements. Total capped at limit.
 *
 * S13 note: this re-engagement SELECTION ("which waiting tasks should the
 * executor pick back up") was reviewed against EscalationHelper
 * (lib/core; the "Needs Jm" escalation surface) for unification and they
 * are DIFFERENT decisions by design — selection decides what the executor
 * works next; escalation decides what gets surfaced to Jm. No shared logic
 * was found to extract (the remediation plan's line refs predated the
 * 07-02 overhaul). Escalations that DO need Jm flow through WaitingOnJm's
 * read-only aggregation, which already consumes EscalationHelper's
 * project convention.
 *
 * Pure-ish (no spawning) — safe for unit tests.
 */
export function selectTasks(db: TaskDB, limit = 3): SelectedTask[] {
  const raw = db.getRawDb();

  // Work tasks: autonomous, inbox or next — fresh AND retry land here uniformly.
  const workRows = raw
    .prepare(
      `SELECT id FROM tasks
       WHERE disposition = 'autonomous'
         AND status IN ('inbox','next')
       ORDER BY created_at ASC`
    )
    .all() as { id: string }[];

  // Re-engagements: autonomous + waiting.
  // We check the newest COMMENT (action='comment') to decide whether Jm has responded.
  // ORDER BY id DESC is insertion-order — created_at has 1-second precision and is
  // unreliable when multiple writes land within the same second.
  const waitingRows = raw
    .prepare(
      `SELECT id FROM tasks
       WHERE disposition = 'autonomous'
         AND status = 'waiting'
       ORDER BY created_at ASC`
    )
    .all() as { id: string }[];

  // Prepared statement: newest COMMENT (action='comment') by insertion order
  const newestCommentActorStmt = raw.prepare(
    `SELECT actor FROM activity_log
     WHERE task_id = ? AND action = 'comment'
     ORDER BY id DESC LIMIT 1`
  );

  const reEngagements: SelectedTask[] = [];
  for (const row of waitingRows) {
    const newest = newestCommentActorStmt.get(row.id) as { actor: string } | null;
    // Only re-engage if there IS a comment AND the newest one is from a non-executor
    // (i.e. Jm or system left feedback since the last delivery).
    if (newest && newest.actor !== "executor") {
      reEngagements.push({ taskId: row.id, isReEngagement: true });
    }
    // newest === null → no comments → SKIP (state unknown, don't double-run)
    // newest.actor === 'executor' → awaiting Jm's review → SKIP
  }

  const work: SelectedTask[] = workRows.map((r) => ({
    taskId: r.id,
    isReEngagement: false,
  }));

  // Work tasks first, then re-engagements, capped at limit
  return [...work, ...reEngagements].slice(0, limit);
}

// ============================================================================
// Zombie reclaim — stranded-in_progress sweep
//
// The problem (diagnosed 2026-08-23, task t-mt1pnmvb): claimTask() sets status='in_progress',
// and every recovery path (failTask, the 6a credit-pool pause, deliverTask) resets it — but
// ONLY if this process lives long enough to run one of them. The nightly cron's outer 2h
// timeout SIGKILLs the whole executor process mid-agent; a lid-close Maintenance Sleep does
// the same to session-spawned runs. SIGKILL runs no handlers, so the task stays
// 'in_progress' forever, and selectTasks() excludes 'in_progress' by design — the task is
// stranded until a human notices (t-mt1pnmvb sat 24h+ and was reset by hand).
//
// The fix: at poll start — FIRST, before sweepPendingMerges()/selectTasks() — reclaim any
// autonomous task that has been in_progress longer than ZOMBIE_STALE_HOURS: write an
// EXECUTOR_RECLAIM comment (audit trail, mirrors failTask's comment-before-status ordering)
// and reset status to 'inbox' so selectTasks() re-picks it in this very batch.
//
// Why staleness instead of a lock check: poll() only runs after acquireLock() succeeded, so
// no OTHER poll is live — but `executor.ts run <taskId>` and manual session claims don't hold
// the run lock, and a legitimate run can occupy a task for ~2.5h (90min builder + verify +
// merge). The threshold (default 6h, > 2× the longest legitimate run, < the 24h nightly
// cadence) is what separates "still working" from "stranded".
// ============================================================================

/** In_progress older than this is considered stranded. Longest legitimate run is ~2.5h
 *  (90min builder spawn + verify spawn + merge); nightly cadence is 24h — 6h sits safely
 *  between. Exported for tests. */
export const ZOMBIE_STALE_HOURS = 6;

export interface ZombieReclaimResult {
  taskId: string;
  title: string;
  /** Hours the task had been sitting in_progress, rounded to 0.1h. */
  staleHours: number;
}

export interface ZombieReclaimDeps {
  /** Injectable clock (ms since epoch) for tests. Defaults to Date.now. */
  nowMs?: () => number;
  /** Staleness threshold override. Defaults to ZOMBIE_STALE_HOURS. */
  staleHours?: number;
}

/**
 * Reclaim autonomous tasks stranded in_progress by a dead run (see the section docstring).
 * `updated_at` is the staleness signal: claimTask()'s updateTask stamps it at claim time and
 * nothing touches it again until deliver/fail — so its age IS the time spent in_progress.
 * Pure-ish (DB reads/writes only, no spawning, no alerting — poll() owns the alert) — safe
 * for unit tests.
 */
export function sweepZombieTasks(db: TaskDB, deps: ZombieReclaimDeps = {}): ZombieReclaimResult[] {
  const staleHours = deps.staleHours ?? ZOMBIE_STALE_HOURS;
  const now = (deps.nowMs ?? Date.now)();
  const raw = db.getRawDb();

  const rows = raw
    .prepare(
      `SELECT id, title, updated_at FROM tasks
       WHERE disposition = 'autonomous'
         AND status = 'in_progress'
       ORDER BY created_at ASC`
    )
    .all() as { id: string; title: string; updated_at: string }[];

  const reclaimed: ZombieReclaimResult[] = [];
  for (const row of rows) {
    // updated_at is an ISO string (TaskDB stamps new Date().toISOString() on every write).
    // An unparseable value makes ageMs NaN, the >= comparison false, and the row is left
    // alone — never reclaim on garbage data.
    const ageMs = now - Date.parse(row.updated_at);
    if (!(ageMs >= staleHours * 3600_000)) continue;

    const staleH = Math.round((ageMs / 3600_000) * 10) / 10;
    // Comment BEFORE status flip (failTask's ordering): the audit trail is never missing
    // on a DB error partway through.
    db.addComment(
      row.id,
      `EXECUTOR_RECLAIM: stranded in_progress for ${staleH}h — a previous run died after claim ` +
        `but before reset (timeout-SIGKILL / sleep kill). Reset to inbox for retry.`,
      "executor"
    );
    db.updateTask(row.id, { status: "inbox" }, "executor");
    reclaimed.push({ taskId: row.id, title: row.title, staleHours: staleH });
    console.log(`[executor] zombie-reclaim: ${row.id} ("${row.title}") in_progress ${staleH}h → inbox`);
  }

  return reclaimed;
}

// ============================================================================
// Pending-merge sweep (F2 fix round, defect 2)
//
// The problem: runAutoMerge's deferred path (interactive session lock live) writes a marker
// comment, then F1's deliverTask() sets status=waiting with ANOTHER executor-actor comment on
// top of it — so selectTasks()'s re-engagement rule ("newest comment actor !== 'executor'")
// never fires for it. The "will retry once the session ends" promise in that comment was
// unbacked by any code path: the task stalled forever without a human comment.
//
// The fix: a sweep that runs BEFORE selectTasks() in poll(), scans the PERSISTED comment trail
// (never in-memory state — a poll() call has no memory of a PREVIOUS poll()'s process, which
// may well have been a different process entirely) for waiting tasks carrying an unresolved
// MERGE_DEFERRED marker, and — once the lock is clear — re-runs ONLY runAutoMerge on the
// recorded branch/worktree. The work was already built + verified (verdict "pass") at defer
// time, so this NEVER spawns a builder agent.
// ============================================================================

export interface PendingMergeCandidate {
  taskId: string;
  branch: string;
  /** From the structured MERGE_DEFERRED marker. Null for a legacy prose-only comment (written
   *  before this fix shipped) — sweepPendingMerges resolves it via resolveLegacyWorktree. */
  wtPath: string | null;
  summary: string;
}

const MERGE_FAILED_PREFIX = "MERGE_FAILED:"; // mirrors formatMergeFailedComment's own prefix

const LEGACY_DEFERRED_SUMMARY =
  "Auto-merge retry (recovered from a pre-fix-round deferred-merge comment with no structured marker).";

/**
 * Find the newest DECISIVE merge-related comment on a task, walking NEWEST-FIRST by raw `id
 * DESC` (NOT getActivityLog()'s `created_at DESC` — created_at has only 1-second precision and
 * the deferred marker + F1's deliverTask() comment on top of it are written back-to-back in the
 * SAME synchronous call, so they can tie within a second; selectTasks() hits this exact issue
 * and already works around it with `ORDER BY id DESC`, so this mirrors that convention).
 *
 * Stops walking at the first non-'executor' comment: a human commented since, so normal
 * re-engagement (selectTasks) owns this task now, not the sweep. Non-decisive comments in
 * between (the Deliverable comment written right after the marker, EXECUTOR_VERIFY, ...) are
 * skipped over silently — they carry no merge-sweep signal of their own.
 *
 * Returns:
 *   - a candidate when the newest decisive marker is MERGE_DEFERRED (new structured format, or
 *     the legacy prose-only phrase it replaces — see executorMerge.ts's
 *     LEGACY_MERGE_DEFERRED_PHRASE, the migration path for tasks stuck under the pre-fix flow).
 *   - null when the newest decisive marker is MERGE_FAILED (the existing human-review path
 *     already owns this task — a real conflict, not a session-lock defer) or when no decisive
 *     marker exists at all (e.g. a plain first-time delivery, never attempted a merge).
 *
 * Pure (DB reads only) — exported for tests.
 */
export function detectPendingMerge(db: TaskDB, taskId: string): PendingMergeCandidate | null {
  const raw = db.getRawDb();
  const rows = raw
    .prepare(
      `SELECT actor, changes FROM activity_log
       WHERE task_id = ? AND action = 'comment'
       ORDER BY id DESC LIMIT 20`
    )
    .all(taskId) as { actor: string; changes: string | null }[];

  for (const row of rows) {
    if (row.actor !== "executor") break; // human intervened since — not the sweep's job

    let text: string;
    try {
      text = (JSON.parse(row.changes ?? "{}").text as string | undefined) ?? "";
    } catch {
      continue;
    }

    if (text.startsWith(MERGE_FAILED_PREFIX)) return null; // existing human-review path owns this

    const marker = parseMergeDeferredMarker(text);
    if (marker) {
      return { taskId, branch: marker.branch, wtPath: marker.wtPath, summary: marker.summary };
    }
    if (text.includes(LEGACY_MERGE_DEFERRED_PHRASE)) {
      return { taskId, branch: `executor/task-${taskId}`, wtPath: null, summary: LEGACY_DEFERRED_SUMMARY };
    }
  }
  return null;
}

/**
 * Scan waiting autonomous tasks for a pending (still-unresolved) deferred merge, capped at
 * `limit` (poll() reuses its own batch limit here — "process at most a handful per poll").
 * Pure-ish (DB reads only, no spawning, no merge attempt) — mirrors selectTasks()'s shape,
 * safe for unit tests.
 */
export function findPendingMergeCandidates(db: TaskDB, limit: number): PendingMergeCandidate[] {
  const raw = db.getRawDb();
  const waitingRows = raw
    .prepare(`SELECT id FROM tasks WHERE disposition = 'autonomous' AND status = 'waiting' ORDER BY created_at ASC`)
    .all() as { id: string }[];

  const candidates: PendingMergeCandidate[] = [];
  for (const row of waitingRows) {
    if (candidates.length >= limit) break;
    const candidate = detectPendingMerge(db, row.id);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export type PendingMergeOutcome = "merged" | "merge-failed" | "verify-failed" | "still-locked";

export interface PendingMergeSweepResult {
  taskId: string;
  outcome: PendingMergeOutcome;
}

export interface PendingMergeSweepDeps {
  /** Single, batch-wide gate — checked ONCE before touching any candidate (mirrors
   *  Integrator._mergeCompletedCore's "defer the whole batch" pattern), so a still-live session
   *  never triggers a runAutoMerge call — and therefore never writes a fresh comment — for any
   *  candidate. No comment spam. Defaults to the real checkInteractiveSessionLock. */
  checkInteractiveLock?: () => InteractiveLockInfo | null;
  /** Forwarded verbatim into runAutoMerge. Production leaves this undefined so runAutoMerge
   *  uses its own real defaults (identical wiring to runTask's call) — tests inject fakes. */
  autoMergeDeps?: AutoMergeDeps;
  /** Resolves a worktree path for a LEGACY candidate (wtPath === null). Production reuses the
   *  same getOrCreateWorktree() call runTask made when the branch was first created —
   *  keepUntilMerged kept it alive, so this is a safe, idempotent re-fetch, never a fresh
   *  create. Tests inject a fake to avoid touching real git/filesystem. */
  resolveLegacyWorktree?: (branch: string, taskId: string) => Promise<string>;
}

async function defaultResolveLegacyWorktree(branch: string, taskId: string): Promise<string> {
  const wt = await getOrCreateWorktree({
    repoRoot: kayaHome(),
    branch,
    createdBy: `executor:${taskId}`,
    keepUntilMerged: true,
  });
  return wt.path;
}

/**
 * Retry previously-deferred Lane A auto-merges. Runs BEFORE selectTasks() in poll(). Re-runs
 * ONLY the merge step (runAutoMerge) on the recorded branch/worktree — the verdict was already
 * "pass" and the work already built + verified at defer time, so this NEVER spawns a builder
 * agent (no spawnAgent call anywhere in this function or anything it calls).
 *
 * See the section docstring above for the defect this fixes and findPendingMergeCandidates /
 * detectPendingMerge for how candidates are found purely from the persisted comment trail.
 */
export async function sweepPendingMerges(
  db: TaskDB,
  limit: number,
  deps: PendingMergeSweepDeps = {},
): Promise<PendingMergeSweepResult[]> {
  const candidates = findPendingMergeCandidates(db, limit);
  if (candidates.length === 0) return [];

  const checkLock = deps.checkInteractiveLock ?? checkInteractiveSessionLock;
  if (checkLock()) {
    // Still locked — leave EVERY candidate untouched. No runAutoMerge call, no new comment.
    return candidates.map((c) => ({ taskId: c.taskId, outcome: "still-locked" as const }));
  }

  const resolveLegacyWorktree = deps.resolveLegacyWorktree ?? defaultResolveLegacyWorktree;
  const results: PendingMergeSweepResult[] = [];

  for (const candidate of candidates) {
    const task = db.getTask(candidate.taskId);
    if (!task) continue; // deleted between selection and now — nothing to retry

    let wtPath = candidate.wtPath;
    if (!wtPath) {
      try {
        wtPath = await resolveLegacyWorktree(candidate.branch, candidate.taskId);
      } catch (err) {
        recordFailure({
          source: "executor:mergeSweep:legacyWorktree",
          error: err,
          context: { taskId: candidate.taskId, branch: candidate.branch },
        });
        continue; // leave untouched — retried again next poll
      }
    }

    const outcome = await runAutoMerge(
      db,
      {
        taskId: candidate.taskId,
        title: task.title,
        branch: candidate.branch,
        wtPath,
        repoRoot: kayaHome(),
        summary: candidate.summary,
        verdict: "pass",
      },
      deps.autoMergeDeps,
    );

    if (outcome.kind === "merged") {
      appendRunRecord({
        timestamp: new Date().toISOString(),
        event: "mergeSweep",
        taskId: candidate.taskId,
        title: task.title,
        merged: true,
        mergeSha: outcome.sha,
      });
      console.log(`[executor] pending-merge sweep: auto-merged ${candidate.taskId} → main @ ${outcome.sha}`);
      results.push({ taskId: candidate.taskId, outcome: "merged" });
    } else if (outcome.kind === "merge-failed") {
      results.push({ taskId: candidate.taskId, outcome: "merge-failed" });
    } else if (outcome.kind === "verify-failed") {
      results.push({ taskId: candidate.taskId, outcome: "verify-failed" });
    } else {
      // "deferred" (the lock reappeared in the race window between our batch check and this
      // call — runAutoMerge already wrote its own fresh, legitimate marker comment for that
      // real state change) or "skipped" (never happens here — verdict is always "pass").
      results.push({ taskId: candidate.taskId, outcome: "still-locked" });
    }
  }

  return results;
}

// ============================================================================
// Core run function (exported for Slice 2 / tests)
// ============================================================================

/**
 * Run a single autonomous task.
 *
 * Returns a TaskResult — never calls process.exit() internally.
 * All failTask + sendAlert loud-fail paths are preserved.
 * The `run <taskId>` CLI wrapper translates the result to an exit code.
 */
export async function runTask(
  taskId: string,
  opts?: { isReEngagement?: boolean }
): Promise<TaskResult> {
  const db = getTaskDB();

  // 1. Load task
  const task = db.getTask(taskId);
  if (!task) {
    process.stderr.write(`[executor] task not found: ${taskId}\n`);
    return { taskId, status: "failed", reason: "task not found" };
  }

  // 2. Assert autonomous disposition
  if (task.disposition !== "autonomous") {
    process.stderr.write(
      `[executor] refusing to run task ${taskId}: disposition='${task.disposition ?? "(null)"}' is not 'autonomous'\n`
    );
    return {
      taskId,
      status: "skipped",
      reason: `disposition='${task.disposition ?? "(null)"}' is not 'autonomous'`,
    };
  }

  // 3. Claim (in_progress guard)
  const claimed = claimTask(db, taskId);
  if (!claimed) {
    console.log(`[executor] task ${taskId} already claimed/closed — skipping`);
    return { taskId, status: "skipped", reason: "already claimed/closed" };
  }

  // 3b. Lane A spine visibility (slice F2): best-effort cross-ref event, never blocks the run.
  appendLaneAEvent({ taskId, toStage: "lane-a-started" });

  // 4. Isolate into a per-task git worktree so a code-writing agent never touches the live
  //    shared checkout (the documented 2026-06-22 data-loss class). Re-engagement reuses the
  //    SAME branch (createdBy matches), so prior work is intact on retry/feedback.
  const branch = `executor/task-${taskId}`;
  let wtPath: string;
  try {
    const wt = await getOrCreateWorktree({
      repoRoot: kayaHome(),
      branch,
      createdBy: `executor:${taskId}`,
      keepUntilMerged: true,
    });
    wtPath = wt.path;
  } catch (err) {
    const reason = `worktree setup failed: ${err instanceof Error ? err.message : err}`;
    failTask(db, taskId, reason);
    await sendAlert(`Autonomous executor failed: ${task.title} — ${reason}`, {
      key: `executor-fail-${taskId}`,
      tier: "page",
      cooldownMs: 3600000,
      fingerprint: reason.slice(0, 80),
    });
    appendRunRecord({
      timestamp: new Date().toISOString(),
      taskId,
      title: task.title,
      verdict: "failed",
      reason,
    });
    process.stderr.write(`[executor] FAILED: ${reason}\n`);
    return { taskId, status: "failed", reason };
  }
  const headBefore = headSha(wtPath);

  // 5. Build prompt + spawn agent in the isolated worktree
  const activityLog = db.getActivityLog(taskId, 50);
  const isReEngagement = opts?.isReEngagement ?? false;
  const prompt = buildAgentPrompt(task, activityLog, isReEngagement);

  console.log(`[executor] spawning ${PRIMARY_MODEL} agent for task ${taskId} in worktree ${wtPath}: "${task.title}"`);
  const spawnOutcome = spawnBuilderAgent(prompt, { timeoutMs: 90 * 60 * 1000, cwd: wtPath });
  const res = spawnOutcome.res;
  if (spawnOutcome.fellBack) {
    console.log(
      `[executor] ${PRIMARY_MODEL} spawn infra-unavailable (${spawnOutcome.primaryInfraReason ?? "unknown"}) — retried task ${taskId} on ${FALLBACK_MODEL}`
    );
  }

  // 6. Failure handling — fail loud, never silent.
  //
  // 6a. CREDIT-POOL / INFERENCE-UNAVAILABLE branch — checked FIRST.
  //     Condition: res.infraUnavailable, forwarded verbatim from AgentSpawner's OWN
  //     classification (see lib/core/AgentSpawner.ts's isInfraUnavailable — the canonical
  //     detector, no longer duplicated here as of slice S13). True when the spawn did not
  //     succeed AND any of: pre-spawn-gated, timed out, blank-blank output (silent infra
  //     shutdown), a network/DNS failure reaching the API, a rate/usage/session-limit
  //     notice (shared RateLimitGuard detector), or another credit-pool/quota/overload
  //     signal.
  //     We do NOT blame the task here: reset to inbox for retry, alert with a
  //     distinct key+fingerprint so Jm can tell a pool pause from a task failure.
  //     The alert key/fingerprint stay fixed regardless of reason (preserves the
  //     AlertGate cooldown state across reasons) — only the human-facing text below
  //     varies, distinguishing a network/DNS outage (res.infraReason === "network")
  //     from every other infra-unavailable reason. See AgentSpawner.classifyInfraReason
  //     for the full reason set and its precedence order.
  if (res.infraUnavailable) {
    const baseReasonText =
      res.infraReason === "network" ? "API unreachable (network/DNS)" : "inference/credit-pool unavailable";
    // When we get here after a fallback, BOTH models were infra-unavailable — say so, so Jm
    // can tell a primary-only overload (fallback handles it) from a full pool/network outage.
    const infraReasonText = spawnOutcome.fellBack
      ? `${baseReasonText} on both ${PRIMARY_MODEL} and the ${FALLBACK_MODEL} fallback`
      : baseReasonText;

    await cleanupWorktree(wtPath); // branch persists; retry recreates it
    db.addComment(taskId, `EXECUTOR_PAUSED: ${infraReasonText}; will retry`, "executor");
    db.updateTask(taskId, { status: "inbox" }, "executor");

    await sendAlert(
      `Autonomous executor paused — ${infraReasonText} (task ${task.title})`,
      {
        key: "executor-credit-pool",
        tier: "page",
        fingerprint: "credit-pool-paused",
        cooldownMs: 4 * 60 * 60 * 1000, // 4h — pool can resume within that window
        // The fingerprint is deliberately STATIC, so without a TTL it paged
        // exactly once ever (last: 2026-07-09) and silently ate the Aug 18-24
        // failure streak. A pool that stays down re-pages daily.
        fingerprintTtlMs: 24 * 60 * 60 * 1000,
      }
    );

    appendRunRecord({
      timestamp: new Date().toISOString(),
      taskId,
      title: task.title,
      verdict: "failed",
      status: "paused",
      reason: "credit-pool-paused",
      fallbackTried: spawnOutcome.fellBack,
    });

    process.stderr.write(`[executor] PAUSED: ${infraReasonText} — task ${taskId} reset to inbox for retry\n`);
    return { taskId, status: "failed", reason: "credit-pool-paused" };
  }

  // 6b. Generic failure — real spawn error, non-empty stderr, or timeout.
  //     Uses failTask (EXECUTOR_FAIL comment + inbox reset) + task-specific alert key.
  if (!res.success || res.stdout.trim().length === 0) {
    const baseFailReason = res.timedOut
      ? "agent timed out (90 min)"
      : res.stdout.trim().length === 0
      ? "agent returned empty stdout"
      : `agent exited with code ${res.exitCode}`;
    const reason = spawnOutcome.fellBack
      ? `${baseFailReason} (${FALLBACK_MODEL} fallback run, after ${PRIMARY_MODEL} infra-unavailable)`
      : baseFailReason;

    await cleanupWorktree(wtPath);
    failTask(db, taskId, reason);
    await sendAlert(`Autonomous executor failed: ${task.title} — ${reason}`, {
      key: `executor-fail-${taskId}`,
      tier: "page",
      cooldownMs: 3600000,
      fingerprint: reason.slice(0, 80),
    });

    appendRunRecord({
      timestamp: new Date().toISOString(),
      taskId,
      title: task.title,
      verdict: "failed",
      reason,
    });

    process.stderr.write(`[executor] FAILED: ${reason}\n`);
    return { taskId, status: "failed", reason };
  }

  // 7. Parse verdict (loud-fail if the agent didn't report — this is NOT output verification,
  //    it detects "the agent didn't emit a verdict at all").
  const verdict = parseVerdict(res.stdout);
  if (!verdict) {
    const reason = "unparseable verdict — agent did not emit EXECUTOR_VERDICT_START/END block";
    await cleanupWorktree(wtPath);
    failTask(db, taskId, reason);
    await sendAlert(`Autonomous executor failed: ${task.title} — ${reason}`, {
      key: `executor-fail-${taskId}`,
      tier: "page",
      cooldownMs: 3600000,
      fingerprint: reason.slice(0, 80),
    });

    appendRunRecord({
      timestamp: new Date().toISOString(),
      taskId,
      title: task.title,
      verdict: "failed",
      reason,
    });

    process.stderr.write(`[executor] FAILED: ${reason}\n`);
    return { taskId, status: "failed", reason };
  }

  // 7b. Label the delivery when the work was built by the fallback model — the prefix rides the
  //     summary into every downstream shape (Deliverable comment, auto-merged comment, verify
  //     builderSummary), so Jm always sees which model did the work.
  const deliverySummary = spawnOutcome.fellBack
    ? labelFallbackSummary(verdict.summary, spawnOutcome.primaryInfraReason)
    : verdict.summary;

  // 8. Capture the work. NO output-verification gate — Jm verifies the result manually and steers
  //    via board feedback. Commit anything the agent left so it's preserved on the branch; if the
  //    run produced no repo changes (pure research/external task), tear the worktree down.
  const hasChanges = captureWorktreeChanges(
    wtPath,
    headBefore,
    `executor: ${task.title} (task ${taskId})`
  );

  // 6b. Verify — SKEPTICAL second-agent review of the branch diff. Only runs when there ARE
  //     committed repo changes to review (the worktree still exists here; below, it gets torn
  //     down when !hasChanges, so verification must happen before that teardown — it does,
  //     because it's gated on the same hasChanges condition and runs first).
  //     Infra-unavailable (rate limit / credit pool / timeout) is NEVER treated as "verified" —
  //     it delivers with an explicit "verification skipped: infra" marker + recordFailure so
  //     Jm can always tell "reviewed and flagged" apart from "never reviewed."
  let verifyPayload: { verdict: "pass" | "fail" | "uncertain"; reasoning: string } | undefined;
  let verifySkipped: string | undefined;
  let verifyLogField: Record<string, unknown> | undefined;
  // Slice F2 — set only when there IS a real verify verdict (never for the infra-skip path).
  // undefined means "no merge attempt was even considered" (no changes, or verify skipped).
  let mergeOutcome: AutoMergeOutcome | undefined;

  if (hasChanges) {
    const verifyOutcome = runVerification({
      task: { id: taskId, title: task.title, description: task.description },
      branch,
      wtPath,
      builderSummary: deliverySummary,
    });

    if (verifyOutcome.kind === "infra-unavailable") {
      verifySkipped = "infra";
      verifyLogField = { skipped: "infra", reason: verifyOutcome.reason };
      recordFailure({
        source: "executor:verify",
        error: verifyOutcome.reason,
        context: { taskId, branch },
      });
      process.stderr.write(
        `[executor] verify SKIPPED (infra unavailable) for ${taskId}: ${verifyOutcome.reason}\n`
      );
    } else {
      const record = verifyOutcome.record;
      recordVerification(db, taskId, record);
      verifyPayload = { verdict: record.verdict, reasoning: record.reasoning };
      verifyLogField = {
        verdict: record.verdict,
        reasoning: record.reasoning,
        checkedCommands: record.checkedCommands,
        agentDurationMs: record.agentDurationMs,
      };
      // degraded = the agent never produced a real verdict (crashed / no parseable block) —
      // distinct from a genuine "uncertain" judgment, and worth a forensic recordFailure line.
      if (record.degraded) {
        recordFailure({
          source: "executor:verify",
          error: record.reasoning,
          context: { taskId, branch, verdict: record.verdict },
        });
      }
      console.log(`[executor] verify ${record.verdict} for ${taskId}: ${record.reasoning}`);

      // Lane A spine visibility (slice F2): best-effort, note carries the genuine verdict.
      appendLaneAEvent({ taskId, toStage: "lane-a-verified", note: record.verdict });

      // 6c. Auto-merge (slice F2) — only a "pass" verdict attempts anything here; fail/uncertain
      //     fall straight through to today's F1 waiting+comment path below, unchanged.
      //     repoRoot is the REAL kaya tree (kayaHome()), never wtPath — merge-to-main.sh must run
      //     from the repo root, not a worktree (see executorMerge.ts's runAutoMerge docstring).
      mergeOutcome = await runAutoMerge(db, {
        taskId,
        title: task.title,
        branch,
        wtPath,
        repoRoot: kayaHome(),
        summary: deliverySummary,
        verdict: record.verdict,
      });
    }
  }

  if (!hasChanges) {
    await cleanupWorktree(wtPath);
  }

  // 6d. A clean auto-merge closes the task itself (taskBookkeeper.mergeTask set status=done +
  //     wrote the merged comment) — skip the normal waiting+comment deliverTask() call entirely.
  //     Every other merge outcome (skipped/deferred/merge-failed/verify-failed) falls through to
  //     the unchanged F1 deliverTask() path below; runAutoMerge already wrote its own marker
  //     comment (deferred/failed) in those cases, in ADDITION to the deliverable comment below.
  if (mergeOutcome?.kind === "merged") {
    appendRunRecord({
      timestamp: new Date().toISOString(),
      taskId,
      title: task.title,
      verdict: "delivered",
      branch,
      hasChanges,
      verify: verifyLogField,
      merged: true,
      mergeSha: mergeOutcome.sha,
      model: spawnOutcome.model,
    });
    console.log(`[executor] auto-merged: ${taskId} → main @ ${mergeOutcome.sha}`);
    return { taskId, status: "delivered" };
  }

  // 7. Deliver — status → waiting + a reviewable comment (branch diff or external artifact),
  //    now including the verification verdict (or an explicit skip marker) prominently.
  deliverTask(db, taskId, {
    summary: deliverySummary,
    artifacts: verdict.artifacts,
    branch,
    hasChanges,
    verify: verifyPayload,
    verifySkipped,
  });

  // 8. Append run record + report
  appendRunRecord({
    timestamp: new Date().toISOString(),
    taskId,
    title: task.title,
    verdict: "delivered",
    branch: hasChanges ? branch : undefined,
    artifacts: verdict.artifacts,
    hasChanges,
    verify: verifyLogField,
    model: spawnOutcome.model,
  });

  console.log(`[executor] delivered: ${taskId}${hasChanges ? ` → branch ${branch}` : ""}`);
  console.log(`[executor] summary: ${deliverySummary}`);
  return { taskId, status: "delivered" };
}

// ============================================================================
// Poll — batch selection and execution
// ============================================================================

async function poll(limit: number): Promise<void> {
  if (!acquireLock()) {
    console.log("[executor] another executor run is active — exiting");
    return;
  }

  try {
    const db = getTaskDB();

    // Zombie reclaim — FIRST, before selectTasks(): reset autonomous tasks stranded
    // in_progress by a dead run (timeout-SIGKILL / sleep kill after claim, before reset —
    // see sweepZombieTasks's docstring) so they're inbox-eligible in THIS batch. The alert
    // is the only signal Jm ever gets about that death: the killed run alerted nothing
    // (SIGKILL runs no handlers), so this must page, not just log.
    const reclaimed = sweepZombieTasks(db);
    if (reclaimed.length > 0) {
      console.log(`[executor] zombie-reclaim: ${reclaimed.length} stranded task(s) reset to inbox`);
      appendRunRecord({
        timestamp: new Date().toISOString(),
        event: "zombieReclaim",
        reclaimed,
      });
      await sendAlert(
        `Autonomous executor reclaimed ${reclaimed.length} stranded task(s) — a previous run was killed mid-task: ${reclaimed
          .map((r) => `${r.title} (${r.staleHours}h)`)
          .join("; ")}`,
        {
          key: "executor-zombie-reclaim",
          tier: "page",
          cooldownMs: 4 * 60 * 60 * 1000,
          // Task-id-varying fingerprint + TTL: a NEW stranding always pages, and the SAME
          // task re-stranding repeatedly re-pages daily instead of once ever (the
          // static-fingerprint silence class that ate the Aug 18-24 failure streak).
          fingerprint: reclaimed.map((r) => r.taskId).join(",").slice(0, 80),
          fingerprintTtlMs: 24 * 60 * 60 * 1000,
        }
      );
    }

    // Pending-merge sweep (F2 fix round, defect 2) — BEFORE selectTasks(): retry any
    // previously-deferred auto-merge whose interactive-session lock has since cleared. Never
    // spawns a builder agent — see sweepPendingMerges's docstring.
    const sweepResults = await sweepPendingMerges(db, limit);
    if (sweepResults.length > 0) {
      const merged = sweepResults.filter((r) => r.outcome === "merged").length;
      console.log(`[executor] pending-merge sweep: ${sweepResults.length} candidate(s), ${merged} merged`);
      appendRunRecord({
        timestamp: new Date().toISOString(),
        event: "mergeSweep.summary",
        candidates: sweepResults.length,
        results: sweepResults,
      });
    }

    const selected = selectTasks(db, limit);

    if (selected.length === 0) {
      console.log("[executor] poll: no autonomous tasks ready");
      appendRunRecord({
        timestamp: new Date().toISOString(),
        event: "poll",
        tasksSelected: 0,
      });
      return;
    }

    console.log(`[executor] poll: selected ${selected.length} task(s)`);
    const results: TaskResult[] = [];

    for (const { taskId, isReEngagement } of selected) {
      // Pre-spawn gate: if the session-wide rate limit is already near the cap,
      // STOP the batch rather than burn an opus spawn into a dead window (the
      // last task of a 3-agent batch was systematically at risk). Best-effort —
      // RateLimitGuard treats >10min-stale state as "no data" and returns false,
      // so a missing/stale state file never blocks work; the post-spawn 6a branch
      // remains the reliable backstop. Tasks left unrun stay inbox-eligible for
      // the next run, so this defers — it never drops work.
      if (isRateLimited()) {
        process.stderr.write(
          `[executor] PAUSED before ${taskId}: session rate limit near cap — deferring remaining ${selected.length - results.length} task(s) to next run\n`
        );
        await sendAlert("Autonomous executor deferred batch — session rate limit near cap", {
          key: "executor-credit-pool",
          tier: "page",
          fingerprint: "credit-pool-paused",
          cooldownMs: 4 * 60 * 60 * 1000,
          // Static fingerprint — same 24h refire as the 6a branch above, so a
          // persistent rate-limit/pool pause pages daily instead of once ever.
          fingerprintTtlMs: 24 * 60 * 60 * 1000,
        });
        appendRunRecord({
          timestamp: new Date().toISOString(),
          event: "poll.deferred",
          reason: "rate-limit-near-cap",
          deferred: selected.length - results.length,
        });
        break;
      }

      try {
        const result = await runTask(taskId, { isReEngagement });
        results.push(result);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[executor] unhandled error for ${taskId}: ${reason}\n`);
        results.push({ taskId, status: "failed", reason });
      }
    }

    appendRunRecord({
      timestamp: new Date().toISOString(),
      event: "poll",
      tasksSelected: selected.length,
      results,
    });

    const delivered = results.filter((r) => r.status === "delivered").length;
    const failed = results.filter((r) => r.status === "failed").length;
    console.log(`[executor] poll complete: ${delivered} delivered, ${failed} failed, ${results.length - delivered - failed} skipped`);

    // Partial failure visibility: exit non-zero when any task failed so cron
    // wrappers / watchdogs can detect dropout. Success path (zero failures)
    // is unchanged — process.exitCode remains 0.
    if (failed > 0) {
      process.stderr.write(`[executor] poll: ${failed} task(s) failed — exiting non-zero\n`);
      process.exitCode = 1;
    }
  } finally {
    releaseLock();
  }
}

// ============================================================================
// CLI entry
// ============================================================================

if (import.meta.main) {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === "run") {
    const taskId = rest[0];
    if (!taskId) {
      process.stderr.write("Usage: bun executor.ts run <taskId>\n");
      process.exit(1);
    }

    runTask(taskId, { isReEngagement: false })
      .then((result) => {
        if (result.status === "delivered") {
          process.exit(0);
        } else if (result.status === "skipped") {
          process.exit(0);
        } else {
          process.exit(1);
        }
      })
      .catch((err) => {
        process.stderr.write(`[executor] unhandled error: ${err instanceof Error ? err.message : err}\n`);
        process.exit(1);
      });
  } else if (cmd === "poll") {
    // Parse --limit N
    let limit = 3;
    const limitIdx = rest.indexOf("--limit");
    if (limitIdx !== -1 && rest[limitIdx + 1]) {
      const parsed = parseInt(rest[limitIdx + 1], 10);
      if (!isNaN(parsed) && parsed > 0) limit = parsed;
    }

    poll(limit).catch((err) => {
      process.stderr.write(`[executor] poll unhandled error: ${err instanceof Error ? err.message : err}\n`);
      releaseLock();
      process.exit(1);
    });
  } else {
    process.stderr.write("Usage: bun executor.ts run <taskId>\n       bun executor.ts poll [--limit <n>]\n");
    process.exit(1);
  }
}
