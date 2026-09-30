/**
 * TransitionGuard.test.ts
 *
 * Tests for the fail-closed verification gate that intercepts state changes,
 * enforces quality invariants, and produces an audit trail.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TransitionGuard } from "./TransitionGuard.ts";
import { WorkQueue, type WorkItem, type WorkItemVerification } from "./WorkQueue.ts";
import type { SkepticalReviewResult } from "./SkepticalVerifier.ts";

// ============================================================================
// Helpers
// ============================================================================

function makeVerification(overrides: Partial<WorkItemVerification> = {}): WorkItemVerification {
  return {
    status: "verified",
    verifiedAt: new Date().toISOString(),
    verdict: "PASS",
    concerns: [],
    iscRowsVerified: 1,
    iscRowsTotal: 1,
    verificationCost: 0.001,
    verifiedBy: "skeptical_verifier",
    tiersExecuted: [1, 2],
    ...overrides,
  };
}

function makeReviewResult(overrides: Partial<SkepticalReviewResult> = {}): SkepticalReviewResult {
  return {
    finalVerdict: "PASS",
    tiers: [
      { tier: 1, verdict: "PASS", confidence: 0.9, concerns: [], costEstimate: 0.001, latencyMs: 100 },
      { tier: 2, verdict: "PASS", confidence: 0.9, concerns: [], costEstimate: 0.002, latencyMs: 200 },
    ],
    tiersSkipped: [] as SkepticalReviewResult["tiersSkipped"],
    totalCost: 0.003,
    totalLatencyMs: 300,
    concerns: [],
    ...overrides,
  };
}

function readAuditEntries(auditPath: string): Array<Record<string, unknown>> {
  try {
    const raw = readFileSync(auditPath, "utf-8").trim();
    if (!raw) return [];
    return raw.split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// ============================================================================
// Test Setup
// ============================================================================

let tmpDir: string;
let auditPath: string;
let queue: WorkQueue;
let guard: TransitionGuard;
let testItem: WorkItem;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "transition-guard-test-"));
  auditPath = join(tmpDir, "audit.jsonl");

  // Use the testing DI constructor — no filesystem persistence for the queue
  queue = WorkQueue._createForTesting([]);
  testItem = queue.addItem({
    title: "Test",
    description: "",
    priority: "normal",
    dependencies: [],
    source: "manual",
    status: "pending",
  });

  guard = new TransitionGuard(queue, auditPath);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// INVARIANT 1: Infra failure cap
// ============================================================================

describe("TransitionGuard", () => {
  describe("INVARIANT 1: Infra failure cap", () => {
    test("PASS with Phase 2 infra-failed → downgrades to NEEDS_REVIEW", () => {
      const verification = makeVerification({ status: "verified", verdict: "PASS" });
      // Phase 2 (tier 2) has confidence <= 0.3 (infra failure proxy)
      const reviewResult = makeReviewResult({
        finalVerdict: "PASS",
        tiers: [
          { tier: 1, verdict: "PASS", confidence: 0.9, concerns: [], costEstimate: 0.001, latencyMs: 100 },
          { tier: 2, verdict: "PASS", confidence: 0.2, concerns: [], costEstimate: 0.001, latencyMs: 50 },
        ],
      });

      const result = guard.setVerification(testItem.id, verification, reviewResult, 0);

      expect(result.accepted).toBe(true);
      expect(result.downgraded).toBe(true);
      expect(result.originalVerdict).toBe("PASS");

      const stored = queue.getItem(testItem.id);
      expect(stored?.verification?.verdict).toBe("NEEDS_REVIEW");
      expect(stored?.verification?.status).toBe("needs_review");
    });

    test("PASS with healthy Tier 2 → no downgrade", () => {
      const verification = makeVerification({ status: "verified", verdict: "PASS" });
      const reviewResult = makeReviewResult({
        finalVerdict: "PASS",
        tiers: [
          { tier: 1, verdict: "PASS", confidence: 0.9, concerns: [], costEstimate: 0.001, latencyMs: 100 },
          { tier: 2, verdict: "PASS", confidence: 0.85, concerns: [], costEstimate: 0.002, latencyMs: 200 },
        ],
      });

      const result = guard.setVerification(testItem.id, verification, reviewResult, 0);

      expect(result.accepted).toBe(true);
      expect(result.downgraded).toBe(false);

      const stored = queue.getItem(testItem.id);
      expect(stored?.verification?.verdict).toBe("PASS");
    });

    test("TRIVIAL items (no higher tiers) → no downgrade", () => {
      const verification = makeVerification({ status: "verified", verdict: "PASS" });
      // Only tier 1 — no higher tiers exist, so the invariant cannot fire
      const reviewResult = makeReviewResult({
        finalVerdict: "PASS",
        tiers: [
          { tier: 1, verdict: "PASS", confidence: 0.9, concerns: [], costEstimate: 0.001, latencyMs: 100 },
        ],
      });

      const result = guard.setVerification(testItem.id, verification, reviewResult, 0);

      expect(result.accepted).toBe(true);
      expect(result.downgraded).toBe(false);

      const stored = queue.getItem(testItem.id);
      expect(stored?.verification?.verdict).toBe("PASS");
    });
  });

  // ============================================================================
  // INVARIANT 2: Self-reported PASS
  // ============================================================================

  describe("INVARIANT 2: Self-reported PASS", () => {
    test("PASS with selfReportedPassCount > 0 → downgrades to NEEDS_REVIEW", () => {
      const verification = makeVerification({ status: "verified", verdict: "PASS" });
      const reviewResult = makeReviewResult();

      const result = guard.setVerification(testItem.id, verification, reviewResult, 3);

      expect(result.accepted).toBe(true);
      expect(result.downgraded).toBe(true);
      expect(result.originalVerdict).toBe("PASS");

      const stored = queue.getItem(testItem.id);
      expect(stored?.verification?.verdict).toBe("NEEDS_REVIEW");
      expect(stored?.verification?.status).toBe("needs_review");
    });

    test("PASS with selfReportedPassCount === 0 → no downgrade", () => {
      const verification = makeVerification({ status: "verified", verdict: "PASS" });
      const reviewResult = makeReviewResult();

      const result = guard.setVerification(testItem.id, verification, reviewResult, 0);

      expect(result.accepted).toBe(true);
      expect(result.downgraded).toBe(false);

      const stored = queue.getItem(testItem.id);
      expect(stored?.verification?.verdict).toBe("PASS");
    });
  });

  // ============================================================================
  // Promotion gate
  // ============================================================================

  describe("Promotion gate", () => {
    test("canPromote with tier1 PASS confidence 0.9 → allowed", () => {
      const reviewResult = makeReviewResult({
        tiers: [
          { tier: 1, verdict: "PASS", confidence: 0.9, concerns: [], costEstimate: 0.001, latencyMs: 100 },
        ],
      });

      const result = guard.canPromote(reviewResult);

      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    test("canPromote with tier1 NEEDS_REVIEW → rejected", () => {
      const reviewResult = makeReviewResult({
        tiers: [
          { tier: 1, verdict: "NEEDS_REVIEW", confidence: 0.85, concerns: [], costEstimate: 0.001, latencyMs: 100 },
        ],
      });

      const result = guard.canPromote(reviewResult);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain("NEEDS_REVIEW");
    });

    test("canPromote with tier1 PASS confidence 0.6 → rejected (below 0.8)", () => {
      const reviewResult = makeReviewResult({
        tiers: [
          { tier: 1, verdict: "PASS", confidence: 0.6, concerns: [], costEstimate: 0.001, latencyMs: 100 },
        ],
      });

      const result = guard.canPromote(reviewResult);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain("0.6");
    });
  });

  // ============================================================================
  // Audit logging
  // ============================================================================

  describe("Audit logging", () => {
    test("every setVerification call produces audit entry", () => {
      const verification = makeVerification();
      const reviewResult = makeReviewResult();

      guard.setVerification(testItem.id, verification, reviewResult, 0);

      const entries = readAuditEntries(auditPath);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries.some(e => e.itemId === testItem.id)).toBe(true);
    });

    test("every updateStatus call produces audit entry", () => {
      guard.updateStatus(testItem.id, "in_progress", "starting work");

      const entries = readAuditEntries(auditPath);
      expect(entries.length).toBeGreaterThanOrEqual(1);

      const entry = entries.find(e => e.action === "status_change");
      expect(entry).toBeDefined();
      expect(entry?.itemId).toBe(testItem.id);
      expect(entry?.to).toBe("in_progress");
    });

    test("downgrade produces audit entry with original verdict", () => {
      const verification = makeVerification({ status: "verified", verdict: "PASS" });
      // Trigger invariant 2 downgrade with self-reported pass
      const reviewResult = makeReviewResult();

      guard.setVerification(testItem.id, verification, reviewResult, 2);

      const entries = readAuditEntries(auditPath);
      const downgradeEntry = entries.find(e => e.action === "guard_downgrade");
      expect(downgradeEntry).toBeDefined();
      expect(downgradeEntry?.from).toBe("PASS");
      expect(downgradeEntry?.to).toBe("NEEDS_REVIEW");
      expect(downgradeEntry?.itemId).toBe(testItem.id);
    });

    test("logCaughtError produces audit entry", () => {
      const error = new Error("something went wrong in tier 2");

      guard.logCaughtError(testItem.id, "SkepticalVerifier.judge", error);

      const entries = readAuditEntries(auditPath);
      const errorEntry = entries.find(e => e.action === "catch_logged");
      expect(errorEntry).toBeDefined();
      expect(errorEntry?.itemId).toBe(testItem.id);
      expect(typeof errorEntry?.reason).toBe("string");
      expect((errorEntry?.reason as string)).toContain("something went wrong in tier 2");
    });
  });

  // ============================================================================
  // Status transitions
  // ============================================================================

  describe("Status transitions", () => {
    test("updateStatus delegates to queue", () => {
      const returned = guard.updateStatus(testItem.id, "in_progress");

      expect(returned).not.toBeNull();
      expect(returned?.status).toBe("in_progress");

      // Verify queue state was actually mutated
      const fromQueue = queue.getItem(testItem.id);
      expect(fromQueue?.status).toBe("in_progress");
    });

    test("completed without verified verification throws", () => {
      // testItem starts as "pending" with no verification
      expect(() => guard.updateStatus(testItem.id, "completed")).toThrow();
    });

    test("completed with downgraded (NEEDS_REVIEW) verification throws", () => {
      // Set verification to needs_review (not verified)
      queue.setVerification(testItem.id, {
        ...makeVerification(),
        status: "needs_review",
        verdict: "NEEDS_REVIEW",
      });
      expect(() => guard.updateStatus(testItem.id, "completed")).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Phase B3: validateAuditIntegrity
  // -------------------------------------------------------------------------

  describe("validateAuditIntegrity", () => {
    test("reports gap when completed item has no audit trail", () => {
      // Use a temp audit path with no entries
      const emptyAuditPath = join(tmpDir, "empty-audit.jsonl");
      const queue = WorkQueue._createForTesting([
        {
          id: "completed-no-audit",
          title: "Completed but no audit",
          description: "",
          status: "completed",
          priority: "normal",
          dependencies: [],
          source: "manual",
          createdAt: new Date().toISOString(),
        },
      ]);
      const guard = new TransitionGuard(queue, emptyAuditPath);
      const result = guard.validateAuditIntegrity();
      expect(result.valid).toBe(false);
      expect(result.gaps.length).toBe(1);
      expect(result.gaps[0].itemId).toBe("completed-no-audit");
    });

    test("reports valid when all terminal items have audit entries", () => {
      const auditPath = join(tmpDir, "full-audit.jsonl");
      const { writeFileSync } = require("fs");
      writeFileSync(auditPath, JSON.stringify({ itemId: "audited-item", action: "status_change" }) + "\n");

      const queue = WorkQueue._createForTesting([
        {
          id: "audited-item",
          title: "Has audit trail",
          description: "",
          status: "completed",
          priority: "normal",
          dependencies: [],
          source: "manual",
          createdAt: new Date().toISOString(),
        },
      ]);
      const guard = new TransitionGuard(queue, auditPath);
      const result = guard.validateAuditIntegrity();
      expect(result.valid).toBe(true);
      expect(result.gaps.length).toBe(0);
    });
  });
});
