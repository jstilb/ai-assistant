/**
 * NotificationDispatcher.ts — Extracted from WorkOrchestrator.ts
 *
 * ISC 6: createJmTask, createHumanProxies, emitNeedsReviewNotification
 * extracted from WorkOrchestrator god object.
 *
 * Handles all notification emission and human task creation for the
 * autonomous work pipeline.
 */

import { memPathUnder } from "../../../../lib/core/MemoryPaths.ts";
import { AlertGate } from "../../../../lib/core/AlertGate.ts";
import { createAppendLog, type AppendLog } from "../../../../lib/core/AppendLog.ts";
import { getKayaHome, assertNotLiveHomeUnderTest } from "../../../../lib/core/KayaHome.ts";
import type { WorkQueue, WorkItem } from "./WorkQueue.ts";
import type { ISCRow } from "./WorkOrchestrator.ts";

// ============================================================================
// Types
// ============================================================================

export interface AuditLogEntry {
  itemId: string;
  itemTitle: string;
  verdict: string;
  concerns: string[];
  tiersExecuted: number[];
  verificationCost: number;
  iscRowSummary: string[];
  failureReason?: string;
  adversarialConcerns?: string[];
}

// ============================================================================
// NotificationDispatcher Class
// ============================================================================

export class NotificationDispatcher {
  /**
   * Test-injected home override ONLY. When set, every path roots at it
   * (hermetic). When absent, `this.kayaHome` resolves getKayaHome() LAZILY at
   * each write — NOT frozen in the constructor — so a KAYA_HOME pinned after
   * this module is imported is honored (fixes the live-tree writes this
   * dispatcher produced under test; mirrors AlertGate's statePathOverride
   * pattern and the A2/Z1 de-freeze).
   */
  private readonly kayaHomeOverride?: string;
  private queue?: WorkQueue;
  private onAuditLog?: (entry: AuditLogEntry) => void;
  private _gate?: AlertGate;
  private _notifLog?: AppendLog;

  constructor(options?: {
    kayaHome?: string;
    queue?: WorkQueue;
    onAuditLog?: (entry: AuditLogEntry) => void;
  }) {
    this.kayaHomeOverride = options?.kayaHome;
    this.queue = options?.queue;
    this.onAuditLog = options?.onAuditLog;
  }

  /** Lazily-resolved home: injected override, else current getKayaHome(). */
  private get kayaHome(): string {
    return this.kayaHomeOverride ?? getKayaHome();
  }

  /**
   * AlertGate. With an injected home, root it explicitly at that tmpdir
   * (hermetic). WITHOUT one, build a plain AlertGate so it resolves
   * getKayaHome() lazily per-write AND fires its OWN
   * assertNotLiveHomeUnderTest() tripwire on spool/saveState — no bypass.
   */
  private get gate(): AlertGate {
    if (!this._gate) {
      this._gate = this.kayaHomeOverride
        ? new AlertGate({
            statePath: memPathUnder(this.kayaHomeOverride, "State", "alert-gate.json"),
            spoolPath: memPathUnder(this.kayaHomeOverride, "NOTIFICATIONS", "digest-spool.jsonl"),
          })
        : new AlertGate();
    }
    return this._gate;
  }

  /** Notifications JSONL append log rooted at this.kayaHome — keeps
   *  injected-home tests hermetic and reuses one instance per dispatcher. */
  private get notifLog(): AppendLog {
    if (!this._notifLog) {
      this._notifLog = createAppendLog(
        memPathUnder(this.kayaHome, "NOTIFICATIONS", "notifications.jsonl"),
      );
    }
    return this._notifLog;
  }

  // --------------------------------------------------------------------------
  // NEEDS_REVIEW notification
  // --------------------------------------------------------------------------

  /**
   * Emit a NEEDS_REVIEW notification to the notifications JSONL file.
   * Non-fatal — failures are silently swallowed (notification is UX, not pipeline-critical).
   */
  emitNeedsReviewNotification(item: WorkItem, reason: string): void;
  emitNeedsReviewNotification(itemId: string, title: string, verdict: string, concerns: string[]): void;
  emitNeedsReviewNotification(
    itemOrId: WorkItem | string,
    titleOrReason: string,
    verdict?: string,
    concerns?: string[]
  ): void {
    // Hermetic tripwire — MUST be outside the try/catch below (which swallows
    // all errors as "non-critical UX"); inside it the guard would be silenced,
    // which is exactly how this path leaked to the LIVE tree under test.
    // Skipped when a home is injected (tests root the dispatcher at a tmpdir).
    if (!this.kayaHomeOverride) {
      assertNotLiveHomeUnderTest("NotificationDispatcher.emitNeedsReviewNotification");
    }
    try {
      let record: Record<string, unknown>;
      if (typeof itemOrId === "string") {
        // Old signature: (itemId, title, verdict, concerns)
        const itemId = itemOrId;
        const title = titleOrReason;
        record = {
          timestamp: new Date().toISOString(),
          event: "verification_failed",
          channel: "autonomous_work",
          severity: verdict === "FAIL" ? "critical" : "warning",
          message: `[${verdict}] "${title}" (${itemId.slice(0, 8)}) — ${(concerns ?? []).slice(0, 3).join("; ")}`,
          metadata: { itemId, verdict, concernCount: (concerns ?? []).length },
        };
      } else {
        // New signature: (item, reason)
        const item = itemOrId;
        record = {
          timestamp: new Date().toISOString(),
          event: "needs_review",
          channel: "autonomous_work",
          severity: "warning",
          message: `NEEDS_REVIEW: "${item.title}" (${item.id.slice(0, 8)}) — ${titleOrReason}`,
          metadata: { itemId: item.id, reason: titleOrReason },
        };
      }

      this.notifLog.append(record);
      // Also spool for the daily system-health digest — before 2026-06-12
      // these events lived only in a JSONL nothing read (32 verification
      // failures on 6/11 were invisible to Jm).
      this.gate.spool(
        String(record.message),
        `aw-${record.event}-${typeof itemOrId === "string" ? itemOrId : itemOrId.id}`,
        "digest"
      );
    } catch {
      // Acceptable silence: notification is a non-critical UX feature
    }
  }

  // --------------------------------------------------------------------------
  // Escalation LucidTask creation ("Kaya — Needs Jm" project)
  // --------------------------------------------------------------------------

  /**
   * Create a "Kaya — Needs Jm" LucidTask for manual steps that need human action.
   * Method name kept from the retired jm-tasks era — the task is still "for Jm".
   * Uses `manual-${itemId}` as the task ID for JmTaskBridge/QueueSyncBridge
   * lookup compatibility; pre-stamped so the hourly triage skips it.
   * Non-fatal — failures are logged but don't block pipeline.
   */
  async createJmTask(itemId: string, itemTitle: string, manualDescriptions: string): Promise<void> {
    try {
      // cross-skill-allowed: Lane-A escalation writes LucidTasks tasks by design (07-02 overhaul); seam candidate: TaskClient
      const { getTaskDB } = await import("../../../Productivity/LucidTasks/Tools/TaskDB.ts");
      const { ensureNeedsJmProject, createOrReopenEscalationTask } = await import("../../../../lib/core/EscalationHelper.ts");
      const db = getTaskDB();
      const projectId = ensureNeedsJmProject(db);
      const title = `Manual steps: ${itemTitle}`;
      const desc = `Work item ${itemId} has automated work verified but needs manual action:\n${manualDescriptions}`;
      createOrReopenEscalationTask(db, itemId, title, desc, projectId);
      db.close();
    } catch (e) {
      // Non-fatal — log but don't block the status transition
      this.onAuditLog?.({
        itemId,
        itemTitle,
        verdict: "PASS",
        concerns: [`Failed to create escalation LucidTask: ${e instanceof Error ? e.message : String(e)}`],
        tiersExecuted: [],
        verificationCost: 0,
        iscRowSummary: [],
      });
    }
  }

  // --------------------------------------------------------------------------
  // Human proxy WorkItem creation
  // --------------------------------------------------------------------------

  /**
   * Create LucidTasks and HUMAN proxy WorkItems for human-required ISC rows.
   * Called from reportDone step 3c when automated work is verified but manual rows remain.
   * Returns the created proxy IDs so the caller can wire them as dependencies.
   */
  async createHumanProxies(
    itemId: string,
    itemTitle: string,
    humanRows: ISCRow[]
  ): Promise<string[]> {
    if (!this.queue) {
      console.warn("[NotificationDispatcher.createHumanProxies] No queue provided — cannot create proxies");
      return [];
    }

    const proxyIds: string[] = [];
    const item = this.queue.getItem(itemId);

    for (const row of humanRows) {
      try {
        // Step 1: Create LucidTask via direct DB import (no subprocess overhead)
        let lucidTaskId: string | undefined;
        try {
          // cross-skill-allowed: Lane-A escalation writes LucidTasks tasks by design (07-02 overhaul); seam candidate: TaskClient
          const { getTaskDB } = await import("../../../Productivity/LucidTasks/Tools/TaskDB.ts");
          const { ensureNeedsJmProject, buildEscalationStamp, NEEDS_JM_PROJECT_NAME } =
            await import("../../../../lib/core/EscalationHelper.ts");
          const db = getTaskDB();
          const projectId = ensureNeedsJmProject(db);
          const specPath = item?.metadata?.specPath as string ?? "N/A";
          const worktreeBranch = item?.metadata?.worktreeBranch as string ?? "N/A";
          const prUrl = item?.metadata?.prUrl as string ?? "N/A";

          // Created first so the resolve command below can embed the real task
          // id; on repeat escalations the title+project dedup returns the
          // existing task and the update refreshes it.
          const lucidTask = db.createTask({
            title: `[Human Action] ${row.description}`,
            description: "",
            status: "next",
            priority: 2,
            project_id: projectId,
            labels: ["human-required", "autonomous-work"],
          });

          const resolveCmd = `bun run ~/.claude/skills/Automation/AutonomousWork/Tools/JmTaskBridge.ts resolve --lucid-task-id ${lucidTask.id}`;
          const richDescription = [
            `## Context`,
            `Work item: ${itemTitle}`,
            `ISC Row #${row.id}: ${row.description}`,
            `Spec: ${specPath}`,
            `Branch: ${worktreeBranch}`,
            prUrl !== "N/A" ? `PR: ${prUrl}` : null,
            ``,
            `## Steps`,
            `1. ${row.verifyMethod ?? row.description}`,
            `2. Verify the result matches the spec criteria`,
            `3. Mark complete by running:`,
            "```bash",
            resolveCmd,
            "```",
          ].filter(Boolean).join("\n");

          db.updateTask(
            lucidTask.id,
            {
              description: richDescription,
              kaya_triage: buildEscalationStamp(NEEDS_JM_PROJECT_NAME, lucidTask.title, richDescription),
            },
            "system"
          );
          lucidTaskId = lucidTask.id;
          db.close();
        } catch (e) {
          // Non-fatal — continue without LucidTask ID
          console.warn(`[createHumanProxies] LucidTask creation failed for row #${row.id}: ${e instanceof Error ? e.message : String(e)}`);
        }

        // Step 2: Create HUMAN proxy WorkItem
        const proxy = this.queue.addItem({
          title: `HUMAN: ${row.description}`,
          description: `Human action required for: ${itemTitle}`,
          status: "blocked",
          priority: item?.priority ?? "normal",
          dependencies: [],
          source: "manual" as const,
          humanTaskRef: {
            ...(lucidTaskId ? { lucidTaskId } : {}),
            queueItemId: itemId,
            createdAt: new Date().toISOString(),
            action: row.description,
            reason: `ISC row #${row.id} classified as human-required`,
          },
        });

        // Step 3: Wire as dependency
        this.queue.addDependency(itemId, proxy.id);
        proxyIds.push(proxy.id);
      } catch (e) {
        console.warn(`[createHumanProxies] Failed to create proxy for row #${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return proxyIds;
  }
}
