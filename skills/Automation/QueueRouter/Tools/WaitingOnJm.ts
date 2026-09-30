#!/usr/bin/env bun
/**
 * WaitingOnJm.ts — D1: unified "Waiting on Jm" aggregation surface
 *
 * Today, 74 needs-grilling items and 17 stuck Lane-A deliverables are
 * invisible to ALL alerting — each queue/lane has its own silo, no single
 * place shows everything currently blocked on Jm's attention. This module
 * is that single place: one read-only aggregation across five surfaces.
 *
 * Every surface REUSES an existing query/aggregation rather than
 * re-implementing the math:
 *   - needsGrilling            → GrillRunner.getGrillBacklogSummary()
 *   - approvalsPending         → QueueManager approvals queue (status awaiting_approval)
 *   - pendingApprovalMerges    → Integrator.listPendingApproval()
 *   - needsJmEscalations       → "Kaya — Needs Jm" LucidTasks project (open tasks)
 *   - laneAWaitingDeliverables → LucidTasks: disposition='autonomous' AND status='waiting'
 *
 * All operations are READ-ONLY. needsJmEscalations in particular MUST NOT
 * create the "Kaya — Needs Jm" project as a side effect — the TaskClient's
 * listOpenTasksInProject contract (not EscalationHelper.ensureNeedsJmProject(),
 * which creates on first use) returns zero when the project doesn't exist yet.
 *
 * F3: the LucidTasks surfaces read through the TaskClient seam
 * (lib/interfaces/QueueTaskIntegration.ts) — this module no longer imports
 * TaskDB. getWaitingOnJm() is async and THROWS if no TaskClient is registered;
 * every process entry point wires bin/wire-queue-task-integration.ts in its
 * main branch (see the CLI entry below for the pattern).
 *
 * @module WaitingOnJm
 */

import { loadQueueItems, type QueueItem } from "./QueueManager.ts";
import { getGrillBacklogSummary, type GrillBacklogSummary } from "./GrillRunner.ts";
// cross-skill-allowed: reads Lane-A pipeline surfaces by design (5-surface waiting-on-Jm summary)
import { Integrator } from "../../AutonomousWork/Tools/Integrator.ts";
import { NEEDS_JM_PROJECT_NAME } from "../../../../lib/core/EscalationHelper.ts";
import { getTaskClient, type TaskClient } from "../../../../lib/interfaces/QueueTaskIntegration.ts";

// ============================================================================
// Types
// ============================================================================

/** A waiting item with an age, for surfaces sourced from created_at timestamps. */
export interface AgedItem {
  id: string;
  title: string;
  ageDays: number;
}

/** A pending-merge-approval item — mirrors Integrator.listPendingApproval()'s shape. */
export interface PendingMergeItem {
  id: string;
  title: string;
  branch?: string;
  reason: string;
}

export interface WaitingOnJmSummary {
  needsGrilling: { count: number; oldestAgeDays: number; medianAgeDays: number };
  approvalsPending: { count: number; items: AgedItem[] };
  pendingApprovalMerges: { count: number; items: PendingMergeItem[] };
  needsJmEscalations: { count: number; items: AgedItem[] };
  laneAWaitingDeliverables: { count: number; items: AgedItem[] };
}

/** Injectable dependencies — default to the real stores; tests override for isolation. */
export interface WaitingOnJmDeps {
  getGrillBacklogSummary?: (now?: Date) => GrillBacklogSummary;
  loadApprovalItems?: () => QueueItem[];
  listPendingApprovalMerges?: () => PendingMergeItem[];
  /** Resolve the TaskClient (LucidTasks reads). Defaults to the registry. */
  getTaskClient?: () => TaskClient | null;
}

// ============================================================================
// Helpers
// ============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function ageDaysOf(now: Date, isoTimestamp: string): number {
  return round1((now.getTime() - new Date(isoTimestamp).getTime()) / DAY_MS);
}

// ============================================================================
// getWaitingOnJm
// ============================================================================

/**
 * Aggregate all five "waiting on Jm" surfaces into one read-only summary.
 *
 * Async since F3: the LucidTasks surfaces go through the TaskClient seam
 * (lib/interfaces/QueueTaskIntegration.ts) instead of a direct TaskDB import.
 * Entry points MUST side-effect-import bin/wire-queue-task-integration.ts in
 * their main branch first — an unregistered client THROWS (fail-loud by
 * design: a missed entry point must surface, not quietly blank the
 * escalation surfaces out of the briefing/digest/notifier).
 *
 * @param now  - Clock to measure ages against (injectable for tests; defaults to real now)
 * @param deps - Injectable dependencies (default: real stores)
 */
export async function getWaitingOnJm(
  now: Date = new Date(),
  deps: WaitingOnJmDeps = {}
): Promise<WaitingOnJmSummary> {
  const grillSummaryFn = deps.getGrillBacklogSummary ?? getGrillBacklogSummary;
  const loadApprovalItems = deps.loadApprovalItems ?? (() => loadQueueItems("approvals"));
  const listPendingApprovalMerges =
    deps.listPendingApprovalMerges ?? (() => new Integrator().listPendingApproval());
  const taskClient = (deps.getTaskClient ?? getTaskClient)();
  if (!taskClient) {
    throw new Error(
      "WaitingOnJm: no TaskClient registered — the entry point must " +
        "`await import(\"bin/wire-queue-task-integration.ts\")` in its main branch " +
        "before calling getWaitingOnJm()"
    );
  }

  // --- needsGrilling ---
  const grill = grillSummaryFn(now);
  const needsGrilling = {
    count: grill.total,
    oldestAgeDays: grill.oldestAgeDays,
    medianAgeDays: grill.medianAgeDays,
  };

  // --- approvalsPending ---
  const approvalItems = loadApprovalItems().filter((i) => i.status === "awaiting_approval");
  const approvalsPending = {
    count: approvalItems.length,
    items: approvalItems.map((i) => ({
      id: i.id,
      title: i.payload.title,
      ageDays: ageDaysOf(now, i.created),
    })),
  };

  // --- pendingApprovalMerges ---
  const mergeItems = listPendingApprovalMerges();
  const pendingApprovalMerges = { count: mergeItems.length, items: mergeItems };

  // --- needsJmEscalations (READ-ONLY: the client contract guarantees a
  // missing project returns [] and is never created as a side effect) ---
  const escalationTasks = await taskClient.listOpenTasksInProject(NEEDS_JM_PROJECT_NAME);
  const needsJmEscalations = {
    count: escalationTasks.length,
    items: escalationTasks.map((t) => ({
      id: t.id,
      title: t.title,
      ageDays: ageDaysOf(now, t.createdAt),
    })),
  };

  // --- laneAWaitingDeliverables: disposition='autonomous' AND status='waiting' ---
  const waitingTasks = await taskClient.listWaitingAutonomousTasks();
  const laneAWaitingDeliverables = {
    count: waitingTasks.length,
    items: waitingTasks.map((t) => ({
      id: t.id,
      title: t.title,
      ageDays: ageDaysOf(now, t.createdAt),
    })),
  };

  return {
    needsGrilling,
    approvalsPending,
    pendingApprovalMerges,
    needsJmEscalations,
    laneAWaitingDeliverables,
  };
}

// ============================================================================
// CLI Entry
// ============================================================================

if (import.meta.main) {
  // Composition root: register both adapters before touching the seam.
  await import("../../../../bin/wire-queue-task-integration.ts");
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const summary = await getWaitingOnJm();

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("Waiting on Jm");
    console.log("=============");
    console.log(
      `Needs grilling:          ${summary.needsGrilling.count} ` +
      `(oldest ${summary.needsGrilling.oldestAgeDays}d, median ${summary.needsGrilling.medianAgeDays}d)`
    );
    console.log(`Approvals pending:       ${summary.approvalsPending.count}`);
    console.log(`Pending approval merges: ${summary.pendingApprovalMerges.count}`);
    console.log(`Needs-Jm escalations:    ${summary.needsJmEscalations.count}`);
    console.log(`Lane-A waiting:          ${summary.laneAWaitingDeliverables.count}`);

    const total =
      summary.needsGrilling.count +
      summary.approvalsPending.count +
      summary.pendingApprovalMerges.count +
      summary.needsJmEscalations.count +
      summary.laneAWaitingDeliverables.count;
    console.log(`\nTotal waiting on Jm: ${total}`);
  }
}
