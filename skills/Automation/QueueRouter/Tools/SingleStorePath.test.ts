#!/usr/bin/env bun
/**
 * SingleStorePath.test.ts — Guard test: getRepoForQueuesDir always returns
 * the canonical singleton regardless of queuesDir argument.
 *
 * Regression guard for the two-database split bug (S1.5): in prod with
 * KAYA_HOME unset, pipelineDbPathFromQueuesDir derived a path under
 * ~/.claude/.kaya (stale) while defaultPipelineDbPath() resolved to
 * ~/.kaya (canonical). This caused /queue and /work to read different dbs.
 *
 * Hermetic: sets KAYA_HOME to a mkdtemp dir BEFORE any imports so no live
 * db is touched. Pattern mirrors PipelineDB.test.ts:27-29,78-81.
 */

// ============================================================================
// KAYA_HOME isolation — set BEFORE any import that reads the env
// ============================================================================

import { join } from "path";
import { existsSync, readdirSync, mkdirSync } from "fs";
import { pinKayaHome, restoreKayaHome } from "../../../../lib/test/pinKayaHome.ts";

const TEST_BASE = pinKayaHome("single-store-test-");

// Now safe to import pipeline code (all KAYA_HOME reads are at call time)
import { describe, test, expect, afterAll } from "bun:test";
import * as Facade from "./PipelineFacade.ts";
import {
  getRepoForQueuesDir,
  queueItemToPipelineParams,
  saveQueueItemsImpl,
  appendQueueItemImpl,
  loadQueueItemsImpl,
} from "./PipelineFacade.ts";
import {
  getPipelineRepository,
  resetPipelineRepository,
  generatePipelineId,
} from "./PipelineRepository.ts";
import { loadQueueItems } from "./QueueManager.ts";

// ============================================================================
// Helpers
// ============================================================================

/** Recursively find all files named pipeline.db under a directory tree */
function findAllPipelineDbs(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findAllPipelineDbs(fullPath));
    } else if (entry.name === "pipeline.db") {
      results.push(fullPath);
    }
  }
  return results;
}

// An arbitrary queuesDir inside TEST_BASE whose structure does NOT align with
// the KAYA_HOME derivation used by defaultPipelineDbPath():
//   ARBITRARY_QUEUES_DIR = TEST_BASE/arbitrary/MEMORY/QUEUES
//   pipelineDbPathFromQueuesDir (old code) derives:
//     dirname(dirname(...)) = TEST_BASE/arbitrary
//     → TEST_BASE/arbitrary/.kaya/runtime/pipeline.db   ← DIFFERENT from canonical
//   defaultPipelineDbPath() with KAYA_HOME=TEST_BASE:
//     → TEST_BASE/.kaya/runtime/pipeline.db             ← canonical
const ARBITRARY_QUEUES_DIR = join(TEST_BASE, "arbitrary", "MEMORY", "QUEUES");

// ============================================================================
// Lifecycle
// ============================================================================

afterAll(async () => {
  // Reset canonical singleton
  resetPipelineRepository();
  // Also reset the arbitrary-path singleton if it was created (no-op in GREEN)
  const arbitraryDbPath = join(TEST_BASE, "arbitrary", ".kaya", "runtime", "pipeline.db");
  try { resetPipelineRepository(arbitraryDbPath); } catch { /* not created post-fix */ }
  await restoreKayaHome();
});

// ============================================================================
// Tests
// ============================================================================

describe("SingleStorePath — getRepoForQueuesDir always resolves canonical db", () => {

  test("Case 1: instance identity — any queuesDir arg returns the canonical singleton", () => {
    const canonical = getPipelineRepository();

    // Arbitrary path that does NOT align with KAYA_HOME structure (the prod-bug scenario)
    const repoForArbitrary = getRepoForQueuesDir(ARBITRARY_QUEUES_DIR);
    expect(repoForArbitrary).toBe(canonical);

    // getQueuesDir-equivalent: aligned with KAYA_HOME — must ALSO return same singleton
    const repoForAligned = getRepoForQueuesDir(join(TEST_BASE, "MEMORY", "QUEUES"));
    expect(repoForAligned).toBe(canonical);

    // No-arg call
    const repoNoArg = getRepoForQueuesDir();
    expect(repoNoArg).toBe(canonical);
  });

  test("Case 2: no second db materializes — upsert + loadQueueItems round-trips via one db", () => {
    const canonical = getPipelineRepository();
    const itemId = generatePipelineId();
    const testQueue = "ssp-test-queue";
    const now = new Date().toISOString();

    // Upsert via canonical repo using the codec (mirrors production write path)
    canonical.upsert(queueItemToPipelineParams({
      id: itemId,
      queue: testQueue,
      status: "pending",
      created: now,
      updated: now,
      source: "SingleStorePath.test",
      priority: 2,
      type: "task",
      payload: { title: "single-store guard item", description: "S1.5 guard" },
    }));

    // Read back via loadQueueItems (calls getRepoForQueuesDir internally)
    const items = loadQueueItems(testQueue);
    const found = items.find(i => i.id === itemId);
    expect(found).toBeDefined();
    expect(found?.payload?.title).toBe("single-store guard item");

    // Assert exactly ONE pipeline.db exists under TEST_BASE
    const allDbs = findAllPipelineDbs(TEST_BASE);
    expect(allDbs).toHaveLength(1);
    expect(allDbs[0]).toContain(TEST_BASE);
  });

  test("Case 3: pipelineDbPathFromQueuesDir is deleted (no longer exported)", () => {
    // Compile-level check: the function must not appear in the module exports
    expect((Facade as Record<string, unknown>)["pipelineDbPathFromQueuesDir"]).toBeUndefined();
  });

  test("Case 4: round-trip via pipeline.db creates NO .jsonl files (S7 guard)", () => {
    // Use a dedicated queuesDir inside TEST_BASE so we can assert no .jsonl appear there.
    const queuesDir = join(TEST_BASE, "s7-no-jsonl-queues");
    const archiveDir = join(TEST_BASE, "s7-no-jsonl-archive");
    mkdirSync(queuesDir, { recursive: true });
    const testQueue = "s7-round-trip-queue";
    const now = new Date().toISOString();

    const itemA = {
      id: generatePipelineId(),
      queue: testQueue,
      status: "pending" as const,
      created: now,
      updated: now,
      source: "s7-test",
      priority: 2 as const,
      type: "task" as const,
      payload: { title: "S7 item A", description: "round-trip guard" },
    };
    const itemB = {
      id: generatePipelineId(),
      queue: testQueue,
      status: "pending" as const,
      created: now,
      updated: now,
      source: "s7-test",
      priority: 2 as const,
      type: "task" as const,
      payload: { title: "S7 item B", description: "append guard" },
    };

    // save + append via facade (post-S7: no shadow writes)
    saveQueueItemsImpl(testQueue, [itemA], queuesDir, archiveDir);
    appendQueueItemImpl(testQueue, itemB, queuesDir);

    // load from pipeline.db and verify both items are present
    const loaded = loadQueueItemsImpl(testQueue, queuesDir);
    const loadedIds = loaded.map(i => i.id);
    expect(loadedIds).toContain(itemA.id);
    expect(loadedIds).toContain(itemB.id);

    // CRITICAL ASSERTION: no .jsonl files created in queuesDir
    const jsonlFiles = readdirSync(queuesDir).filter(f => f.endsWith(".jsonl"));
    expect(jsonlFiles).toHaveLength(0);

    // loadQueueItemsFromJsonl is removed (compile-level: it must not be exported)
    expect((Facade as Record<string, unknown>)["loadQueueItemsFromJsonl"]).toBeUndefined();
  });

});
