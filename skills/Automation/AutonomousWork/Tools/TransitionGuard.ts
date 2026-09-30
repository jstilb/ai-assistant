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
import { logFailure } from "../../../../lib/core/FailureLog.ts";
import { mkdirSync, existsSync, readFileSync, renameSync } from "fs";
import { join, dirname } from "path";
import { createAppendLog, type AppendLog } from "../../../../lib/core/AppendLog.ts";
import { getKayaHome, defaultKayaHome } from "../../../../lib/core/KayaHome.ts";

interface TransitionLog {
  timestamp: string;
  itemId: string;
  action: "verification_set" | "status_change" | "guard_rejection" | "guard_downgrade" | "catch_logged";
  from?: string;
  to?: string;
  reason?: string;
  tierData?: Record<string, unknown>;
}

/**
 * ISC 10: Work audit log entry — AppendAuditLog now lives in TransitionGuard.
 */
export interface WorkAuditEntry {
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

export class TransitionGuard {
  private queue: WorkQueue;
  private auditPath: string;
  /** ISC 10: Work audit path (separate from transition audit) */
  private workAuditPath: string;
  private auditLog: AppendLog;
  private workAuditLog: AppendLog;

  /** ISC 13: Max lines before audit rotation */
  static readonly MAX_AUDIT_LINES = 10000;

  constructor(queue: WorkQueue, auditPath?: string) {
    this.queue = queue;
    // Reads process.env.HOME only (ignores KAYA_HOME) → defaultKayaHome() preserves exact behavior.
    this.auditPath = auditPath ?? join(defaultKayaHome(), "MEMORY", "WORK", "transition-audit.jsonl");
    // Reads KAYA_HOME env override → getKayaHome() (memoized).
    this.workAuditPath = join(getKayaHome(), "MEMORY/WORK/audit.jsonl");
    this.auditLog = createAppendLog(this.auditPath);
    this.workAuditLog = createAppendLog(this.workAuditPath);
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

  /**
   * ISC 10: Append to work audit log (extracted from WorkOrchestrator.appendAuditLog).
   * ISC 13: Rotates audit file when it exceeds MAX_AUDIT_LINES.
   */
  appendAuditLog(entry: WorkAuditEntry): void {
    try {
      // ISC 13: Rotate before writing if file is over limit
      this.rotateIfNeeded(this.workAuditPath);

      const record = { timestamp: new Date().toISOString(), ...entry };
      this.workAuditLog.append(record);
    } catch (e) {
      // S6: route to the CENTRAL failure log — a DIFFERENT sink (failure-log.jsonl, not this audit
      // file) so there's no recursion. The audit-write failure is now observable, and audit failure
      // still never prevents completion.
      logFailure("TransitionGuard:appendAuditLog", e);
    }
  }

  /**
   * ISC 13: Audit file rotation — max MAX_AUDIT_LINES per file.
   * When the file exceeds the limit, renames it to a timestamped archive.
   * NEVER deletes old audit entries — always archives.
   */
  rotateIfNeeded(filePath: string): void {
    if (!existsSync(filePath)) return;
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter(l => l.trim());
      if (lines.length < TransitionGuard.MAX_AUDIT_LINES) return;

      // Archive: rename to timestamped file, never delete
      const archivePath = filePath.replace(/\.jsonl$/, `-archived-${Date.now()}.jsonl`);
      renameSync(filePath, archivePath);
    } catch {
      // Rotation failure is non-fatal — file continues to grow; alert is acceptable
    }
  }

  private log(entry: TransitionLog): void {
    try {
      // ISC 13: Also rotate the transition audit log if needed
      this.rotateIfNeeded(this.auditPath);

      this.auditLog.append(entry);
    } catch {
      // Audit logging itself must never crash the system — last resort console
      console.error(`[TransitionGuard] Failed to write audit: ${JSON.stringify(entry)}`);
    }
  }
}

function now(): string {
  return new Date().toISOString();
}
