/**
 * TransitionGuard.ts - Fail-closed verification gate
 *
 * Guard layer between WorkOrchestrator and WorkQueue that:
 * - Intercepts all state-changing operations
 * - Validates verification quality before recording results
 * - Enforces completion prerequisites
 * - Logs every transition to the audit trail
 * - Rejects or downgrades transitions that don't meet quality thresholds
 *
 * INVARIANTS ENFORCED (2-phase verification model):
 * 1. If Phase 2 judgment had infra failure → cap at NEEDS_REVIEW
 * 2. If any rows had self-reported PASS without command → cap at NEEDS_REVIEW
 */

import { type WorkQueue, type WorkItem, type WorkStatus, type WorkItemVerification } from "./WorkQueue.ts";
import { type SkepticalReviewResult } from "./SkepticalVerifier.ts";
import { appendFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";

interface TransitionLog {
  timestamp: string;
  itemId: string;
  action: "verification_set" | "status_change" | "guard_rejection" | "guard_downgrade" | "catch_logged";
  from?: string;
  to?: string;
  reason?: string;
  tierData?: Record<string, unknown>;
}

export class TransitionGuard {
  private queue: WorkQueue;
  private auditPath: string;

  constructor(queue: WorkQueue, auditPath?: string) {
    this.queue = queue;
    this.auditPath = auditPath ?? join(process.env.HOME ?? "", ".claude", "MEMORY", "WORK", "transition-audit.jsonl");
  }

  /**
   * Validate and record verification result. Receives the FULL review result
   * so it can inspect tier-level data independently of the orchestrator's interpretation.
   *
   * INVARIANTS ENFORCED:
   * 1. If Phase 2 judgment had infra failure → cap at NEEDS_REVIEW
   * 2. If any rows had self-reported PASS without command → cap at NEEDS_REVIEW
   */
  setVerification(
    itemId: string,
    verification: WorkItemVerification,
    reviewResult: SkepticalReviewResult,
    selfReportedPassCount: number = 0
  ): { accepted: boolean; downgraded: boolean; originalVerdict?: string; reason?: string } {
    const item = this.queue.getItem(itemId);
    if (!item) {
      this.log({ timestamp: now(), itemId, action: "guard_rejection", reason: "item not found" });
      return { accepted: false, downgraded: false, reason: "item not found" };
    }

    let finalVerification = { ...verification };
    let downgraded = false;
    let reason: string | undefined;

    // INVARIANT 1: Phase 2 infra failure → cap at NEEDS_REVIEW
    if (verification.status === "verified" && verification.verdict === "PASS") {
      const tiers = reviewResult.tiers ?? [];
      const phase2 = tiers.find(t => t.tier === 2);
      const phase2InfraFailure = phase2 && phase2.confidence <= 0.3;
      if (phase2InfraFailure) {
        finalVerification = { ...finalVerification, status: "needs_review", verdict: "NEEDS_REVIEW" };
        downgraded = true;
        reason = "Phase 2 judgment had infra failure — capped at NEEDS_REVIEW";
      }
    }

    // INVARIANT 2: Self-reported PASS without command execution
    if (!downgraded && verification.verdict === "PASS" && selfReportedPassCount > 0) {
      finalVerification = { ...finalVerification, status: "needs_review", verdict: "NEEDS_REVIEW" };
      downgraded = true;
      reason = `${selfReportedPassCount} rows self-reported PASS without command execution`;
    }

    this.log({
      timestamp: now(),
      itemId,
      action: downgraded ? "guard_downgrade" : "verification_set",
      from: verification.verdict,
      to: finalVerification.verdict,
      reason,
      tierData: {
        tiers: (reviewResult.tiers ?? []).map(t => ({ tier: t.tier, verdict: t.verdict, confidence: t.confidence })),
        selfReportedPassCount,
      },
    });

    this.queue.setVerification(itemId, finalVerification);
    return { accepted: true, downgraded, originalVerdict: downgraded ? verification.verdict : undefined, reason };
  }

  /**
   * Validate NEEDS_REVIEW → PASS promotion. Only allowed if Phase 1 was genuinely PASS.
   * Requires Phase 1 verdict === "PASS" AND confidence >= 0.8.
   */
  canPromote(reviewResult: SkepticalReviewResult): { allowed: boolean; reason?: string } {
    const tier1 = (reviewResult.tiers ?? []).find(t => t.tier === 1);
    if (!tier1) return { allowed: false, reason: "no Tier 1 result" };
    if (tier1.verdict !== "PASS") return { allowed: false, reason: `Tier 1 verdict is ${tier1.verdict}, not PASS` };
    if (tier1.confidence < 0.8) return { allowed: false, reason: `Tier 1 confidence ${tier1.confidence} < 0.8` };
    return { allowed: true };
  }

  /**
   * Guarded status transition. Logs every transition.
   */
  updateStatus(itemId: string, status: WorkStatus, detail?: string): WorkItem | null {
    const item = this.queue.getItem(itemId);
    const fromStatus = item?.status ?? "unknown";

    this.log({
      timestamp: now(),
      itemId,
      action: "status_change",
      from: fromStatus,
      to: status,
      reason: detail,
    });

    return this.queue.updateStatus(itemId, status, detail);
  }

  /**
   * Log a caught error that would otherwise be silent.
   */
  logCaughtError(itemId: string, location: string, error: unknown): void {
    this.log({
      timestamp: now(),
      itemId,
      action: "catch_logged",
      reason: `${location}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  /**
   * Log an informational state transition that goes through WorkQueue
   * rather than TransitionGuard.updateStatus() (e.g., recordAttempt).
   */
  logIndirectTransition(itemId: string, from: string, to: string, reason: string): void {
    this.log({
      timestamp: now(),
      itemId,
      action: "status_change",
      from,
      to,
      reason: `[indirect] ${reason}`,
    });
  }

  /**
   * Direct access to queue for read operations and methods
   * that don't need guarding (getItem, getReadyItems, etc.)
   */
  get raw(): WorkQueue {
    return this.queue;
  }

  /**
   * Validate audit integrity: scan terminal-state items (completed/failed) against
   * transition-audit.jsonl and report gaps. Non-fatal — returns gap report.
   */
  validateAuditIntegrity(): { valid: boolean; gaps: Array<{ itemId: string; title: string; status: string; issue: string }> } {
    const gaps: Array<{ itemId: string; title: string; status: string; issue: string }> = [];

    // Load all audit entries
    const auditEntries = new Set<string>();
    try {
      if (existsSync(this.auditPath)) {
        const lines = readFileSync(this.auditPath, "utf-8").split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as TransitionLog;
            if (entry.itemId) auditEntries.add(entry.itemId);
          } catch { /* skip malformed lines */ }
        }
      }
    } catch {
      // If audit file is unreadable, report all terminal items as gaps
    }

    // Check terminal-state items
    for (const item of this.queue.getAllItems()) {
      if (item.status !== "completed" && item.status !== "failed") continue;
      if (!auditEntries.has(item.id)) {
        gaps.push({
          itemId: item.id,
          title: item.title,
          status: item.status,
          issue: `Terminal item has no audit trail entry`,
        });
      }
    }

    if (gaps.length > 0) {
      console.warn(`[TransitionGuard] Audit integrity: ${gaps.length} terminal item(s) missing audit trail`);
    }

    return { valid: gaps.length === 0, gaps };
  }

  private log(entry: TransitionLog): void {
    try {
      const dir = dirname(this.auditPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(this.auditPath, JSON.stringify(entry) + "\n");
    } catch {
      // Audit logging itself must never crash the system — last resort console
      console.error(`[TransitionGuard] Failed to write audit: ${JSON.stringify(entry)}`);
    }
  }
}

function now(): string {
  return new Date().toISOString();
}
