#!/usr/bin/env bun
/**
 * IntakeRunner.ts — Unified LucidTasks intake + spec-pipeline backfill runner
 *
 * Replaces the deleted KayaTaskClassifier CLI (triage-sweep, retired 2026-06-18
 * per commit 8dff87ee — "routing now lives in KayaRouter.ts", which was never
 * built). KayaTaskClassifier.ts stays a pure library: LLM clarity+scope
 * classification, triage-stamp helpers, backfill routing pure functions. This
 * file is the only place those helpers are wired to real I/O + a CLI.
 *
 * Two phases, independently toggleable via --backfill / --enqueue:
 *
 *   --backfill  Re-judges spec-pipeline items parked at "intake" (status
 *               "awaiting-context"). Grilled items (valid grillStamp) are
 *               never re-judged — see partitionGrilledItems. clear → advance
 *               to researching (advanceClearItem). needs-grill/not-executable
 *               → park at needs-grilling (parkForGrill) — "zero invisible
 *               items": every judged row ends in a visible stage.
 *
 *   --enqueue   Classifies LucidTasks with disposition='autonomous' (see
 *               DISPOSITION_CONTRACT.md) that aren't already linked to a
 *               pipeline item and don't carry a valid triage stamp. The LLM
 *               judges clarity AND scope:
 *                 - clear + scope=project     → qm.addSpecPipelineItem
 *                   (research + spec before work begins)
 *                 - clear + scope=lightweight
 *                   (or scope absent — safe default) → triage-stamped and
 *                   left as disposition='autonomous' for the Lane A
 *                   autonomous executor to run directly, no spec pipeline.
 *                 - needs-grill / not-executable → enqueued AND parked at
 *                   needs-grilling (same visible-holding-pen rule as backfill).
 *               Dedup: a lucid_task_id already present on a non-archived
 *               pipeline item blocks a duplicate enqueue (defense in depth —
 *               the primary guard is the triage stamp, checked first).
 *
 * STEP ASSERTS WORK: every run prints one JSON accounting line
 * {classified, advanced, parked, enqueued, skippedStamped}. If there were
 * candidates to classify this run and NOT ONE verdict came back (total LLM
 * outage), that's recorded via FailureLog (tier: digest) and the process
 * exits non-zero. Exit 0 must mean verified work or verified-nothing-to-do.
 *
 * @module IntakeRunner
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { QueueManager, type QueueItem } from "./QueueManager.ts";
import { getRepoForQueuesDir } from "./PipelineFacade.ts";
import { recordFailure } from "../../../../lib/core/FailureLog.ts";
import { getAlertGate, type AlertGate } from "../../../../lib/core/AlertGate.ts";
import { kayaHomePath } from "../../../../lib/core/KayaHome.ts";
// cross-skill-allowed: IntakeRunner IS the LucidTasks→queue intake bridge from the 07-02 pipeline overhaul — it reads/classifies/stamps tasks natively by design; seam candidate: TaskClient (would need list/classify/update surface — deferred, see D3 log)
import { TaskDB, getTaskDB, type TaskStatus } from "../../../Productivity/LucidTasks/Tools/TaskDB.ts";
import {
  classifyTasksForKaya,
  decideBackfillAction,
  partitionGrilledItems,
  advanceClearItem,
  buildGrillBrief,
  computeTriageHash,
  hasValidTriageStamp,
  type ChunkClassifierFn,
  type ClarityVerdict,
  type LucidTaskInput,
  type TriageStamp,
} from "../../../Productivity/LucidTasks/Tools/KayaTaskClassifier.ts"; // cross-skill-allowed: IntakeRunner IS the LucidTasks→queue intake bridge from the 07-02 pipeline overhaul — it reads/classifies/stamps tasks natively by design; seam candidate: TaskClient (would need list/classify/update surface — deferred, see D3 log)

// ============================================================================
// Types
// ============================================================================

export interface IntakeAccounting {
  classified: number;
  advanced: number;
  parked: number;
  enqueued: number;
  skippedStamped: number;
}

export interface BackfillPhaseResult {
  /** Items actually sent to the LLM this run (post grill-stamp filter, pre-limit-applied count reflects what was attempted). */
  toJudgeCount: number;
  classified: number;
  advanced: number;
  parked: number;
}

export interface EnqueuePhaseResult {
  toJudgeCount: number;
  classified: number;
  enqueued: number;
  parked: number;
  skippedStamped: number;
}

export interface RunOptions {
  backfill?: boolean;
  enqueue?: boolean;
  /** Caps the number of candidates classified THIS RUN, per phase. Bounds LLM cost for verification runs. */
  limit?: number;
  qm?: QueueManager;
  taskDB?: TaskDB;
  /** Injectable classifier for tests — defaults to the real LLM-backed classifier. */
  classifyFn?: ChunkClassifierFn;
  /** Injectable AlertGate for tests — defaults to the shared singleton (lib/core/AlertGate.ts). */
  alertGate?: AlertGate;
  /** Injectable path to the intake-runner health-state file — defaults to kayaHomePath(HEALTH_STATE_RELPATH). */
  healthStatePath?: string;
}

/**
 * Persisted across runs at MEMORY/State/intake-runner-health.json — tracks
 * consecutive zero-classified failures so a single bad run (LLM blip) stays
 * a quiet digest entry, but REPEATED zero-classified days (intake dead
 * again, per the 2026-06-18 incident) escalate to an AlertGate page.
 */
export interface IntakeHealthState {
  consecutiveZeroClassified: number;
  lastFailureTs?: string;
  lastSuccessTs?: string;
}

export interface RunResult {
  accounting: IntakeAccounting;
  /** Total items attempted (post-filter, post-limit) across active phases — used for the zero-classified failure gate. */
  candidatesForClassification: number;
  /** true when candidatesForClassification > 0 but accounting.classified === 0 (total LLM outage). */
  failed: boolean;
}

// Active LucidTasks statuses eligible for autonomous-intake candidacy —
// excludes terminal (done/cancelled) and low-priority (someday) tasks.
const ACTIVE_STATUSES: TaskStatus[] = ["inbox", "next", "in_progress", "waiting"];

// ============================================================================
// Zero-classified health state — consecutive-occurrence tracking + escalation
// ============================================================================

const HEALTH_STATE_RELPATH = "MEMORY/State/intake-runner-health.json";
const ZERO_CLASSIFIED_ALERT_KEY = "intake-zero-classified";
const ZERO_CLASSIFIED_PAGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function loadHealthState(path: string): IntakeHealthState {
  try {
    if (!existsSync(path)) return { consecutiveZeroClassified: 0 };
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && typeof parsed.consecutiveZeroClassified === "number") {
      return parsed as IntakeHealthState;
    }
  } catch {
    // Corrupt state file — reset rather than wedge every future run.
  }
  return { consecutiveZeroClassified: 0 };
}

function saveHealthState(path: string, state: IntakeHealthState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2));
  } catch {
    // Best-effort — a health-state write failure must not crash the run.
  }
}

// ============================================================================
// Candidate selection (LucidTasks side)
// ============================================================================

/**
 * All LucidTasks with disposition='autonomous' in an active status.
 * Pure read — no filtering by triage stamp or queue_item_id (callers apply
 * those filters so tests can inspect the raw candidate pool separately).
 */
export function selectAutonomousCandidates(taskDB: TaskDB): LucidTaskInput[] {
  const projects = new Map(taskDB.listProjects().map((p) => [p.id, p.name]));
  const tasks = taskDB.listTasks({ status: ACTIVE_STATUSES });
  return tasks
    .filter((t) => t.disposition === "autonomous")
    .map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      queue_item_id: t.queue_item_id,
      project_id: t.project_id,
      project_name: t.project_id ? projects.get(t.project_id) : undefined,
      created_at: t.created_at,
      kaya_triage: t.kaya_triage,
    }));
}

/** Write (or refresh) a triage-skip stamp on a LucidTask so it isn't re-judged until content changes. */
function stampTriage(taskDB: TaskDB, task: LucidTaskInput, verdict: ClarityVerdict): void {
  const stamp: TriageStamp = {
    verdict: verdict.verdict,
    confidence: verdict.confidence,
    reasoning: verdict.reasoning,
    hash: computeTriageHash(task.project_name, task.title, task.description ?? ""),
    at: new Date().toISOString(),
    ...(verdict.scope ? { scope: verdict.scope } : {}),
  };
  taskDB.updateTask(task.id, { kaya_triage: JSON.stringify(stamp) }, "cron");
}

/** Sort by created_at ascending (FIFO) then cap to `limit` if provided. */
function capByCreatedAt<T extends { created_at?: string }>(items: T[], limit?: number): T[] {
  const sorted = [...items].sort(
    (a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime()
  );
  return typeof limit === "number" ? sorted.slice(0, Math.max(0, limit)) : sorted;
}

function capByCreated<T extends { created: string }>(items: T[], limit?: number): T[] {
  const sorted = [...items].sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime());
  return typeof limit === "number" ? sorted.slice(0, Math.max(0, limit)) : sorted;
}

// ============================================================================
// --backfill phase
// ============================================================================

export async function runBackfillPhase(
  qm: QueueManager,
  classifyFn?: ChunkClassifierFn,
  limit?: number
): Promise<BackfillPhaseResult> {
  const allAwaiting = await qm.listSpecPipeline("awaiting-context");
  const { toJudge, grillSkipped } = partitionGrilledItems(allAwaiting);

  if (grillSkipped.length > 0) {
    console.log(`[IntakeRunner:backfill] Skipping ${grillSkipped.length} grilled item(s) (valid grillStamp).`);
  }

  const capped = capByCreated(toJudge, limit);
  if (capped.length < toJudge.length) {
    console.log(`[IntakeRunner:backfill] --limit ${limit}: processing ${capped.length}/${toJudge.length} item(s).`);
  }

  if (capped.length === 0) {
    console.log("[IntakeRunner:backfill] No awaiting-context items to backfill.");
    return { toJudgeCount: 0, classified: 0, advanced: 0, parked: 0 };
  }

  const tasksForClassifier: LucidTaskInput[] = capped.map((item) => ({
    id: item.id,
    title: item.payload.title,
    description: item.payload.description ?? "",
    status: item.status,
  }));

  let verdicts: ClarityVerdict[] = [];
  try {
    verdicts = await classifyTasksForKaya(tasksForClassifier, classifyFn);
  } catch (err) {
    console.warn(`[IntakeRunner:backfill] classification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const byId = new Map(verdicts.map((v) => [v.id, v]));

  let advanced = 0;
  let parked = 0;
  for (const item of capped) {
    const v = byId.get(item.id);
    if (!v) {
      console.log(`[IntakeRunner:backfill] ${item.id} — not classified this run, leaving.`);
      continue;
    }

    const action = decideBackfillAction(v.verdict);
    if (action === "advance") {
      try {
        await advanceClearItem(
          qm,
          item.id,
          item.payload.description || item.payload.title,
          `Re-judged clear by IntakeRunner backfill. ${v.reasoning}`,
          v.confidence
        );
        advanced++;
      } catch (err) {
        console.warn(`[IntakeRunner:backfill] advanceClearItem failed for ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      try {
        await qm.parkForGrill(item.id, buildGrillBrief(v));
        parked++;
      } catch (err) {
        console.warn(`[IntakeRunner:backfill] parkForGrill failed for ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { toJudgeCount: capped.length, classified: verdicts.length, advanced, parked };
}

// ============================================================================
// --enqueue phase
// ============================================================================

export async function runEnqueuePhase(
  taskDB: TaskDB,
  qm: QueueManager,
  classifyFn?: ChunkClassifierFn,
  limit?: number
): Promise<EnqueuePhaseResult> {
  const candidates = selectAutonomousCandidates(taskDB);

  // Already-linked tasks (queue_item_id set) have already graduated out of
  // intake — not part of this run's candidate pool at all.
  const unlinked = candidates.filter((t) => !t.queue_item_id);

  const alreadyStamped = unlinked.filter((t) => hasValidTriageStamp(t));
  const toJudgeAll = unlinked.filter((t) => !hasValidTriageStamp(t));

  let skippedStamped = alreadyStamped.length;
  if (alreadyStamped.length > 0) {
    console.log(`[IntakeRunner:enqueue] Skipping ${alreadyStamped.length} task(s) with valid triage stamps.`);
  }

  const capped = capByCreatedAt(toJudgeAll, limit);
  if (capped.length < toJudgeAll.length) {
    console.log(`[IntakeRunner:enqueue] --limit ${limit}: processing ${capped.length}/${toJudgeAll.length} candidate(s).`);
  }

  if (capped.length === 0) {
    console.log("[IntakeRunner:enqueue] No autonomous candidates to classify.");
    return { toJudgeCount: 0, classified: 0, enqueued: 0, parked: 0, skippedStamped };
  }

  let verdicts: ClarityVerdict[] = [];
  try {
    verdicts = await classifyTasksForKaya(capped, classifyFn);
  } catch (err) {
    console.warn(`[IntakeRunner:enqueue] classification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const byId = new Map(verdicts.map((v) => [v.id, v]));

  const repo = getRepoForQueuesDir();
  let enqueued = 0;
  let parked = 0;

  for (const task of capped) {
    const v = byId.get(task.id);
    if (!v) {
      console.log(`[IntakeRunner:enqueue] ${task.id} — not classified this run, leaving.`);
      continue;
    }

    // Dedup guard: a lucid_task_id already present on a non-archived pipeline
    // item means this task was already routed (e.g. a prior partial run that
    // enqueued but never backlinked queue_item_id). Never create a duplicate.
    const existing = repo.list({ lucid_task_id: task.id });
    if (existing.length > 0) {
      console.log(`[IntakeRunner:enqueue] ${task.id} already linked to pipeline item ${existing[0].id} — stamping defensively, not re-enqueuing.`);
      stampTriage(taskDB, task, v);
      skippedStamped++;
      continue;
    }

    const description = `${task.description || task.title}\n\n[Kaya-intake] ${v.reasoning}`;

    if (v.verdict === "clear") {
      const scope = v.scope ?? "lightweight";
      if (scope === "project") {
        const itemId = await qm.addSpecPipelineItem(
          { title: task.title, description, context: { lucidTaskId: task.id } },
          { source: "lucidtasks-autonomous-intake", verdict: "clear" }
        );
        taskDB.updateTask(task.id, { queue_item_id: itemId }, "cron");
        enqueued++;
      } else {
        stampTriage(taskDB, task, v);
        skippedStamped++;
      }
      continue;
    }

    // needs-grill | not-executable → enqueue at awaiting-context then park —
    // needs-grilling stays the single visible holding pen (zero invisible items).
    const itemId = await qm.addSpecPipelineItem(
      { title: task.title, description, context: { lucidTaskId: task.id } },
      { source: "lucidtasks-autonomous-intake" }
    );
    taskDB.updateTask(task.id, { queue_item_id: itemId }, "cron");
    try {
      await qm.parkForGrill(itemId, buildGrillBrief(v));
      parked++;
    } catch (err) {
      console.warn(`[IntakeRunner:enqueue] parkForGrill failed for ${itemId} (task ${task.id}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { toJudgeCount: capped.length, classified: verdicts.length, enqueued, parked, skippedStamped };
}

// ============================================================================
// Combined runner
// ============================================================================

export async function runIntake(opts: RunOptions): Promise<RunResult> {
  const qm = opts.qm ?? new QueueManager();
  const taskDB = opts.taskDB ?? getTaskDB();

  const accounting: IntakeAccounting = { classified: 0, advanced: 0, parked: 0, enqueued: 0, skippedStamped: 0 };
  let candidatesForClassification = 0;

  if (opts.backfill) {
    const r = await runBackfillPhase(qm, opts.classifyFn, opts.limit);
    candidatesForClassification += r.toJudgeCount;
    accounting.classified += r.classified;
    accounting.advanced += r.advanced;
    accounting.parked += r.parked;
  }

  if (opts.enqueue) {
    const r = await runEnqueuePhase(taskDB, qm, opts.classifyFn, opts.limit);
    candidatesForClassification += r.toJudgeCount;
    accounting.classified += r.classified;
    accounting.enqueued += r.enqueued;
    accounting.parked += r.parked;
    accounting.skippedStamped += r.skippedStamped;
  }

  const failed = candidatesForClassification > 0 && accounting.classified === 0;

  const healthStatePath = opts.healthStatePath ?? kayaHomePath(HEALTH_STATE_RELPATH);
  const health = loadHealthState(healthStatePath);
  const nowIso = new Date().toISOString();

  if (failed) {
    health.consecutiveZeroClassified += 1;
    health.lastFailureTs = nowIso;
    saveHealthState(healthStatePath, health);

    // First occurrence: forensic log + quiet digest entry (reaches
    // SystemHealthDigest, no page). One bad run can be an LLM blip.
    recordFailure({
      source: "IntakeRunner",
      error: new Error("Zero verdicts produced despite non-zero candidates — total LLM outage?"),
      context: { candidatesForClassification, accounting, consecutiveZeroClassified: health.consecutiveZeroClassified },
      tier: "digest",
    });

    // Second-plus consecutive occurrence: intake is dead again (per the
    // 2026-06-18 incident) — page. AlertGate demotes to digest when
    // cooldown-gated; it never silently drops.
    if (health.consecutiveZeroClassified >= 2) {
      const gate = opts.alertGate ?? getAlertGate();
      const n = health.consecutiveZeroClassified;
      await gate.send(
        `Intake has produced zero classifications ${n} days running. Investigate: bun skills/Automation/QueueRouter/Tools/IntakeRunner.ts --backfill --enqueue`,
        {
          key: ZERO_CLASSIFIED_ALERT_KEY,
          tier: "page",
          fingerprint: `zero-classified:${n}`,
          cooldownMs: ZERO_CLASSIFIED_PAGE_COOLDOWN_MS,
        }
      );
    }
  } else {
    // Any successful run — classified something, or legitimately had zero
    // candidates this run — resets the consecutive-failure streak.
    health.consecutiveZeroClassified = 0;
    health.lastSuccessTs = nowIso;
    saveHealthState(healthStatePath, health);
  }

  return { accounting, candidatesForClassification, failed };
}

// ============================================================================
// CLI entry point
// ============================================================================

const USAGE = "Usage: bun IntakeRunner.ts --backfill --enqueue [--limit N]";

if (import.meta.main) {
  const args = process.argv.slice(2);
  const backfill = args.includes("--backfill");
  const enqueue = args.includes("--enqueue");
  const help = args.includes("--help");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : undefined;

  if (help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (!backfill && !enqueue) {
    // No recognized phase flag — this is the exact shape of the 2026-06-18
    // intake death (cron step running a no-op with exit 0). Refuse to
    // silently succeed: log to stderr, record a failure, and exit non-zero
    // so a future flag-string regression in the cron wrapper is caught
    // instead of quietly killing intake again.
    console.error(USAGE);
    recordFailure({
      source: "IntakeRunner",
      error: new Error("invoked without a phase flag (--backfill/--enqueue) — refusing to no-op silently"),
      context: { args },
      tier: "log",
    });
    process.exit(1);
  }

  runIntake({ backfill, enqueue, limit })
    .then(({ accounting, failed }) => {
      console.log(JSON.stringify(accounting));
      process.exit(failed ? 1 : 0);
    })
    .catch((err) => {
      console.error("FATAL:", err instanceof Error ? err.message : String(err));
      recordFailure({ source: "IntakeRunner:main", error: err, tier: "digest" });
      process.exit(1);
    });
}
