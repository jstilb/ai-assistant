/**
 * WorkQueue.test.ts — Tests for unified work queue + DAG
 *
 * Covers: cycle detection, getReadyItems with dependency filtering,
 * status transitions, getParallelBatch safety, legacy JSONL import,
 * WorkItemMetadata (workSurface).
 */

import { describe, it, expect, beforeEach, afterAll, spyOn } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from "fs";

// ============================================================================
// KAYA_HOME/KAYA_DIR isolation — set BEFORE any import that reads env at
// module-init time. mkdtemp gives a unique, collision-free sandbox per run;
// KAYA_DIR is pinned alongside KAYA_HOME and KAYA_ALERT_DRY_RUN=1 is
// belt-and-suspenders, mirroring the canonical pattern in
// PipelineUpsertGuard.test.ts / WaitingOnJmNotifier.test.ts. The S5a blocks
// below also use TEST_BASE as their real-fs sandbox root instead of a real
// path under the repo (import.meta.dir) — a prior run of that pattern left a
// tracked artifact (__test_tmp__/wq.json) committed into the repo.
// ============================================================================
const TEST_BASE = mkdtempSync(join(tmpdir(), "workqueue-test-"));
// Snapshot BEFORE overwriting: these three keys must be restored in afterAll.
// Leaking them poisons every later file in the same bun process — leaked
// KAYA_ALERT_DRY_RUN=1 makes AlertGate.send() return 'dry-run' for suites
// that assert real send results (broke HealthManager.test.ts's checkForGaps
// block in whole-dir runs, 2026-07-12), and a leaked KAYA_HOME points at a
// directory this file's afterAll deletes.
const PREV_ENV: Record<string, string | undefined> = {
  KAYA_HOME: process.env.KAYA_HOME,
  KAYA_DIR: process.env.KAYA_DIR,
  KAYA_ALERT_DRY_RUN: process.env.KAYA_ALERT_DRY_RUN,
};
process.env.KAYA_HOME = TEST_BASE;
process.env.KAYA_DIR = TEST_BASE;
process.env.KAYA_ALERT_DRY_RUN = "1";

import { WorkQueue, type WorkItem, type WorkStatus, type WorkItemMetadata } from "./WorkQueue.ts";
// pipeline_items is the ONE store WorkQueue and QueueRouter share (ADR-003). The
// cross-writer tests below need a handle to the SAME PipelineRepository singleton
// WorkQueue's own constructor initializes for a given dbPath, to (a) simulate a
// concurrent QueueRouter write via repo.upsert() directly, and (b) read the raw row
// post-write via repo.get() — wq.getItem() can't be used for that assertion: it always
// reconstructs from the embedded metadata.rawWorkItem snapshot and is structurally
// blind to a clobbered top-level metadata column either way (see the describe-block
// note below in this file for the full explanation).
// cross-skill-allowed: test-only handle to the shared PipelineRepository singleton, for the reasons above.
import { getPipelineRepository } from "../../QueueRouter/Tools/PipelineRepository.ts";
// Uses QueueRouter's REAL codec (not a hand-rolled shape) to build the simulated
// competing write, so the test exercises the exact same mergeMetadata:true call shape
// QueueRouter's own 7 already-fixed call sites use in production — a fabricated write
// shape would prove nothing about the real cross-writer collision this slice closes.
// cross-skill-allowed: test-only, produces a genuine QueueRouter-shaped competing write, for the reasons above.
import { queueItemToPipelineParams } from "../../QueueRouter/Tools/lib/vocabulary.ts";
// cross-skill-allowed: type-only — types makeQueueItemFixture()'s input, the fixture factory that builds the QueueItem literal fed into queueItemToPipelineParams above; erased at runtime, no cross-skill runtime dependency.
import type { QueueItem } from "../../QueueRouter/Tools/QueueManager.ts";

// Import evaluation (above) may have already resolved getKayaHome() against a
// stale/live env — ES modules evaluate every statically-imported dependency
// before this file's own top-level code runs, regardless of textual order
// (see the KayaHome CACHE GOTCHA note in WaitingOnJmNotifier.test.ts). Reset
// now that KAYA_HOME/KAYA_DIR are correctly set, so every actual call during
// test execution re-resolves against TEST_BASE.

afterAll(() => {
  for (const [k, v] of Object.entries(PREV_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { rmSync(TEST_BASE, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    title: `Item ${overrides.id}`,
    description: "",
    status: "pending",
    priority: "normal",
    dependencies: [],
    source: "manual",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DAG cycle detection
// ---------------------------------------------------------------------------

describe("WorkQueue.detectCycles()", () => {
  it("no cycle for empty queue", () => {
    const wq = WorkQueue._createForTesting([]);
    expect(wq.detectCycles().hasCycle).toBe(false);
  });

  it("no cycle for independent items", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a" }),
      makeItem({ id: "b" }),
    ]);
    expect(wq.detectCycles().hasCycle).toBe(false);
  });

  it("no cycle for valid chain A→B→C", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a" }),
      makeItem({ id: "b", dependencies: ["a"] }),
      makeItem({ id: "c", dependencies: ["b"] }),
    ]);
    expect(wq.detectCycles().hasCycle).toBe(false);
  });

  it("detects 2-item cycle A↔B", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", dependencies: ["b"] }),
      makeItem({ id: "b", dependencies: ["a"] }),
    ]);
    const result = wq.detectCycles();
    expect(result.hasCycle).toBe(true);
    expect(result.cycle).toBeDefined();
  });

  it("detects 3-item cycle A→B→C→A", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", dependencies: ["c"] }),
      makeItem({ id: "b", dependencies: ["a"] }),
      makeItem({ id: "c", dependencies: ["b"] }),
    ]);
    const result = wq.detectCycles();
    expect(result.hasCycle).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validate()
// ---------------------------------------------------------------------------

describe("WorkQueue.validate()", () => {
  it("valid for no items", () => {
    const wq = WorkQueue._createForTesting([]);
    const result = wq.validate();
    expect(result.valid).toBe(true);
  });

  it("valid for items without dependencies", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a" }),
      makeItem({ id: "b" }),
    ]);
    expect(wq.validate().valid).toBe(true);
  });

  it("reports missing dependency", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", dependencies: ["nonexistent"] }),
    ]);
    const result = wq.validate();
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /missing/i.test(e))).toBe(true);
  });

  it("reports cycle as validation error", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", dependencies: ["b"] }),
      makeItem({ id: "b", dependencies: ["a"] }),
    ]);
    const result = wq.validate();
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /[Cc]ycle/i.test(e))).toBe(true);
  });

  it("passes valid DAG A→B→C", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a" }),
      makeItem({ id: "b", dependencies: ["a"] }),
      makeItem({ id: "c", dependencies: ["b"] }),
    ]);
    expect(wq.validate().valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getReadyItems()
// ---------------------------------------------------------------------------

describe("WorkQueue.getReadyItems()", () => {
  it("returns all pending items with no deps", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a" }),
      makeItem({ id: "b" }),
    ]);
    expect(wq.getReadyItems().length).toBe(2);
  });

  it("excludes items with unmet deps", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a" }),
      makeItem({ id: "b", dependencies: ["a"] }),
    ]);
    const ready = wq.getReadyItems();
    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe("a");
  });

  it("includes items once deps are completed", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", status: "completed" }),
      makeItem({ id: "b", dependencies: ["a"] }),
    ]);
    const ready = wq.getReadyItems();
    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe("b");
  });

  it("excludes non-pending items", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", status: "in_progress" }),
      makeItem({ id: "b", status: "completed" }),
      makeItem({ id: "c", status: "failed" }),
    ]);
    expect(wq.getReadyItems().length).toBe(0);
  });

  it("sorts by priority descending", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "lo", priority: "low" }),
      makeItem({ id: "hi", priority: "high" }),
      makeItem({ id: "cr", priority: "critical" }),
      makeItem({ id: "no", priority: "normal" }),
    ]);
    const ready = wq.getReadyItems();
    expect(ready.map(i => i.id)).toEqual(["cr", "hi", "no", "lo"]);
  });
});

// ---------------------------------------------------------------------------
// getParallelBatch()
// ---------------------------------------------------------------------------

describe("WorkQueue.getParallelBatch()", () => {
  it("returns empty for no ready items", () => {
    const wq = WorkQueue._createForTesting([]);
    expect(wq.getParallelBatch().length).toBe(0);
  });

  it("batches independent items", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a" }),
      makeItem({ id: "b" }),
      makeItem({ id: "c" }),
    ]);
    expect(wq.getParallelBatch(3).length).toBe(3);
  });

  it("excludes items sharing a dependency", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "shared", status: "completed" }),
      makeItem({ id: "x", dependencies: ["shared"] }),
      makeItem({ id: "y", dependencies: ["shared"] }),
    ]);
    // x and y share dep "shared" → only one in batch
    const batch = wq.getParallelBatch(5);
    expect(batch.length).toBe(1);
  });

  it("respects maxItems", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a" }),
      makeItem({ id: "b" }),
      makeItem({ id: "c" }),
    ]);
    expect(wq.getParallelBatch(2).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

describe("WorkQueue.updateStatus()", () => {
  const passedVerification = {
    status: "verified" as const, verifiedAt: new Date().toISOString(), verdict: "PASS" as const,
    concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
    verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
  };

  it("transitions pending → in_progress with startedAt", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a" })]);
    const item = wq.updateStatus("a", "in_progress");
    expect(item?.status).toBe("in_progress");
    expect(item?.startedAt).toBeDefined();
  });

  it("transitions in_progress → completed with completedAt (verified item)", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "in_progress" })]);
    wq.setVerification("a", passedVerification);
    const item = wq.updateStatus("a", "completed", "done");
    expect(item?.status).toBe("completed");
    expect(item?.completedAt).toBeDefined();
    expect(item?.result).toBe("done");
  });

  it("transitions to failed with error detail", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "in_progress" })]);
    const item = wq.updateStatus("a", "failed", "timeout");
    expect(item?.status).toBe("failed");
    expect(item?.error).toBe("timeout");
  });

  it("returns null for unknown id", () => {
    const wq = WorkQueue._createForTesting([]);
    expect(wq.updateStatus("nope", "in_progress")).toBeNull();
  });

  it("increments totalProcessed on completion", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "in_progress" })]);
    wq.setVerification("a", passedVerification);
    wq.updateStatus("a", "completed");
    expect(wq.getStats().totalProcessed).toBe(1);
  });

  it("increments totalFailed on failure", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "in_progress" })]);
    wq.updateStatus("a", "failed", "err");
    expect(wq.getStats().totalFailed).toBe(1);
  });

  it("throws when completing without verification record", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "in_progress" })]);
    expect(() => wq.updateStatus("a", "completed")).toThrow("no verification record");
  });

  it("throws when completing with failed verification", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "in_progress" })]);
    wq.setVerification("a", {
      status: "failed", verifiedAt: new Date().toISOString(), verdict: "FAIL",
      concerns: ["Paper completion"], iscRowsVerified: 0, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    expect(() => wq.updateStatus("a", "completed")).toThrow("failed");
  });

  it("throws when completing with needs_review verification", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "in_progress" })]);
    wq.setVerification("a", {
      status: "needs_review", verifiedAt: new Date().toISOString(), verdict: "NEEDS_REVIEW",
      concerns: ["Low confidence"], iscRowsVerified: 0, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    expect(() => wq.updateStatus("a", "completed")).toThrow("needs_review");
  });

  it("allows completion only when verification status is verified", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "in_progress" })]);
    wq.setVerification("a", passedVerification);
    const item = wq.updateStatus("a", "completed");
    expect(item?.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// S5a — loadFromDb does NOT fall back to work-queue.json when db is empty
// ---------------------------------------------------------------------------

describe("S5a — WorkQueue.loadFromDb ignores work-queue.json", () => {
  const TMP_DIR = join(TEST_BASE, "s5a-loadfromdb");
  const TMP_STATE = join(TMP_DIR, "wq.json");

  beforeEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });

  it("starts empty when pipeline.db is empty — does NOT import from work-queue.json", () => {
    // Write a legacy JSON state file with pending items
    const legacyState = {
      items: [
        { id: "legacy-item-1", title: "Legacy Task", description: "", status: "pending", priority: "normal", dependencies: [], source: "manual", createdAt: new Date().toISOString() },
      ],
      lastUpdated: new Date().toISOString(),
      totalProcessed: 0,
      totalFailed: 0,
    };
    writeFileSync(TMP_STATE, JSON.stringify(legacyState));

    // Fresh WorkQueue — pipeline.db at TMP_DIR/.kaya/runtime/pipeline.db is empty
    // RED before S5a: loadFromDb sees empty db + TMP_STATE exists → imports legacy items → length=1
    // GREEN after S5a: no JSON fallback → getAllItems() returns []
    const wq = new WorkQueue(TMP_STATE);
    expect(wq.getAllItems().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getDagBlockedItems()
// ---------------------------------------------------------------------------

describe("WorkQueue.getDagBlockedItems()", () => {
  it("returns items with unmet deps", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a" }),
      makeItem({ id: "b", dependencies: ["a"] }),
    ]);
    const blocked = wq.getDagBlockedItems();
    expect(blocked.length).toBe(1);
    expect(blocked[0].id).toBe("b");
  });

  it("returns empty when all deps met", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", status: "completed" }),
      makeItem({ id: "b", dependencies: ["a"] }),
    ]);
    expect(wq.getDagBlockedItems().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getStats()
// ---------------------------------------------------------------------------

describe("WorkQueue.getStats()", () => {
  it("counts all statuses", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", status: "pending" }),
      makeItem({ id: "b", status: "in_progress" }),
      makeItem({ id: "c", status: "completed" }),
      makeItem({ id: "d", status: "failed" }),
    ]);
    const s = wq.getStats();
    expect(s.total).toBe(4);
    expect(s.pending).toBe(1);
    expect(s.inProgress).toBe(1);
    expect(s.completed).toBe(1);
    expect(s.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// S5b: warnUnwiredPhaseItems() — warn-on-detect replaces title-regex auto-wiring
// ---------------------------------------------------------------------------

describe("WorkQueue.warnUnwiredPhaseItems() (S5b)", () => {
  it("does NOT mutate dependencies — phase order is no longer auto-wired from titles", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "p1", title: "LucidTasks Phase 1: Core features" }),
      makeItem({ id: "p2", title: "LucidTasks Phase 2: Database schema" }),
    ]);
    wq.warnUnwiredPhaseItems();
    expect(wq.getItem("p2")!.dependencies).toEqual([]);
    expect(wq.getItem("p1")!.dependencies).toEqual([]);
  });

  it("detects + counts unwired phase transitions within a family", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "p1", title: "MySkill Phase 1: Core" }),
      makeItem({ id: "p2", title: "MySkill Phase 2: Advanced" }),
      makeItem({ id: "p3", title: "MySkill Phase 3: Polish" }),
    ]);
    // p2→p1 and p3→p2 each lack an explicit dependency → 2 unwired transitions.
    expect(wq.warnUnwiredPhaseItems()).toBe(2);
  });

  it("returns 0 when phase items already carry explicit dependencies", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "p1", title: "LucidTasks Phase 1: Core" }),
      makeItem({ id: "p2", title: "LucidTasks Phase 2: Schema", dependencies: ["p1"] }),
    ]);
    expect(wq.warnUnwiredPhaseItems()).toBe(0);
  });

  it("ignores non-phased items and single-member families", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", title: "Fix authentication bug" }),
      makeItem({ id: "p1", title: "LucidTasks Phase 1: Core" }),
    ]);
    expect(wq.warnUnwiredPhaseItems()).toBe(0);
  });

  it("getReadyItems() returns ALL phase items (no auto-wire) when none have explicit deps", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "p1", title: "LucidTasks Phase 1: Core" }),
      makeItem({ id: "p2", title: "LucidTasks Phase 2: Schema" }),
      makeItem({ id: "p3", title: "LucidTasks Phase 3: Tests" }),
      makeItem({ id: "p4", title: "LucidTasks Phase 4: Docs" }),
    ]);
    // The title-regex DAG inference is gone: with no explicit deps, all 4 are ready.
    const ready = wq.getReadyItems();
    expect(ready.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// S5b: getReadyItems() sorts by priority only (phase-number tiebreaker removed)
// ---------------------------------------------------------------------------

describe("WorkQueue.getReadyItems() sort (S5b: priority-only)", () => {
  it("does NOT reorder same-priority items by phase number (title-regex tiebreaker removed)", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "p3", title: "SkillA Phase 3: Polish", priority: "normal" }),
      makeItem({ id: "p1", title: "SkillA Phase 1: Core", priority: "normal" }),
      makeItem({ id: "p2", title: "SkillA Phase 2: Advanced", priority: "normal" }),
    ]);
    // All ready; the phase-number tiebreaker is gone, so same-priority order is the stable
    // insertion order (NOT phase-sorted to p1,p2,p3).
    const ready = wq.getReadyItems();
    expect(ready.map(i => i.id)).toEqual(["p3", "p1", "p2"]);
  });

  it("priority still takes precedence over phase number", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "p1", title: "SkillA Phase 1: Core", priority: "normal" }),
      makeItem({ id: "hi", title: "Urgent fix", priority: "high" }),
    ]);
    const ready = wq.getReadyItems();
    expect(ready[0].id).toBe("hi");
    expect(ready[1].id).toBe("p1");
  });
});

// ---------------------------------------------------------------------------
// setMetadata()
// ---------------------------------------------------------------------------

describe("WorkQueue.setMetadata()", () => {
  it("merges keys into existing metadata", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", metadata: { existing: "value" } }),
    ]);
    wq.setMetadata("a", { newKey: 42 });
    const item = wq.getItem("a")!;
    expect(item.metadata?.existing).toBe("value");
    expect(item.metadata?.newKey).toBe(42);
  });

  it("creates metadata if absent", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a" })]);
    wq.setMetadata("a", { key: "val" });
    expect(wq.getItem("a")!.metadata?.key).toBe("val");
  });

  it("overwrites existing keys", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", metadata: { x: 1 } }),
    ]);
    wq.setMetadata("a", { x: 2 });
    expect(wq.getItem("a")!.metadata?.x).toBe(2);
  });

  it("no-ops for unknown id", () => {
    const wq = WorkQueue._createForTesting([]);
    wq.setMetadata("nope", { key: "val" }); // should not throw
  });
});

// ---------------------------------------------------------------------------
// resetToPending()
// ---------------------------------------------------------------------------

describe("WorkQueue.resetToPending()", () => {
  it("resets in_progress to pending", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", status: "in_progress", startedAt: new Date().toISOString() }),
    ]);
    const item = wq.resetToPending("a", "test recovery");
    expect(item?.status).toBe("pending");
  });

  it("clears verification on reset", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", status: "in_progress", verification: {
        status: "needs_review", verifiedAt: new Date().toISOString(), verdict: "NEEDS_REVIEW",
        concerns: [], iscRowsVerified: 0, iscRowsTotal: 1, verificationCost: 0,
        verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
      }}),
    ]);
    wq.resetToPending("a", "test");
    expect(wq.getItem("a")!.verification).toBeUndefined();
  });

  it("records audit trail in metadata.lastRecovery", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", status: "in_progress" }),
    ]);
    wq.resetToPending("a", "orphan detected");
    const recovery = wq.getItem("a")!.metadata?.lastRecovery as Record<string, unknown>;
    expect(recovery.reason).toBe("orphan detected");
    expect(recovery.previousStatus).toBe("in_progress");
    expect(recovery.recoveredAt).toBeDefined();
  });

  it("throws when called on pending item", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "pending" })]);
    expect(() => wq.resetToPending("a", "test")).toThrow("Illegal transition");
  });

  it("throws when called on completed item", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "completed" })]);
    expect(() => wq.resetToPending("a", "test")).toThrow("Illegal transition");
  });

  it("returns null for unknown id", () => {
    const wq = WorkQueue._createForTesting([]);
    expect(wq.resetToPending("nope", "test")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setVerification() whitelist (provenance fix)
// ---------------------------------------------------------------------------

describe("WorkQueue.setVerification() whitelist", () => {
  it("strips unknown fields (e.g. manualVerification not persisted)", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a" })]);
    const injected = {
      status: "verified" as const,
      verifiedAt: new Date().toISOString(),
      verdict: "PASS" as const,
      concerns: [],
      iscRowsVerified: 1,
      iscRowsTotal: 1,
      verificationCost: 0,
      verifiedBy: "skeptical_verifier" as const,
      tiersExecuted: [],
      manualVerification: true,  // injected field
      extraField: "should be stripped",
    };
    wq.setVerification("a", injected as never);
    const item = wq.getItem("a")!;
    expect(item.verification).toBeDefined();
    expect((item.verification as Record<string, unknown>)["manualVerification"]).toBeUndefined();
    expect((item.verification as Record<string, unknown>)["extraField"]).toBeUndefined();
  });

  it("persists all whitelisted fields correctly", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a" })]);
    const verification = {
      status: "verified" as const,
      verifiedAt: "2026-02-18T00:00:00Z",
      verdict: "PASS" as const,
      concerns: ["minor issue"],
      iscRowsVerified: 3,
      iscRowsTotal: 5,
      verificationCost: 0.05,
      verifiedBy: "skeptical_verifier" as const,
      tiersExecuted: [1, 2],
    };
    wq.setVerification("a", verification);
    const item = wq.getItem("a")!;
    expect(item.verification!.status).toBe("verified");
    expect(item.verification!.verifiedAt).toBe("2026-02-18T00:00:00Z");
    expect(item.verification!.verdict).toBe("PASS");
    expect(item.verification!.concerns).toEqual(["minor issue"]);
    expect(item.verification!.iscRowsVerified).toBe(3);
    expect(item.verification!.iscRowsTotal).toBe(5);
    expect(item.verification!.verificationCost).toBe(0.05);
    expect(item.verification!.verifiedBy).toBe("skeptical_verifier");
    expect(item.verification!.tiersExecuted).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// setVerification() provenance guard
// ---------------------------------------------------------------------------

describe("WorkQueue.setVerification() provenance guard", () => {
  it("throws on verifiedBy: 'manual' (fabricated provenance)", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a" })]);
    expect(() => wq.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "manual" as "skeptical_verifier", tiersExecuted: [],
    })).toThrow('is not "skeptical_verifier"');
  });

  it("throws on verifiedBy: 'agent_report_verification' (fabricated provenance)", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a" })]);
    expect(() => wq.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "agent_report_verification" as "skeptical_verifier",
      tiersExecuted: [],
    })).toThrow('is not "skeptical_verifier"');
  });

  it("throws on verifiedBy: 'manual_orchestrator_verification' (fabricated provenance)", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a" })]);
    expect(() => wq.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "manual_orchestrator_verification" as "skeptical_verifier",
      tiersExecuted: [],
    })).toThrow('is not "skeptical_verifier"');
  });

  it("accepts verifiedBy: 'skeptical_verifier'", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a" })]);
    wq.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0.02,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    expect(wq.getItem("a")!.verification!.verifiedBy).toBe("skeptical_verifier");
  });
});

// ---------------------------------------------------------------------------
// updateStatus() provenance guard for completion
// ---------------------------------------------------------------------------

describe("WorkQueue.updateStatus() provenance guard", () => {
  it("getItem() clone prevents verification injection bypass", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", effort: "STANDARD", status: "in_progress" })]);
    // Attempt to bypass setVerification guard by mutating getItem() result
    const item = wq.getItem("a")!;
    item.verification = {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "manual" as "skeptical_verifier", tiersExecuted: [],
    };
    // Clone means internal state is unaffected — completion is blocked
    expect(() => wq.updateStatus("a", "completed")).toThrow("no verification record exists");
  });

  it("setVerification rejects verifiedBy: 'manual' for non-TRIVIAL items", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", effort: "STANDARD", status: "in_progress" })]);
    expect(() => wq.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "manual" as "skeptical_verifier", tiersExecuted: [],
    })).toThrow("not \"skeptical_verifier\"");
  });

  it("resolveBlocked throws for items without humanTaskRef", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "blocked" })]);
    expect(() => wq.resolveBlocked("a")).toThrow("has no humanTaskRef");
  });

  it("allows humanTaskRef proxy items to complete via resolveBlocked", () => {
    const wq = WorkQueue._createForTesting([makeItem({
      id: "a",
      status: "blocked",
      humanTaskRef: { queueItemId: "parent-1", guideFilePath: "/tmp/guide.md", createdAt: new Date().toISOString() },
    })]);
    const updated = wq.resolveBlocked("a", "Resolved by Jm");
    expect(updated?.status).toBe("completed");
    expect(updated?.verification?.verifiedBy).toBe("human_proxy");
  });

  // resumeBlocked() — recovery path for a directly-blocked REAL item (no
  // top-level humanTaskRef) once its human PREREQ clears. Must re-pend (run it),
  // NOT complete it (which would be a false completion for an unbuilt item).
  it("resumeBlocked re-pends a directly-blocked real item and clears stale markers", () => {
    const wq = WorkQueue._createForTesting([makeItem({
      id: "a",
      status: "blocked",
      metadata: { humanTaskRef: "manual-a", escalationReason: "needs prereq", escalatedAt: "2026-06-14" },
      startedAt: new Date().toISOString(),
    })]);
    const updated = wq.resumeBlocked("a", "Prereqs satisfied");
    expect(updated?.status).toBe("pending");
    // Did NOT complete (no false completion)
    expect(updated?.completedAt).toBeUndefined();
    expect(updated?.verification).toBeUndefined();
    // Stale whole-item escalation markers shed; resolution recorded
    expect(updated?.metadata?.humanTaskRef).toBeUndefined();
    expect(updated?.metadata?.escalationReason).toBeUndefined();
    expect((updated?.metadata?.blockResolution as { reason: string })?.reason).toBe("Prereqs satisfied");
    expect(wq.getBlockedItems().length).toBe(0);
  });

  it("resumeBlocked rejects human-proxy items (use resolveBlocked instead)", () => {
    const wq = WorkQueue._createForTesting([makeItem({
      id: "a",
      status: "blocked",
      humanTaskRef: { queueItemId: "parent-1", guideFilePath: "/tmp/guide.md", createdAt: new Date().toISOString() },
    })]);
    expect(() => wq.resumeBlocked("a", "x")).toThrow("is a human-proxy item");
  });

  it("resumeBlocked rejects non-blocked items", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "pending" })]);
    expect(() => wq.resumeBlocked("a", "x")).toThrow("expected \"blocked\"");
  });

  it("matrix allows blocked → pending", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "blocked" })]);
    expect(wq.updateStatus("a", "pending")?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Verification sanitization on load (defense-in-depth)
// ---------------------------------------------------------------------------

describe("verification sanitization on loadState", () => {
  const SANITIZE_DIR = join(TEST_BASE, "s5a-sanitize");
  const SANITIZE_PATH = join(SANITIZE_DIR, "work-queue.json");

  // S5a: the JSON migration guard was deleted — WorkQueue no longer imports from
  // work-queue.json even when pipeline.db is empty. Verify that a legacy JSON
  // file is ignored and the queue starts empty.
  it("S5a: legacy work-queue.json is NOT imported — queue starts empty", () => {
    if (existsSync(SANITIZE_DIR)) rmSync(SANITIZE_DIR, { recursive: true });
    mkdirSync(SANITIZE_DIR, { recursive: true });

    const legacyState = {
      items: [{
        id: "test-1",
        title: "Test Item",
        description: "desc",
        status: "in_progress",
        priority: "normal",
        dependencies: [],
        source: "manual",
        createdAt: new Date().toISOString(),
      }],
      lastUpdated: new Date().toISOString(),
      totalProcessed: 0,
      totalFailed: 0,
    };
    writeFileSync(SANITIZE_PATH, JSON.stringify(legacyState));

    // S5a: no JSON fallback — item in JSON is NOT loaded into the queue
    const wq = new WorkQueue(SANITIZE_PATH);
    expect(wq.getItem("test-1")).toBeUndefined();

    // Cleanup
    rmSync(SANITIZE_DIR, { recursive: true });
  });

  it("setSpecPath updates specPath on item", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", specPath: "MEMORY/specs/old.md" })]);
    wq.setSpecPath("a", "plans/Specs/new.md");
    const item = wq.getItem("a");
    expect(item!.specPath).toBe("plans/Specs/new.md");
  });
});

// ---------------------------------------------------------------------------
// Transition matrix enforcement (Phase 6a)
// ---------------------------------------------------------------------------

describe("transition matrix", () => {
  const passedVerification = {
    status: "verified" as const, verifiedAt: new Date().toISOString(), verdict: "PASS" as const,
    concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
    verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
  };

  // --- Invalid transitions (should throw) ---

  it("rejects pending -> completed", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "pending" })]);
    expect(() => wq.updateStatus("a", "completed")).toThrow("Illegal transition");
  });

  it("rejects pending -> failed", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "pending" })]);
    expect(() => wq.updateStatus("a", "failed")).toThrow("Illegal transition");
  });

  it("rejects pending -> partial", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "pending" })]);
    expect(() => wq.updateStatus("a", "partial")).toThrow("Illegal transition");
  });

  it("rejects pending -> pending", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "pending" })]);
    expect(() => wq.updateStatus("a", "pending")).toThrow("Illegal transition");
  });

  it("rejects completed -> pending", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "completed" })]);
    expect(() => wq.updateStatus("a", "pending")).toThrow("Illegal transition");
  });

  it("rejects completed -> in_progress", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "completed" })]);
    expect(() => wq.updateStatus("a", "in_progress")).toThrow("Illegal transition");
  });

  it("rejects completed -> failed", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "completed" })]);
    expect(() => wq.updateStatus("a", "failed")).toThrow("Illegal transition");
  });

  it("rejects completed -> completed (terminal)", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "completed" })]);
    expect(() => wq.updateStatus("a", "completed")).toThrow("Illegal transition");
  });

  it("rejects failed -> in_progress", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "failed" })]);
    expect(() => wq.updateStatus("a", "in_progress")).toThrow("Illegal transition");
  });

  it("rejects failed -> completed", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "failed" })]);
    expect(() => wq.updateStatus("a", "completed")).toThrow("Illegal transition");
  });

  it("rejects partial -> completed", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "partial" })]);
    expect(() => wq.updateStatus("a", "completed")).toThrow("Illegal transition");
  });

  it("rejects partial -> failed", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "partial" })]);
    expect(() => wq.updateStatus("a", "failed")).toThrow("Illegal transition");
  });

  it("allows blocked -> pending (resumeBlocked recovery path)", () => {
    // Changed by design: a real item blocked on a human PREREQ must be able to
    // re-pend once the prereq clears (resumeBlocked), instead of being stranded.
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "blocked" })]);
    expect(wq.updateStatus("a", "pending")?.status).toBe("pending");
  });

  it("rejects blocked -> in_progress", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "blocked" })]);
    expect(() => wq.updateStatus("a", "in_progress")).toThrow("Illegal transition");
  });

  // --- Valid transitions (should succeed) ---

  it("allows pending -> in_progress", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "pending" })]);
    const item = wq.updateStatus("a", "in_progress");
    expect(item?.status).toBe("in_progress");
  });

  it("allows in_progress -> completed (with verification)", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "in_progress" })]);
    wq.setVerification("a", passedVerification);
    const item = wq.updateStatus("a", "completed");
    expect(item?.status).toBe("completed");
  });

  it("allows in_progress -> failed", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "in_progress" })]);
    const item = wq.updateStatus("a", "failed", "oops");
    expect(item?.status).toBe("failed");
  });

  it("allows in_progress -> partial", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "in_progress" })]);
    const item = wq.updateStatus("a", "partial");
    expect(item?.status).toBe("partial");
  });

  it("allows in_progress -> pending", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "in_progress" })]);
    const item = wq.updateStatus("a", "pending");
    expect(item?.status).toBe("pending");
  });

  it("allows in_progress -> blocked", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "in_progress" })]);
    const item = wq.updateStatus("a", "blocked");
    expect(item?.status).toBe("blocked");
  });

  it("allows partial -> in_progress", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "partial" })]);
    const item = wq.updateStatus("a", "in_progress");
    expect(item?.status).toBe("in_progress");
  });

  it("allows partial -> pending", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "partial" })]);
    const item = wq.updateStatus("a", "pending");
    expect(item?.status).toBe("pending");
  });

  it("allows failed -> pending (retry)", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "failed" })]);
    const item = wq.updateStatus("a", "pending");
    expect(item?.status).toBe("pending");
  });

  it("allows blocked -> completed (with verification)", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "blocked" })]);
    wq.setVerification("a", passedVerification);
    const item = wq.updateStatus("a", "completed");
    expect(item?.status).toBe("completed");
  });

  it("allows blocked -> failed", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "blocked" })]);
    const item = wq.updateStatus("a", "failed");
    expect(item?.status).toBe("failed");
  });

  // --- S2: canonical-path specific tests ---

  it("S2: rejects done -> in_progress via canonical path", () => {
    // done = Stage "done"; in_progress = Stage "in-progress"; canonical "done" exits: ["archived"] only
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "completed" })]);
    expect(() => wq.updateStatus("a", "in_progress")).toThrow("Illegal transition");
  });

  it("S2: allows in_progress -> pending (reset now legal via canonical approved exit)", () => {
    // in_progress(Stage: in-progress) → pending(Stage: approved) — additive canonical entry proves reconciliation
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "in_progress" })]);
    const item = wq.updateStatus("a", "pending");
    expect(item?.status).toBe("pending");
  });

  it("S2: rejects needs_review -> completed (must route through in_progress first)", () => {
    // needs-review→done is canonical-legal for spec-pipeline but WorkQueue executor
    // must always re-claim via in_progress to pass the verification gate.
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "needs_review" })]);
    expect(() => wq.updateStatus("a", "completed")).toThrow("Illegal transition");
  });
});

// ---------------------------------------------------------------------------
// A3 — updateStatus() persists stage crossings atomically via repo.transition()
// ---------------------------------------------------------------------------

describe("A3 — updateStatus() atomic transition via repo.transition()", () => {
  function eventsFor(wq: WorkQueue, id: string): Array<{ from_stage: string | null; to_stage: string; actor: string }> {
    const rawDb = (wq as unknown as { repo: { db: import("bun:sqlite").Database } }).repo.db;
    return rawDb
      .prepare("SELECT from_stage, to_stage, actor FROM pipeline_events WHERE item_id = ? AND from_stage IS NOT NULL")
      .all(id) as Array<{ from_stage: string | null; to_stage: string; actor: string }>;
  }

  function dbStage(wq: WorkQueue, id: string): string {
    const rawDb = (wq as unknown as { repo: { db: import("bun:sqlite").Database } }).repo.db;
    const row = rawDb.prepare("SELECT stage FROM pipeline_items WHERE id = ?").get(id) as { stage: string };
    return row.stage;
  }

  // NOTE: each test below uses an id unique across the WHOLE file (not just this
  // describe block) — _createForTesting()'s repo is `new PipelineRepository(":memory:")`,
  // and getPipelineDb() caches PipelineDB instances by path string, so every
  // ":memory:" instance across this entire test file (100+ tests reuse id "a")
  // shares ONE underlying sqlite connection. WorkQueue.state (a plain JS array) is
  // per-instance and unaffected, but pipeline_events is append-only and keyed by
  // item_id — reusing "a" here would pick up event rows left behind by unrelated
  // earlier tests. A file-unique id sidesteps that shared-cache artifact entirely.

  it("legal crossing writes exactly one pipeline_events row with actor 'WorkQueue.updateStatus'", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a3-legal", status: "pending" })]);
    const item = wq.updateStatus("a3-legal", "in_progress");
    expect(item?.status).toBe("in_progress");

    const rows = eventsFor(wq, "a3-legal");
    expect(rows.length).toBe(1);
    expect(rows[0].from_stage).toBe("approved");
    expect(rows[0].to_stage).toBe("in-progress");
    expect(rows[0].actor).toBe("WorkQueue.updateStatus");
    expect(dbStage(wq, "a3-legal")).toBe("in-progress");
  });

  it("canonically-illegal crossing throws and writes no event; stage unchanged in DB and in-memory", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a3-illegal", status: "pending" })]);
    expect(() => wq.updateStatus("a3-illegal", "completed")).toThrow("Illegal transition");

    expect(eventsFor(wq, "a3-illegal").length).toBe(0);
    expect(dbStage(wq, "a3-illegal")).toBe("approved");
    expect(wq.getItem("a3-illegal")?.status).toBe("pending");
  });

  it("wqExcluded crossing (blocked -> in_progress) throws before reaching repo.transition(); writes no event", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a3-wqexcluded", status: "blocked" })]);
    expect(() => wq.updateStatus("a3-wqexcluded", "in_progress")).toThrow("Illegal transition");

    expect(eventsFor(wq, "a3-wqexcluded").length).toBe(0);
    expect(dbStage(wq, "a3-wqexcluded")).toBe("blocked");
    expect(wq.getItem("a3-wqexcluded")?.status).toBe("blocked");
  });

  it("completion hard-gate (missing verification) blocks a canonically-legal crossing and writes no event", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a3-hardgate", status: "in_progress" })]);
    expect(() => wq.updateStatus("a3-hardgate", "completed")).toThrow("no verification record exists");

    expect(eventsFor(wq, "a3-hardgate").length).toBe(0);
    expect(dbStage(wq, "a3-hardgate")).toBe("in-progress");
    expect(wq.getItem("a3-hardgate")?.status).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------
// recordAttempt routes through transition matrix (Phase 6b)
// ---------------------------------------------------------------------------

describe("recordAttempt transition matrix", () => {
  it("recordAttempt on in_progress item succeeds (in_progress -> pending)", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "in_progress" })]);
    const result = wq.recordAttempt("a", {
      attemptNumber: 1,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      error: "test error",
      strategy: "standard",
    });
    expect(result?.status).toBe("pending");
  });

  it("recordAttempt on pending item throws (invalid source state)", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "pending" })]);
    expect(() => wq.recordAttempt("a", {
      attemptNumber: 1,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      error: "test error",
      strategy: "standard",
    })).toThrow("Illegal transition");
  });
});

// ---------------------------------------------------------------------------
// getItem() / getAllItems() immutability (structuredClone)
// ---------------------------------------------------------------------------

describe("getItem / getAllItems immutability", () => {
  it("getItem returns a deep clone — mutations do not affect internal state", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", status: "in_progress" }),
    ]);

    const item = wq.getItem("a");
    expect(item).toBeDefined();

    // Mutate the returned clone
    item!.status = "completed" as WorkStatus;
    item!.verification = {
      status: "verified",
      verifiedAt: new Date().toISOString(),
      verdict: "PASS",
      concerns: [],
      iscRowsVerified: 0,
      iscRowsTotal: 0,
      verificationCost: 0,
      verifiedBy: "manual" as "skeptical_verifier",
      tiersExecuted: [],
    };

    // Internal state should be unchanged
    const fresh = wq.getItem("a");
    expect(fresh!.status).toBe("in_progress");
    expect(fresh!.verification).toBeUndefined();
  });

  it("getAllItems returns deep clones — mutations do not affect internal state", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", status: "pending" }),
      makeItem({ id: "b", status: "pending" }),
    ]);

    const items = wq.getAllItems();
    items[0].status = "completed" as WorkStatus;
    items[0].dependencies.push("injected");

    const fresh = wq.getItem("a");
    expect(fresh!.status).toBe("pending");
    expect(fresh!.dependencies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// removeDependency
// ---------------------------------------------------------------------------

describe("removeDependency", () => {
  it("removes an existing dependency", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", status: "pending", dependencies: ["b", "c"] }),
      makeItem({ id: "b", status: "completed" }),
      makeItem({ id: "c", status: "completed" }),
    ]);

    wq.removeDependency("a", "b");
    const item = wq.getItem("a");
    expect(item!.dependencies).toEqual(["c"]);
  });

  it("is idempotent for non-existent dependency", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", status: "pending", dependencies: ["b"] }),
      makeItem({ id: "b", status: "completed" }),
    ]);

    wq.removeDependency("a", "nonexistent");
    const item = wq.getItem("a");
    expect(item!.dependencies).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// setMetadata: undefined values are LOUD-BUT-NON-FATAL (root-cause fix,
// workqueue-metadata-clobber-20260730 round 2) — an unguarded optional
// silently flowing into setMetadata used to silently delete the key instead
// of setting it (a real production instance shipped in WorkOrchestrator.retry(),
// fixed alongside this). Deletion is now its own explicit method:
// deleteMetadata(). setMetadata() logs loudly (console.error) and SKIPS the
// offending key rather than throwing — setMetadata is reachable from
// recovery/retry paths (OrphanRecovery's uncaught per-item loop in
// particular) where a throw would abort recovery for every OTHER item in the
// same batch, a worse blast radius than one metadata key not being recorded.
// ---------------------------------------------------------------------------

describe("setMetadata undefined handling", () => {
  it("logs loudly and skips the key when a value is undefined, instead of deleting or throwing", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", metadata: { keepMe: "yes", removeMe: "bye" } }),
    ]);

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      // Does NOT throw — recovery/retry paths must not crash on this.
      expect(() => wq.setMetadata("a", { removeMe: undefined, newKey: "hello" })).not.toThrow();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(/removeMe.*undefined/);
    } finally {
      errorSpy.mockRestore();
    }

    // removeMe was neither set-to-undefined nor deleted (untouched, old value
    // survives); the OTHER defined key in the SAME call (newKey) still landed.
    const item = wq.getItem("a");
    expect(item!.metadata).toEqual({ keepMe: "yes", removeMe: "bye", newKey: "hello" });
  });

  it("sets keys when value is defined", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", metadata: {} }),
    ]);

    wq.setMetadata("a", { newKey: "hello" });
    const item = wq.getItem("a");
    expect(item!.metadata!.newKey).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// deleteMetadata: the explicit counterpart to setMetadata()'s unconditional merge
// ---------------------------------------------------------------------------

describe("WorkQueue.deleteMetadata()", () => {
  it("deletes the given keys, leaves others untouched", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", metadata: { keepMe: "yes", removeMe: "bye" } }),
    ]);

    wq.deleteMetadata("a", ["removeMe"]);
    const item = wq.getItem("a");
    expect(item!.metadata).toEqual({ keepMe: "yes" });
    expect("removeMe" in item!.metadata!).toBe(false);
  });

  it("deletes multiple keys in one call", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", metadata: { a1: 1, a2: 2, a3: 3 } }),
    ]);

    wq.deleteMetadata("a", ["a1", "a3"]);
    const item = wq.getItem("a");
    expect(item!.metadata).toEqual({ a2: 2 });
  });

  it("is a no-op for a non-existent item (no throw)", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a" })]);
    expect(() => wq.deleteMetadata("nope", ["x"])).not.toThrow();
  });

  it("is a no-op for a key that doesn't exist (idempotent)", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", metadata: { keepMe: "yes" } }),
    ]);
    wq.deleteMetadata("a", ["neverExisted"]);
    const item = wq.getItem("a");
    expect(item!.metadata).toEqual({ keepMe: "yes" });
  });
});

// ---------------------------------------------------------------------------
// WorkItemMetadata type (ISC 8320)
//
// ISC rows covered:
//   8320 - WorkItemMetadata includes workSurface? field
//   (workSurfaceMismatch field removed — heuristic deleted in S0 de-determinization)
//
// Merged from the __tests__/WorkQueue.test.ts addendum (S1.9 iteration-2).
// ---------------------------------------------------------------------------

describe("WorkItemMetadata type (ISC 8320)", () => {
  it("accepts workSurface: browser in metadata", () => {
    const meta: WorkItemMetadata = {
      workSurface: "browser",
    };
    expect(meta.workSurface).toBe("browser");
  });

  it("accepts workSurface: cli in metadata", () => {
    const meta: WorkItemMetadata = {
      workSurface: "cli",
    };
    expect(meta.workSurface).toBe("cli");
  });

  it("accepts workSurface: api in metadata", () => {
    const meta: WorkItemMetadata = {
      workSurface: "api",
    };
    expect(meta.workSurface).toBe("api");
  });

  it("accepts workSurface: integration in metadata", () => {
    const meta: WorkItemMetadata = {
      workSurface: "integration",
    };
    expect(meta.workSurface).toBe("integration");
  });

  it("allows workSurface to be absent (optional)", () => {
    const meta: WorkItemMetadata = {};
    expect(meta.workSurface).toBeUndefined();
  });

  it("setMetadata persists workSurface on a WorkItem", () => {
    const item: WorkItem = {
      id: "test-wq-001",
      title: "Test",
      description: "Test item",
      priority: "normal",
      status: "pending",
      dependencies: [],
      source: "manual",
      createdAt: new Date().toISOString(),
    };
    const queue = WorkQueue._createForTesting([item]);

    queue.setMetadata("test-wq-001", {
      workSurface: "browser",
    });

    const updated = queue.getItem("test-wq-001");
    expect(updated?.metadata?.workSurface).toBe("browser");
  });
});

// ---------------------------------------------------------------------------
// retryEligibleAfter cooldown (Solution 3)
// ---------------------------------------------------------------------------

describe("retryEligibleAfter cooldown", () => {
  it("recordAttempt sets ~60s cooldown for attempt 1", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "cd-1", status: "in_progress" }),
    ]);
    const before = Date.now();
    wq.recordAttempt("cd-1", {
      attemptNumber: 1, startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(), error: "fail", strategy: "standard",
    });
    const item = wq.getItem("cd-1");
    expect(item?.retryEligibleAfter).toBeDefined();
    const eligible = new Date(item!.retryEligibleAfter!).getTime();
    // Should be approximately 60s in the future (allow 5s tolerance)
    expect(eligible - before).toBeGreaterThan(55_000);
    expect(eligible - before).toBeLessThan(65_000);
  });

  it("recordAttempt sets ~180s cooldown for attempt 2", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "cd-2", status: "in_progress" }),
    ]);
    const before = Date.now();
    wq.recordAttempt("cd-2", {
      attemptNumber: 2, startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(), error: "fail", strategy: "standard",
    });
    const item = wq.getItem("cd-2");
    const eligible = new Date(item!.retryEligibleAfter!).getTime();
    expect(eligible - before).toBeGreaterThan(175_000);
    expect(eligible - before).toBeLessThan(185_000);
  });

  it("getReadyItems excludes item with future cooldown", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({
        id: "cd-future", status: "pending",
        retryEligibleAfter: new Date(Date.now() + 60_000).toISOString(),
      }),
    ]);
    expect(wq.getReadyItems().find(i => i.id === "cd-future")).toBeUndefined();
  });

  it("getReadyItems includes item with past cooldown", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({
        id: "cd-past", status: "pending",
        retryEligibleAfter: new Date(Date.now() - 1_000).toISOString(),
      }),
    ]);
    expect(wq.getReadyItems().find(i => i.id === "cd-past")).toBeDefined();
  });

  it("getReadyItems includes item with undefined cooldown (backward compat)", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "cd-none", status: "pending" }),
    ]);
    expect(wq.getReadyItems().find(i => i.id === "cd-none")).toBeDefined();
  });

  it("updateStatus('completed') clears retryEligibleAfter", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({
        id: "cd-clear", status: "in_progress",
        retryEligibleAfter: new Date(Date.now() + 60_000).toISOString(),
        verification: { status: "verified", verdict: "PASS", verifiedBy: "skeptical_verifier", tiersExecuted: [1] },
      }),
    ]);
    wq.updateStatus("cd-clear", "completed");
    const item = wq.getItem("cd-clear");
    expect(item?.retryEligibleAfter).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-writer metadata clobber (workqueue-metadata-clobber-20260730)
//
// pipeline_items is a single store shared with QueueRouter (ADR-003). WorkQueue
// caches items in memory between mutations, so its next write can be built from
// a copy loaded BEFORE a concurrent QueueRouter write landed on the SAME row.
// Before this fix, WorkQueue's persistItem()/updateStatus() wrote
// pipeline_items.metadata wholesale from that stale copy, silently dropping
// whatever QueueRouter had just written.
//
// Assertions read the RAW row via repo.get(), not wq.getItem() — WorkQueue's
// own codec (pipelineItemToWorkItem) always prefers metadata.rawWorkItem for
// full-fidelity round-tripping, so wq.getItem() would look "correct" from
// WorkQueue's own point of view regardless of whether the top-level DB
// metadata column was merged or replaced. The bug (and the fix) live in that
// top-level column, which is what a second writer on the same row actually
// sees.
// ---------------------------------------------------------------------------

function makeQueueItemFixture(overrides: Partial<QueueItem> & { id: string }): QueueItem {
  const now = new Date().toISOString();
  return {
    created: now,
    updated: now,
    source: "test",
    priority: 2,
    status: "pending",
    type: "task",
    queue: "approved-work",
    payload: { title: `Queue item ${overrides.id}`, description: "" },
    ...overrides,
  };
}

describe("WorkQueue / QueueRouter shared-store metadata clobber (cross-writer)", () => {
  // Each test gets its own dbPath under TEST_BASE so the PipelineRepository
  // singleton cache (keyed by resolved dbPath — see getPipelineRepository)
  // can't bleed state between tests in this file's shared bun process.
  function makeSharedStore(name: string) {
    const dir = join(TEST_BASE, name);
    mkdirSync(dir, { recursive: true });
    const statePath = join(dir, "wq.json");
    const dbPath = join(dir, ".kaya", "runtime", "pipeline.db");
    // Construct WorkQueue FIRST so its constructor initializes the
    // getPipelineRepository singleton for this dbPath; the repo handle below
    // then resolves to that SAME cached instance — exactly how production
    // shares one PipelineRepository connection per db path between WorkQueue
    // and QueueRouter.
    const wq = new WorkQueue(statePath);
    const repo = getPipelineRepository(dbPath);
    return { wq, repo };
  }

  it("persistItem() (setEffort) preserves a metadata key QueueRouter wrote after WorkQueue's in-memory copy was loaded", () => {
    const { wq, repo } = makeSharedStore("clobber-persist");
    const item = wq.addItem({ title: "t", description: "", priority: "normal", dependencies: [], source: "manual" });
    expect(item.id).toStartWith("w-");

    // Simulate QueueRouter's real write shape on the SAME row (real codec +
    // its already-fixed mergeMetadata:true call shape).
    repo.upsert(
      queueItemToPipelineParams(makeQueueItemFixture({
        id: item.id, queue: "approved-work", status: "pending",
        project: { name: "acme-corp", path: "/tmp/acme" },
      })),
      { mergeMetadata: true, actor: "QueueRouter-sim" }
    );
    expect(repo.get(item.id)?.metadata.projectName).toBe("acme-corp"); // sanity: QueueRouter's write landed

    // WorkQueue mutates a field unrelated to metadata, from its stale
    // in-memory copy (loaded at addItem() time, before the write above).
    wq.setEffort(item.id, "STANDARD");

    const row = repo.get(item.id);
    expect(row?.metadata.projectName).toBe("acme-corp"); // survived WorkQueue's write
    // WorkQueue's own write also landed correctly.
    const rawWorkItem = row?.metadata.rawWorkItem as WorkItem | undefined;
    expect(rawWorkItem?.effort).toBe("STANDARD");
  });

  it("transition() (updateStatus) preserves a metadata key QueueRouter wrote after WorkQueue's in-memory copy was loaded", () => {
    const { wq, repo } = makeSharedStore("clobber-transition");
    const item = wq.addItem({ title: "t", description: "", priority: "normal", dependencies: [], source: "manual" });

    repo.upsert(
      queueItemToPipelineParams(makeQueueItemFixture({
        id: item.id, queue: "approved-work", status: "pending",
        project: { name: "acme-corp", path: "/tmp/acme" },
      })),
      { mergeMetadata: true, actor: "QueueRouter-sim" }
    );

    wq.updateStatus(item.id, "in_progress");

    const row = repo.get(item.id);
    expect(row?.stage).toBe("in-progress"); // WorkQueue's own transition landed
    expect(row?.metadata.projectName).toBe("acme-corp"); // survived WorkQueue's write
  });

  it("setMetadata (no deletion in this call) preserves a metadata key QueueRouter wrote after WorkQueue's in-memory copy was loaded", () => {
    const { wq, repo } = makeSharedStore("clobber-setmetadata");
    const item = wq.addItem({ title: "t", description: "", priority: "normal", dependencies: [], source: "manual" });

    repo.upsert(
      queueItemToPipelineParams(makeQueueItemFixture({
        id: item.id, queue: "approved-work", status: "pending",
        project: { name: "acme-corp", path: "/tmp/acme" },
      })),
      { mergeMetadata: true, actor: "QueueRouter-sim" }
    );

    wq.setMetadata(item.id, { workSurface: "cli" });

    const row = repo.get(item.id);
    expect(row?.metadata.projectName).toBe("acme-corp"); // survived
    expect(wq.getItem(item.id)?.metadata?.workSurface).toBe("cli"); // and the new key landed
  });

  it("setMetadata logs loudly and skips (not deletes, not throws) an undefined value — round-2 root-cause fix — AND still preserves concurrent QueueRouter metadata", () => {
    const { wq, repo } = makeSharedStore("clobber-setmetadata-loud-skip");
    const item = wq.addItem({
      title: "t", description: "", priority: "normal", dependencies: [], source: "manual",
      metadata: { removeMe: "bye", keepMe: "yes" },
    });

    repo.upsert(
      queueItemToPipelineParams(makeQueueItemFixture({
        id: item.id, queue: "approved-work", status: "pending",
        project: { name: "acme-corp", path: "/tmp/acme" },
      })),
      { mergeMetadata: true, actor: "QueueRouter-sim" }
    );

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      // An accidentally-undefined value (the exact WorkOrchestrator.retry() shape)
      // no longer throws — a recovery-path caller must not crash on this — and no
      // longer forces the wholesale-replace that used to re-expose the cross-writer
      // clobber (round 1). Both bugs closed by the same design choice.
      expect(() => wq.setMetadata(item.id, { removeMe: undefined, newKey: "hello" })).not.toThrow();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }

    const row = repo.get(item.id);
    expect(row?.metadata.projectName).toBe("acme-corp"); // survived — no forced wholesale-replace
    expect(row?.metadata.removeMe).toBe("bye"); // untouched, not deleted
    expect(wq.getItem(item.id)?.metadata?.newKey).toBe("hello"); // the other key still landed
  });

  it("deleteMetadata() still deletes the key from the raw row (mergeMetadata correctly off for that call)", () => {
    const { wq, repo } = makeSharedStore("clobber-deletemetadata");
    const item = wq.addItem({
      title: "t", description: "", priority: "normal", dependencies: [], source: "manual",
      metadata: { removeMe: "bye", keepMe: "yes" },
    });

    wq.deleteMetadata(item.id, ["removeMe"]);

    // Raw row, not wq.getItem() — see the describe-block note above on why
    // wq.getItem() can't distinguish merge-on from merge-off here.
    const row = repo.get(item.id);
    expect("removeMe" in (row?.metadata ?? {})).toBe(false);
    expect(row?.metadata.keepMe).toBe("yes");
    expect(wq.getItem(item.id)?.metadata?.removeMe).toBeUndefined();
  });

  it("resumeBlocked still deletes humanTaskRef/escalationReason/escalatedAt from the raw row (mergeMetadata correctly off for that call)", () => {
    const { wq, repo } = makeSharedStore("clobber-resumeblocked-delete");
    const item = wq.addItem({
      title: "t", description: "", priority: "normal", dependencies: [], source: "manual",
      status: "blocked",
      metadata: { humanTaskRef: "manual-a", escalationReason: "needs prereq", escalatedAt: "2026-06-14" },
    });

    wq.resumeBlocked(item.id, "Prereqs satisfied");

    const row = repo.get(item.id);
    // NOTE on diagnosticity (mutation-checked): "humanTaskRef" is NOT a clean
    // probe for the mergeMetadata carve-out — workItemToPipelineParams() also
    // emits a top-level `humanTaskRef: item.humanTaskRef` key (the WorkItem's
    // OWN field, unrelated to this metadata-bag entry) on every write, which
    // always overwrites-to-undefined in a merge too. Mutation-checked by
    // forcing updateStatus's mergeMetadata default to true: this assertion
    // still passed (false positive), while escalationReason/escalatedAt below
    // — which have no such top-level-field collision — correctly failed
    // ("acme-corp"-style resurrection). Kept for behavioral coverage, not
    // relied on as proof.
    expect("humanTaskRef" in (row?.metadata ?? {})).toBe(false);
    // Diagnostic: no top-level-field collision, actually exercises the carve-out.
    expect("escalationReason" in (row?.metadata ?? {})).toBe(false);
    expect("escalatedAt" in (row?.metadata ?? {})).toBe(false);
    expect(wq.getItem(item.id)?.metadata?.humanTaskRef).toBeUndefined();
    expect(row?.stage).toBe("approved"); // resumeBlocked's own transition (blocked -> pending) landed
  });
});
