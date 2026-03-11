/**
 * WorkQueue.test.ts — Tests for unified work queue + DAG
 *
 * Covers: cycle detection, getReadyItems with dependency filtering,
 * status transitions, getParallelBatch safety, legacy JSONL import.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { WorkQueue, type WorkItem, type WorkStatus } from "./WorkQueue.ts";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";

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
// Legacy JSONL import
// ---------------------------------------------------------------------------

describe("WorkQueue.loadFromLegacy()", () => {
  const TMP_DIR = join(import.meta.dir, "__test_tmp__");
  const TMP_JSONL = join(TMP_DIR, "legacy.jsonl");
  const TMP_STATE = join(TMP_DIR, "wq.json");

  beforeEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });

  it("imports pending items from JSONL", () => {
    const lines = [
      JSON.stringify({ id: "item1", status: "pending", priority: 2, payload: { title: "Test", description: "desc" } }),
      JSON.stringify({ id: "item2", status: "pending", priority: 1, payload: { title: "Urgent", description: "" } }),
    ];
    writeFileSync(TMP_JSONL, lines.join("\n"));

    const wq = new WorkQueue(TMP_STATE);
    const result = wq.loadFromLegacy(TMP_JSONL);
    expect(result.imported).toBe(2);

    const items = wq.getAllItems();
    expect(items.length).toBe(2);
    expect(items.find(i => i.id === "item1")?.title).toBe("Test");
    expect(items.find(i => i.id === "item2")?.priority).toBe("high");
  });

  it("skips completed items", () => {
    const lines = [
      JSON.stringify({ id: "done1", status: "completed", priority: 2, payload: { title: "Done", description: "" } }),
      JSON.stringify({ id: "pend1", status: "pending", priority: 2, payload: { title: "Pend", description: "" } }),
    ];
    writeFileSync(TMP_JSONL, lines.join("\n"));

    const wq = new WorkQueue(TMP_STATE);
    const result = wq.loadFromLegacy(TMP_JSONL);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(wq.getAllItems()[0].id).toBe("pend1");
  });

  it("resets orphaned in_progress to pending", () => {
    const lines = [
      JSON.stringify({ id: "orphan", status: "in_progress", priority: 2, payload: { title: "Orphan", description: "" } }),
    ];
    writeFileSync(TMP_JSONL, lines.join("\n"));

    const wq = new WorkQueue(TMP_STATE);
    wq.loadFromLegacy(TMP_JSONL);
    expect(wq.getItem("orphan")?.status).toBe("pending");
  });

  it("does not duplicate on second import", () => {
    const lines = [
      JSON.stringify({ id: "dup1", status: "pending", priority: 2, payload: { title: "A", description: "" } }),
    ];
    writeFileSync(TMP_JSONL, lines.join("\n"));

    const wq = new WorkQueue(TMP_STATE);
    wq.loadFromLegacy(TMP_JSONL);
    wq.loadFromLegacy(TMP_JSONL); // second call
    expect(wq.getAllItems().length).toBe(1);
  });

  it("preserves spec and project paths", () => {
    const lines = [
      JSON.stringify({
        id: "spec1",
        status: "pending",
        priority: 2,
        payload: { title: "With Spec", description: "" },
        spec: { id: "spec1-spec", path: "/some/spec.md", status: "approved", approvedAt: "2026-01-01" },
        project: { name: "kaya", path: "/Users/test/.claude" },
      }),
    ];
    writeFileSync(TMP_JSONL, lines.join("\n"));

    const wq = new WorkQueue(TMP_STATE);
    wq.loadFromLegacy(TMP_JSONL);
    const item = wq.getItem("spec1");
    expect(item?.specPath).toBe("/some/spec.md");
    expect(item?.projectPath).toBe("/Users/test/.claude");
  });

  it("returns zero for missing file", () => {
    const wq = new WorkQueue(TMP_STATE);
    const result = wq.loadFromLegacy("/nonexistent.jsonl");
    expect(result.imported).toBe(0);
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
// wirePhaseDependencies()
// ---------------------------------------------------------------------------

describe("WorkQueue.wirePhaseDependencies()", () => {
  it("wires Phase 2 → Phase 1 within same family", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "p1", title: "LucidTasks Phase 1: Core features" }),
      makeItem({ id: "p2", title: "LucidTasks Phase 2: Database schema" }),
    ]);
    const wired = wq.wirePhaseDependencies();
    expect(wired).toBe(1);
    expect(wq.getItem("p2")!.dependencies).toContain("p1");
    expect(wq.getItem("p1")!.dependencies).toEqual([]);
  });

  it("wires full chain Phase 0→1→2→3", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "p0", title: "MySkill Phase 0: Setup" }),
      makeItem({ id: "p1", title: "MySkill Phase 1: Core" }),
      makeItem({ id: "p2", title: "MySkill Phase 2: Advanced" }),
      makeItem({ id: "p3", title: "MySkill Phase 3: Polish" }),
    ]);
    const wired = wq.wirePhaseDependencies();
    expect(wired).toBe(3);
    expect(wq.getItem("p1")!.dependencies).toContain("p0");
    expect(wq.getItem("p2")!.dependencies).toContain("p1");
    expect(wq.getItem("p3")!.dependencies).toContain("p2");
  });

  it("does NOT wire across different families", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "lt1", title: "LucidTasks Phase 1: Core" }),
      makeItem({ id: "lt2", title: "LucidTasks Phase 2: Schema" }),
      makeItem({ id: "vm1", title: "VoiceMigration Phase 1: Setup" }),
      makeItem({ id: "vm2", title: "VoiceMigration Phase 2: Impl" }),
    ]);
    wq.wirePhaseDependencies();
    // LucidTasks Phase 2 depends on LucidTasks Phase 1 only
    expect(wq.getItem("lt2")!.dependencies).toEqual(["lt1"]);
    // VoiceMigration Phase 2 depends on VoiceMigration Phase 1 only
    expect(wq.getItem("vm2")!.dependencies).toEqual(["vm1"]);
  });

  it("skips non-phased items", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "a", title: "Fix authentication bug" }),
      makeItem({ id: "b", title: "Update README" }),
      makeItem({ id: "p1", title: "LucidTasks Phase 1: Core" }),
    ]);
    const wired = wq.wirePhaseDependencies();
    expect(wired).toBe(0);
    expect(wq.getItem("a")!.dependencies).toEqual([]);
    expect(wq.getItem("b")!.dependencies).toEqual([]);
  });

  it("is idempotent (second call = 0 new deps)", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "p1", title: "LucidTasks Phase 1: Core" }),
      makeItem({ id: "p2", title: "LucidTasks Phase 2: Schema" }),
    ]);
    expect(wq.wirePhaseDependencies()).toBe(1);
    expect(wq.wirePhaseDependencies()).toBe(0);
  });

  it("preserves existing manual dependencies", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "p1", title: "LucidTasks Phase 1: Core" }),
      makeItem({ id: "p2", title: "LucidTasks Phase 2: Schema", dependencies: ["manual-dep"] }),
    ]);
    wq.wirePhaseDependencies();
    expect(wq.getItem("p2")!.dependencies).toContain("manual-dep");
    expect(wq.getItem("p2")!.dependencies).toContain("p1");
  });

  it("single-member family = no wiring", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "p1", title: "LucidTasks Phase 1: Core" }),
    ]);
    expect(wq.wirePhaseDependencies()).toBe(0);
  });

  it("handles out-of-order insertion", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "p3", title: "MySkill Phase 3: Polish" }),
      makeItem({ id: "p1", title: "MySkill Phase 1: Core" }),
      makeItem({ id: "p2", title: "MySkill Phase 2: Advanced" }),
    ]);
    wq.wirePhaseDependencies();
    expect(wq.getItem("p2")!.dependencies).toContain("p1");
    expect(wq.getItem("p3")!.dependencies).toContain("p2");
    expect(wq.getItem("p1")!.dependencies).toEqual([]);
  });

  it("after wiring, getReadyItems() only returns Phase 1s", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "p1", title: "LucidTasks Phase 1: Core" }),
      makeItem({ id: "p2", title: "LucidTasks Phase 2: Schema" }),
      makeItem({ id: "p3", title: "LucidTasks Phase 3: Tests" }),
      makeItem({ id: "p4", title: "LucidTasks Phase 4: Docs" }),
    ]);
    wq.wirePhaseDependencies();
    const ready = wq.getReadyItems();
    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe("p1");
  });
});

// ---------------------------------------------------------------------------
// Phase-aware sort in getReadyItems()
// ---------------------------------------------------------------------------

describe("WorkQueue.getReadyItems() phase-aware sort", () => {
  it("ties broken by phase number ascending", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "p3", title: "SkillA Phase 3: Polish", priority: "normal" }),
      makeItem({ id: "p1", title: "SkillA Phase 1: Core", priority: "normal" }),
      makeItem({ id: "p2", title: "SkillA Phase 2: Advanced", priority: "normal" }),
    ]);
    // No wiring — all are ready, but sort should prefer lower phase
    const ready = wq.getReadyItems();
    expect(ready.map(i => i.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("non-phased items sort after phased items at same priority", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({ id: "np", title: "Fix bug", priority: "normal" }),
      makeItem({ id: "p1", title: "SkillA Phase 1: Core", priority: "normal" }),
    ]);
    const ready = wq.getReadyItems();
    expect(ready[0].id).toBe("p1");
    expect(ready[1].id).toBe("np");
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
  it("throws on verifiedBy: 'manual'", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a" })]);
    expect(() => wq.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "manual", tiersExecuted: [],
    })).toThrow('verifiedBy "manual" is not "skeptical_verifier"');
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
  it("throws when completing non-TRIVIAL item with verifiedBy !== 'skeptical_verifier'", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", effort: "STANDARD", status: "in_progress" })]);
    // Bypass setVerification guard by setting directly on item (simulates corrupted state)
    const item = wq.getItem("a")!;
    item.verification = {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "manual", tiersExecuted: [],
    };
    expect(() => wq.updateStatus("a", "completed")).toThrow("Non-TRIVIAL items require pipeline verification");
  });

  it("allows TRIVIAL items with verifiedBy: 'manual' to complete", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", effort: "TRIVIAL", status: "in_progress" })]);
    const item = wq.getItem("a")!;
    item.verification = {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "manual", tiersExecuted: [],
    };
    const updated = wq.updateStatus("a", "completed");
    expect(updated?.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Verification sanitization on load (defense-in-depth)
// ---------------------------------------------------------------------------

describe("verification sanitization on loadState", () => {
  const SANITIZE_DIR = join(import.meta.dir, "__test-sanitize__");
  const SANITIZE_PATH = join(SANITIZE_DIR, "work-queue.json");

  it("strips unknown fields like manualVerification from loaded state", () => {
    if (existsSync(SANITIZE_DIR)) rmSync(SANITIZE_DIR, { recursive: true });
    mkdirSync(SANITIZE_DIR, { recursive: true });

    const badState = {
      items: [{
        id: "test-1",
        title: "Test Item",
        description: "desc",
        status: "in_progress",
        priority: "normal",
        dependencies: [],
        source: "manual",
        createdAt: new Date().toISOString(),
        verification: {
          status: "verified",
          verifiedAt: new Date().toISOString(),
          verdict: "PASS",
          concerns: [],
          iscRowsVerified: 1,
          iscRowsTotal: 1,
          verificationCost: 0,
          verifiedBy: "skeptical_verifier",
          tiersExecuted: [1],
          manualVerification: true,
          extraInjectedField: "should be stripped",
        },
      }],
      lastUpdated: new Date().toISOString(),
      totalProcessed: 0,
      totalFailed: 0,
    };
    writeFileSync(SANITIZE_PATH, JSON.stringify(badState));

    const wq = new WorkQueue(SANITIZE_PATH);
    const item = wq.getItem("test-1");
    expect(item).not.toBeNull();
    expect(item!.verification).not.toBeNull();
    expect(item!.verification!.status).toBe("verified");
    expect(item!.verification!.verifiedBy).toBe("skeptical_verifier");
    // Injected fields should be stripped
    expect((item!.verification as Record<string, unknown>)["manualVerification"]).toBeUndefined();
    expect((item!.verification as Record<string, unknown>)["extraInjectedField"]).toBeUndefined();

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

  it("rejects blocked -> pending", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "a", status: "blocked" })]);
    expect(() => wq.updateStatus("a", "pending")).toThrow("Illegal transition");
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
