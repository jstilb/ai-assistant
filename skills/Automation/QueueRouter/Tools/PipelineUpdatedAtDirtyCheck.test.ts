#!/usr/bin/env bun
/**
 * PipelineUpdatedAtDirtyCheck.test.ts — Regression test for the whole-queue
 * updated_at restamp bug (fable-remediation b1/b2).
 *
 * Root cause (PipelineRepository.ts upsert()): upsert() used to unconditionally
 * bind `updated_at = now` on the ON CONFLICT(id) DO UPDATE path, even when every
 * persisted column resolved to the exact same value already on disk.
 * saveQueueItemsImpl() (PipelineFacade.ts) calls upsert() in a loop over the
 * WHOLE active-queue array on every save — so QueueManager.complete() on ONE
 * item silently restamped updated_at on every OTHER unrelated row in the same
 * queue. Observed production impact: this reset PipelineIntegrity's
 * STUCK-item staleness clock for an item genuinely stuck for 420h, clearing a
 * real alarm (PipelineIntegrity STUCK(1) -> STUCK(0) with nothing actually
 * resolved). It also matches the "2026-06-29 bulk sweep touched updated_at on
 * every row" fingerprint already documented in BacklogTriage.ts (:137, :445).
 *
 * This test exercises PipelineRepository.upsert() directly (the fixed seam)
 * in the exact shape saveQueueItemsImpl produces: one item genuinely
 * transitions, two sibling items are re-upserted with content that resolves
 * to byte-identical values already on disk — which is what happens to every
 * OTHER item in the array on every whole-queue save, whether or not it
 * actually changed.
 *
 * All tests pin KAYA_HOME to a fresh mkdtemp directory so they NEVER touch
 * the live ~/.kaya/runtime/pipeline.db.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { join } from "path";
import { mkdirSync } from "fs";
import { pinKayaHome, restoreKayaHome } from "../../../../lib/test/pinKayaHome.ts";

// ============================================================================
// KAYA_HOME isolation — set BEFORE any import that reads the env
// ============================================================================

const TEST_BASE = pinKayaHome("pipeline-updated-at-dirty-check-test-");

// Now safe to import repository code
import {
  PipelineRepository,
  resetPipelineRepository,
  generatePipelineId,
  type PipelineItem,
  type Stage,
} from "./PipelineRepository.ts";
import { resetPipelineDb } from "./PipelineDB.ts";
import {
  saveQueueItemsImpl,
  getRepoForQueuesDir,
  pipelineItemToQueueItem,
} from "./PipelineFacade.ts";
import type { QueueItem } from "./QueueManager.ts";

// ============================================================================
// Helpers
// ============================================================================

function makeItem(overrides: Partial<PipelineItem> & { id?: string } = {}): Partial<PipelineItem> & { id: string } {
  return {
    id: generatePipelineId(),
    title: "Test Item",
    description: "A test pipeline item",
    stage: "intake" as Stage,
    priority: 2,
    dependencies: [],
    metadata: {},
    context: {},
    attempts: [],
    progress: {},
    isc_rows: [],
    ...overrides,
  };
}

interface EventRow {
  id: number;
  item_id: string;
  from_stage: string | null;
  to_stage: string;
  actor: string;
  note: string | null;
  ts: string;
}

// ============================================================================
// Lifecycle
// ============================================================================

afterAll(async () => {
  resetPipelineRepository();
  await restoreKayaHome();
});

// ============================================================================
// Whole-queue-resave shape
// ============================================================================

describe("upsert() updated_at dirty-check — whole-queue-resave shape", () => {
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "updated-at-dirty-check.db");
  const repo = new PipelineRepository(dbPath);
  afterAll(() => resetPipelineDb(dbPath));

  test("one item's genuine transition does not move a sibling item's updated_at, even when the sibling is re-upserted with identical (but differently key-ordered) content", async () => {
    // Simulate a queue of 3 items — this mirrors saveQueueItemsImpl's loop shape.
    const itemA = repo.upsert(makeItem({ stage: "intake", title: "Item A" }));
    const itemB = repo.upsert(makeItem({ stage: "intake", title: "Item B", metadata: { z: 1, a: 2 } }));
    const itemC = repo.upsert(makeItem({ stage: "intake", title: "Item C" }));

    const rawDb = (repo as unknown as { db: import("bun:sqlite").Database }).db;
    const eventCount = (id: string) =>
      (rawDb.prepare("SELECT * FROM pipeline_events WHERE item_id = ?").all(id) as EventRow[]).length;
    expect(eventCount(itemA.id)).toBe(1); // creation event only
    expect(eventCount(itemB.id)).toBe(1);
    expect(eventCount(itemC.id)).toBe(1);

    // Wall-clock gap so `now` at the next upsert() call is guaranteed to differ
    // from the creation timestamp (ISO strings are millisecond-resolution) —
    // without this, assertion (a) below (A's updated_at DID move) could pass
    // by coincidence even with the bug present, if both calls land in the
    // same millisecond.
    await Bun.sleep(10);

    // The whole-queue resave: A genuinely transitions (intake -> researching,
    // legal). B is re-upserted with its metadata keys in a DIFFERENT order
    // than originally stored ({a,z} vs the original {z,a}) — same content,
    // different serialization — to prove the dirty-check compares decoded
    // values, not raw JSON strings. C is a bare re-save (stage omitted
    // entirely, defaults to existing). This is exactly what
    // saveQueueItemsImpl does for every item in the array on every save,
    // whether or not that item actually changed.
    const updatedA = repo.upsert({ id: itemA.id, stage: "researching" });
    const resavedB = repo.upsert({
      id: itemB.id,
      stage: "intake",
      title: "Item B",
      metadata: { a: 2, z: 1 }, // same content, different key order
    });
    const resavedC = repo.upsert({ id: itemC.id }); // bare re-save, stage omitted entirely

    // (a) POSITIVE: the transitioned item's updated_at DID move.
    expect(updatedA.updated_at).not.toBe(itemA.updated_at);
    expect(new Date(updatedA.updated_at).getTime()).toBeGreaterThan(new Date(itemA.updated_at).getTime());

    // (b) NEGATIVE: every OTHER row's updated_at is byte-identical before and after.
    expect(resavedB.updated_at).toBe(itemB.updated_at);
    expect(resavedC.updated_at).toBe(itemC.updated_at);

    // Re-read straight from the DB too (not just upsert()'s returned value) to
    // rule out a stale in-memory object masking a real DB-level restamp.
    const rereadB = repo.get(itemB.id);
    const rereadC = repo.get(itemC.id);
    expect(rereadB?.updated_at).toBe(itemB.updated_at);
    expect(rereadC?.updated_at).toBe(itemC.updated_at);
    // And metadata round-trips correctly regardless of the key-order change.
    expect(rereadB?.metadata).toEqual({ a: 2, z: 1 });

    // (c) No spurious pipeline_events rows for the untouched items.
    expect(eventCount(itemB.id)).toBe(1);
    expect(eventCount(itemC.id)).toBe(1);

    // Sanity check: A DID get a new event (legal stage-crossing) — confirms
    // the test actually exercised a real change on A, not a no-op there too.
    const aEvents = rawDb
      .prepare("SELECT * FROM pipeline_events WHERE item_id = ? AND from_stage IS NOT NULL")
      .all(itemA.id) as EventRow[];
    expect(aEvents.length).toBe(1);
    expect(aEvents[0].to_stage).toBe("researching");
  });

  test("created_at is unaffected by the dirty-check (still preserved verbatim across every re-save)", async () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    await Bun.sleep(10);
    const resaved = repo.upsert({ id: item.id }); // no-op re-save
    expect(resaved.created_at).toBe(item.created_at);

    await Bun.sleep(10);
    const crossed = repo.upsert({ id: item.id, stage: "researching" }); // genuine change
    expect(crossed.created_at).toBe(item.created_at);
  });
});

// ============================================================================
// End-to-end: saveQueueItemsImpl (the REAL lossy-codec path) — mergeMetadata wiring
// ============================================================================

/**
 * The dirty-check above (PipelineRepository.upsert()) is necessary but not
 * sufficient: saveQueueItemsImpl's codec (queueItemToPipelineParams) has no
 * source of truth for foreign metadata keys another producer (e.g. WorkQueue)
 * wrote — without `mergeMetadata: true` at the two call sites in
 * PipelineFacade.ts, it wholesale-REPLACES metadata on every whole-queue
 * resave, which independently defeats the dirty-check: replaced-then-put-back
 * content is still a "change" from the dirty-check's point of view, so
 * updated_at would move anyway even with the check in place. This suite
 * drives the real saveQueueItemsImpl() entry point (not upsert() directly) to
 * prove both halves are fixed together, for a data-rich row that is NOT the
 * one being changed in the save call.
 */
describe("saveQueueItemsImpl — mergeMetadata wiring preserves foreign metadata + attempts/isc_rows/dependencies on untouched siblings", () => {
  const TEST_QUEUES_DIR = join(TEST_BASE, "MEMORY", "QUEUES");
  const TEST_ARCHIVE_DIR = join(TEST_QUEUES_DIR, "archive");
  mkdirSync(TEST_ARCHIVE_DIR, { recursive: true });
  // Cleanup: the file-level afterAll (resetPipelineRepository() + restoreKayaHome())
  // already tears down the canonical singleton this describe block resolves into
  // (getRepoForQueuesDir/saveQueueItemsImpl always resolve defaultPipelineDbPath(),
  // which is keyed off the same pinned KAYA_HOME as every other block in this file).

  test("a whole-queue resave preserves a sibling's foreign metadata/attempts/isc_rows/dependencies AND its updated_at, while the genuinely-changed item still updates+restamps", async () => {
    const repo = getRepoForQueuesDir(TEST_QUEUES_DIR);
    const now = new Date().toISOString();

    const richId = "b1b2-rich-" + generatePipelineId();
    const changingId = "b1b2-changing-" + generatePipelineId();

    const richQueueItem: QueueItem = {
      id: richId,
      created: now,
      updated: now,
      source: "manual",
      priority: 2,
      status: "pending",
      type: "dev",
      queue: "approved-work",
      payload: { title: "Rich Item", description: "data-rich row, not the one changing" },
    };
    const changingQueueItemInitial: QueueItem = {
      id: changingId,
      created: now,
      updated: now,
      source: "manual",
      priority: 2,
      status: "pending",
      type: "dev",
      queue: "approved-work",
      payload: { title: "Changing Item", description: "will genuinely change" },
    };

    // Step A: initial whole-queue save through the REAL lossy-codec path —
    // mirrors production (QueueManager.add() etc.).
    saveQueueItemsImpl(
      "approved-work",
      [richQueueItem, changingQueueItemInitial],
      TEST_QUEUES_DIR,
      TEST_ARCHIVE_DIR,
    );

    // Step B: simulate a DIFFERENT producer (e.g. WorkQueue, via its own
    // workItemToPipelineParams codec) subsequently writing attempts/isc_rows/
    // dependencies + foreign metadata keys onto richId's row — the exact shape
    // destroyed in production (95% of metadata, 3 attempt records, ISC rows,
    // dependencies on one live row).
    const foreignMetadata = {
      rawWorkItem: { id: richId, title: "Rich Item", status: "in_progress" },
      comprehendedSpec: { summary: "spec summary", requirements: ["r1", "r2"] },
      workSurface: { files: ["src/a.ts", "src/b.ts"] },
      verificationHistory: [
        { at: "2026-07-20T00:00:00.000Z", verdict: "fail", note: "attempt 1" },
        { at: "2026-07-25T00:00:00.000Z", verdict: "pass", note: "attempt 2" },
      ],
    };
    const attempts = [
      { n: 1, outcome: "fail" },
      { n: 2, outcome: "fail" },
      { n: 3, outcome: "pass" },
    ];
    const iscRows = [
      { id: "isc-1", completed: true },
      { id: "isc-2", completed: false },
    ];
    const dependencies = ["dep-x", "dep-y"];

    repo.upsert(
      { id: richId, metadata: foreignMetadata, attempts, isc_rows: iscRows, dependencies },
      { mergeMetadata: true },
    );

    const richBefore = repo.get(richId);
    const changingBefore = repo.get(changingId);
    if (!richBefore || !changingBefore) throw new Error("setup failed: rows not found after enrichment");

    // Wall-clock gap so `now` at the real save differs from the enrichment
    // timestamp (ISO strings are millisecond-resolution) — without this,
    // assertion (c) below could pass by coincidence even with the bug present.
    await Bun.sleep(10);

    // Step C: reload the whole queue exactly as a real caller does (e.g.
    // QueueManager.complete() loads the array, mutates ONE item, saves the
    // WHOLE array back) — richId comes back completely unmodified.
    const reloaded = repo.list({ queue: "approved-work" });
    const richReloaded = pipelineItemToQueueItem(reloaded.find(r => r.id === richId) ?? null);
    const changingReloaded = pipelineItemToQueueItem(reloaded.find(r => r.id === changingId) ?? null);
    if (!richReloaded || !changingReloaded) throw new Error("setup failed: reload");

    // The one genuine change: changingId transitions pending -> completed.
    const changingModified: QueueItem = {
      ...changingReloaded,
      status: "completed",
      result: { completedAt: new Date().toISOString(), output: "done" },
    };

    // ==== THE REAL CALL UNDER TEST ====
    saveQueueItemsImpl(
      "approved-work",
      [richReloaded, changingModified],
      TEST_QUEUES_DIR,
      TEST_ARCHIVE_DIR,
    );

    const richAfter = repo.get(richId);
    const changingAfter = repo.get(changingId);
    if (!richAfter || !changingAfter) throw new Error("post-save fetch failed");

    // (a) Foreign metadata keys survive verbatim; the codec's own rawQueueItem
    // key is still present/freshly written by the merge (not dropped, not
    // frozen — it reflects the reloaded item on every call).
    expect(richAfter.metadata?.rawWorkItem).toEqual(foreignMetadata.rawWorkItem);
    expect(richAfter.metadata?.comprehendedSpec).toEqual(foreignMetadata.comprehendedSpec);
    expect(richAfter.metadata?.workSurface).toEqual(foreignMetadata.workSurface);
    expect(richAfter.metadata?.verificationHistory).toEqual(foreignMetadata.verificationHistory);
    expect(richAfter.metadata?.rawQueueItem).toEqual(richReloaded);

    // (b) attempts / isc_rows / dependencies byte-identical before and after
    // the real save call.
    expect(richAfter.attempts).toEqual(attempts);
    expect(richAfter.isc_rows).toEqual(iscRows);
    expect(richAfter.dependencies).toEqual(dependencies);

    // (c) THE end-to-end proof: richId's updated_at did NOT move across the
    // real saveQueueItemsImpl() call — the row resolved to byte-identical
    // persisted content, so the dirty-check kept its old updated_at. This is
    // the exact scenario that silently reset a real 420-hour stuck-alarm in
    // production.
    expect(richAfter.updated_at).toBe(richBefore.updated_at);

    // (d) The item that genuinely changed still gets its update AND its restamp.
    expect(changingAfter.stage).toBe("done");
    expect(changingAfter.stage).not.toBe(changingBefore.stage);
    expect(changingAfter.updated_at).not.toBe(changingBefore.updated_at);
    expect(new Date(changingAfter.updated_at).getTime())
      .toBeGreaterThan(new Date(changingBefore.updated_at).getTime());
  });
});

// ============================================================================
// End-to-end: PipelineRepository.transition() — mergeMetadata wiring
// ============================================================================

/**
 * The saveQueueItemsImpl suite above proves mergeMetadata through upsert(),
 * where the row is NOT changing and updated_at must NOT move. transition() is
 * the opposite shape: it is ALWAYS a genuine stage change (it enforces
 * ALLOWED_TRANSITIONS and throws on an illegal crossing), so updated_at
 * SHOULD move on every call — transition() has no dirty-check at all, by
 * design (see its docstring: unconditional `updated_at = now`). What was
 * missing before this fix was metadata preservation on that genuine change:
 * QueueManager.approve()/reject()/transfer()/updateSpecPipelineStatus() all
 * build their `patch` from queueItemToPipelineParams (the same fixed-partial-
 * key-set codec) and feed it into repo.transition() (or repo.upsert() for
 * approve's same-stage branch and transfer()), which previously had no way to
 * preserve a metadata key the codec doesn't know about — so a foreign
 * producer's metadata was wiped on every approve/reject/transfer, exactly
 * like the whole-queue-resave case, just via a different low-level write
 * path. This suite drives PipelineRepository.transition() directly (the
 * fixed seam QueueManager's 4 call sites all route through) with a
 * codec-shaped patch and mergeMetadata: true.
 */
describe("PipelineRepository.transition() — mergeMetadata preserves foreign metadata across a genuine stage change", () => {
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "transition-merge-metadata.db");
  const repo = new PipelineRepository(dbPath);
  afterAll(() => resetPipelineDb(dbPath));

  test("a genuine transition() stage change preserves foreign metadata keys while the codec's own keys update, AND updated_at moves (no over-applied dirty-check)", async () => {
    const id = generatePipelineId();

    // Seed: codec-owned metadata (as an earlier queueItemToPipelineParams-driven
    // write would have produced) PLUS foreign metadata keys a different producer
    // (e.g. WorkQueue) subsequently wrote onto the same row.
    const seeded = repo.upsert({
      id,
      stage: "intake",
      title: "Transition merge test item",
      metadata: {
        rawQueueItem: { id, payload: { title: "Transition merge test item" } },
        projectName: "original-project",
        rawWorkItem: { id, title: "Transition merge test item", status: "in_progress" },
        comprehendedSpec: { summary: "spec summary", requirements: ["r1", "r2"] },
        workSurface: { files: ["src/a.ts", "src/b.ts"] },
        verificationHistory: [{ at: "2026-07-20T00:00:00.000Z", verdict: "fail" }],
      },
    });

    await Bun.sleep(10);

    // The real call under test: a genuine stage change (intake -> researching,
    // legal per ALLOWED_TRANSITIONS) with a codec-shaped patch — same call
    // signature QueueManager.approve()/reject()/updateSpecPipelineStatus() use.
    const freshCodecMetadata = {
      rawQueueItem: { id, payload: { title: "Transition merge test item (updated)" } },
      projectName: "renamed-project",
    };
    const updated = repo.transition(id, "researching", {
      patch: { metadata: freshCodecMetadata },
      actor: "test",
      mergeMetadata: true,
    });

    // Foreign metadata keys survive verbatim — not part of the codec's fixed key
    // set, so mergeMetadata must preserve them rather than the patch wiping them.
    expect(updated.metadata?.rawWorkItem).toEqual(seeded.metadata?.rawWorkItem);
    expect(updated.metadata?.comprehendedSpec).toEqual(seeded.metadata?.comprehendedSpec);
    expect(updated.metadata?.workSurface).toEqual(seeded.metadata?.workSurface);
    expect(updated.metadata?.verificationHistory).toEqual(seeded.metadata?.verificationHistory);

    // The codec's own keys DID update to the fresh patch values — merge doesn't
    // freeze them, it shallow-merges with the patch's keys winning.
    expect(updated.metadata?.rawQueueItem).toEqual(freshCodecMetadata.rawQueueItem);
    expect(updated.metadata?.projectName).toBe("renamed-project");

    // Re-read straight from the DB too, ruling out a stale in-memory object.
    const reread = repo.get(id);
    expect(reread?.metadata).toEqual(updated.metadata);

    // The stage genuinely changed.
    expect(updated.stage).toBe("researching");

    // Difference from the upsert/dirty-check case: this IS a genuine change, so
    // updated_at SHOULD move — proving we didn't over-apply the dirty-check to
    // transition(), which has (and should have) none.
    expect(updated.updated_at).not.toBe(seeded.updated_at);
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(new Date(seeded.updated_at).getTime());
  });
});
