#!/usr/bin/env bun
/**
 * PipelineReaderAPI.test.ts — Tests for the pipeline_events reader API (slice A6)
 *
 * Adds two read-only methods to PipelineRepository:
 *   - getEvents(itemId): all events for an item, ordered by id ASC
 *   - getRecentEvents(since | opts.sinceId, opts?): events newer than a checkpoint,
 *     ordered by id ASC, optionally filtered by toStage. Designed to drive an
 *     edge-triggered notification poller (slice D2) that checkpoints on event id.
 *
 * All tests pin KAYA_HOME to a fresh mkdtemp directory so they NEVER touch
 * the live ~/.kaya/runtime/pipeline.db.
 *
 * Test groups:
 *   1. getEvents(itemId) — ordering, shape, scoping to the given item
 *   2. getRecentEvents(since) — ts-based paging (exclusive lower bound)
 *   3. getRecentEvents(opts.sinceId) — id-based paging (exclusive lower bound)
 *   4. getRecentEvents(..., { toStage }) — stage filter
 *   5. getRecentEvents input validation — must provide since or sinceId
 *   6. Read-only: neither method mutates pipeline_items or pipeline_events
 */

import { describe, test, expect, afterAll } from "bun:test";
import { join } from "path";
import { pinKayaHome, restoreKayaHome } from "../../../../lib/test/pinKayaHome.ts";

// ============================================================================
// KAYA_HOME isolation — set BEFORE any import that reads the env
// ============================================================================

const TEST_BASE = pinKayaHome("pipeline-reader-api-test-");

// Now safe to import repository code
import {
  PipelineRepository,
  resetPipelineRepository,
  generatePipelineId,
  type PipelineItem,
  type PipelineEvent,
  type Stage,
} from "./PipelineRepository.ts";
import { resetPipelineDb } from "./PipelineDB.ts";

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

// ============================================================================
// Lifecycle
// ============================================================================

afterAll(async () => {
  resetPipelineRepository();
  await restoreKayaHome();
});

// ============================================================================
// 1. getEvents(itemId)
// ============================================================================

describe("1. getEvents(itemId)", () => {
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "reader-get-events.db");
  const repo = new PipelineRepository(dbPath);
  afterAll(() => resetPipelineDb(dbPath));

  test("returns empty array for an item with no events", () => {
    expect(repo.getEvents("no-such-item")).toEqual([]);
  });

  test("returns all events for an item, ordered by id ASC", () => {
    const item = repo.upsert(makeItem({ stage: "intake" })); // creation event
    repo.transition(item.id, "researching", { actor: "worker-a", note: "step 1" });
    repo.transition(item.id, "generating-spec", { actor: "worker-b", note: "step 2" });

    const events = repo.getEvents(item.id);
    expect(events.length).toBe(3);

    // strictly ascending ids
    for (let i = 1; i < events.length; i++) {
      expect(events[i].id).toBeGreaterThan(events[i - 1].id);
    }

    expect(events[0].from_stage).toBeNull();
    expect(events[0].to_stage).toBe("intake");
    expect(events[0].note).toBe("creation");

    expect(events[1].from_stage).toBe("intake");
    expect(events[1].to_stage).toBe("researching");
    expect(events[1].actor).toBe("worker-a");
    expect(events[1].note).toBe("step 1");

    expect(events[2].from_stage).toBe("researching");
    expect(events[2].to_stage).toBe("generating-spec");
    expect(events[2].actor).toBe("worker-b");
    expect(events[2].note).toBe("step 2");
  });

  test("event shape includes id, item_id, from_stage, to_stage, actor, note, ts", () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    const [event] = repo.getEvents(item.id);
    expect(typeof event.id).toBe("number");
    expect(event.item_id).toBe(item.id);
    expect(event.from_stage).toBeNull();
    expect(typeof event.to_stage).toBe("string");
    expect(typeof event.actor).toBe("string");
    expect(event.note === null || typeof event.note === "string").toBe(true);
    expect(typeof event.ts).toBe("string");
  });

  test("only returns events scoped to the given item id", () => {
    const a = repo.upsert(makeItem({ stage: "intake" }));
    const b = repo.upsert(makeItem({ stage: "intake" }));
    repo.transition(a.id, "researching");
    repo.transition(b.id, "researching");
    repo.transition(b.id, "generating-spec");

    const eventsA = repo.getEvents(a.id);
    const eventsB = repo.getEvents(b.id);
    expect(eventsA.every((e) => e.item_id === a.id)).toBe(true);
    expect(eventsB.every((e) => e.item_id === b.id)).toBe(true);
    expect(eventsA.length).toBe(2); // creation + 1 transition
    expect(eventsB.length).toBe(3); // creation + 2 transitions
  });
});

// ============================================================================
// 2. getRecentEvents(since) — ts-based paging
// ============================================================================

describe("2. getRecentEvents(since) — ts-based paging", () => {
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "reader-recent-ts.db");
  const repo = new PipelineRepository(dbPath);
  afterAll(() => resetPipelineDb(dbPath));

  test("returns only events with ts strictly greater than `since`", () => {
    const a = repo.upsert(makeItem({ stage: "intake" }));
    const checkpoint = new Date().toISOString();
    // Force the clock past the checkpoint's millisecond — ts has ms resolution
    // and this test asserts on ts ordering specifically (id-based paging, tested
    // separately below, doesn't need this because ids are gap-free regardless
    // of clock resolution — exactly the tradeoff documented on getRecentEvents).
    Bun.sleepSync(5);
    const b = repo.upsert(makeItem({ stage: "intake" }));
    repo.transition(b.id, "researching");

    const events = repo.getRecentEvents(checkpoint);
    const ids = events.map((e) => e.item_id);
    expect(ids).not.toContain(a.id);
    expect(ids.filter((id) => id === b.id).length).toBeGreaterThanOrEqual(1);
  });

  test("results are ordered by id ASC", () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    const checkpoint = "1970-01-01T00:00:00.000Z"; // everything is "recent"
    repo.transition(item.id, "researching");
    repo.transition(item.id, "generating-spec");

    const events = repo.getRecentEvents(checkpoint);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].id).toBeGreaterThan(events[i - 1].id);
    }
  });

  test("empty result when since is after all events", () => {
    repo.upsert(makeItem({ stage: "intake" }));
    const farFuture = "2999-01-01T00:00:00.000Z";
    expect(repo.getRecentEvents(farFuture)).toEqual([]);
  });
});

// ============================================================================
// 3. getRecentEvents(opts.sinceId) — id-based paging
// ============================================================================

describe("3. getRecentEvents(opts.sinceId) — id-based paging", () => {
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "reader-recent-id.db");
  const repo = new PipelineRepository(dbPath);
  afterAll(() => resetPipelineDb(dbPath));

  test("returns only events with id strictly greater than sinceId", () => {
    const a = repo.upsert(makeItem({ stage: "intake" })); // event 1
    const b = repo.upsert(makeItem({ stage: "intake" })); // event 2
    const checkpointId = repo.getEvents(a.id)[0].id;

    repo.transition(b.id, "researching"); // event 3

    const events = repo.getRecentEvents(undefined, { sinceId: checkpointId });
    expect(events.every((e) => e.id > checkpointId)).toBe(true);
    const ids = events.map((e) => e.item_id);
    expect(ids).not.toContain(a.id);
    expect(ids).toContain(b.id);
  });

  test("sinceId=0 returns every event (checkpoint-from-scratch case for a fresh poller)", () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    repo.transition(item.id, "researching");

    const events = repo.getRecentEvents(undefined, { sinceId: 0 });
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  test("supports checkpoint-then-drain poller loop pattern", () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    let checkpoint = 0;

    const batch1 = repo.getRecentEvents(undefined, { sinceId: checkpoint });
    expect(batch1.length).toBeGreaterThanOrEqual(1);
    checkpoint = batch1[batch1.length - 1].id;

    // Nothing new yet
    expect(repo.getRecentEvents(undefined, { sinceId: checkpoint })).toEqual([]);

    repo.transition(item.id, "researching");
    const batch2 = repo.getRecentEvents(undefined, { sinceId: checkpoint });
    expect(batch2.length).toBe(1);
    expect(batch2[0].to_stage).toBe("researching");
  });
});

// ============================================================================
// 4. getRecentEvents(..., { toStage })
// ============================================================================

describe("4. getRecentEvents(..., { toStage }) — stage filter", () => {
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "reader-recent-tostage.db");
  const repo = new PipelineRepository(dbPath);
  afterAll(() => resetPipelineDb(dbPath));

  test("filters to only events transitioning INTO the given stage", () => {
    const a = repo.upsert(makeItem({ stage: "intake" }));
    const b = repo.upsert(makeItem({ stage: "intake" }));
    repo.transition(a.id, "researching");
    repo.transition(b.id, "needs-grilling");

    const events = repo.getRecentEvents(undefined, { sinceId: 0, toStage: "researching" });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.to_stage === "researching")).toBe(true);
    expect(events.some((e) => e.item_id === a.id)).toBe(true);
    expect(events.some((e) => e.item_id === b.id)).toBe(false);
  });

  test("combines with sinceId paging", () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    const afterCreate = repo.getEvents(item.id)[0].id;
    repo.transition(item.id, "researching");
    repo.transition(item.id, "generating-spec");

    const events = repo.getRecentEvents(undefined, { sinceId: afterCreate, toStage: "researching" });
    expect(events.length).toBe(1);
    expect(events[0].to_stage).toBe("researching");
  });
});

// ============================================================================
// 5. getRecentEvents input validation
// ============================================================================

describe("5. getRecentEvents input validation", () => {
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "reader-recent-validation.db");
  const repo = new PipelineRepository(dbPath);
  afterAll(() => resetPipelineDb(dbPath));

  test("throws when neither `since` nor `opts.sinceId` is provided", () => {
    expect(() => repo.getRecentEvents(undefined)).toThrow(/since|sinceId/);
    expect(() => repo.getRecentEvents(null as unknown as string)).toThrow(/since|sinceId/);
  });

  test("sinceId takes precedence when both since and sinceId are provided", () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    const creationId = repo.getEvents(item.id)[0].id;
    repo.transition(item.id, "researching");

    // A `since` far in the past (would include everything) combined with a
    // sinceId that excludes the creation event — sinceId must win.
    const events = repo.getRecentEvents("1970-01-01T00:00:00.000Z", { sinceId: creationId });
    expect(events.every((e) => e.id > creationId)).toBe(true);
  });
});

// ============================================================================
// 6. Read-only guarantee
// ============================================================================

describe("6. Read-only guarantee", () => {
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "reader-readonly.db");
  const repo = new PipelineRepository(dbPath);
  afterAll(() => resetPipelineDb(dbPath));

  test("getEvents and getRecentEvents do not change pipeline_items or pipeline_events row counts", () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    repo.transition(item.id, "researching");

    const rawDb = (repo as unknown as { db: import("bun:sqlite").Database }).db;
    const itemsBefore = (rawDb.prepare("SELECT COUNT(*) AS c FROM pipeline_items").get() as { c: number }).c;
    const eventsBefore = (rawDb.prepare("SELECT COUNT(*) AS c FROM pipeline_events").get() as { c: number }).c;

    repo.getEvents(item.id);
    repo.getRecentEvents(undefined, { sinceId: 0 });
    repo.getRecentEvents("1970-01-01T00:00:00.000Z");

    const itemsAfter = (rawDb.prepare("SELECT COUNT(*) AS c FROM pipeline_items").get() as { c: number }).c;
    const eventsAfter = (rawDb.prepare("SELECT COUNT(*) AS c FROM pipeline_events").get() as { c: number }).c;

    expect(itemsAfter).toBe(itemsBefore);
    expect(eventsAfter).toBe(eventsBefore);
  });
});

// ============================================================================
// 7. appendCrossRefEvent — Lane A spine visibility (slice F2)
// ============================================================================

describe("7. appendCrossRefEvent — Lane A spine visibility (slice F2)", () => {
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "reader-crossref.db");
  const repo = new PipelineRepository(dbPath);
  afterAll(() => resetPipelineDb(dbPath));

  test("inserts a pipeline_events row for an itemId with NO pipeline_items row", () => {
    const event = repo.appendCrossRefEvent({
      itemId: "t-lane-a-abc123",
      toStage: "lane-a-started",
      actor: "executor:t-lane-a-abc123",
    });

    expect(event.item_id).toBe("t-lane-a-abc123");
    expect(event.to_stage).toBe("lane-a-started");
    expect(event.actor).toBe("executor:t-lane-a-abc123");
    expect(event.from_stage).toBeNull();
    expect(event.note).toBeNull();
    expect(typeof event.id).toBe("number");
    expect(typeof event.ts).toBe("string");

    // No pipeline_items row was created as a side effect
    expect(repo.get("t-lane-a-abc123")).toBeNull();
  });

  test("readable via getEvents(itemId) with no corresponding pipeline_items row", () => {
    repo.appendCrossRefEvent({
      itemId: "t-lane-a-events1",
      toStage: "lane-a-started",
      actor: "executor:t-lane-a-events1",
      note: "Build the thing",
    });
    repo.appendCrossRefEvent({
      itemId: "t-lane-a-events1",
      toStage: "lane-a-verified",
      actor: "executor:t-lane-a-events1",
      note: "pass",
    });

    const events = repo.getEvents("t-lane-a-events1");
    expect(events.length).toBe(2);
    expect(events[0].to_stage).toBe("lane-a-started");
    expect(events[0].note).toBe("Build the thing");
    expect(events[1].to_stage).toBe("lane-a-verified");
    expect(events[1].note).toBe("pass");
  });

  test("readable via getRecentEvents(sinceId) alongside real pipeline_items transitions", () => {
    const before = repo.getRecentEvents(undefined, { sinceId: 0 });
    const checkpoint = before.length > 0 ? before[before.length - 1].id : 0;

    repo.appendCrossRefEvent({
      itemId: "t-lane-a-recent1",
      toStage: "lane-a-merged",
      actor: "executor:t-lane-a-recent1",
      note: "abc1234",
    });

    const after = repo.getRecentEvents(undefined, { sinceId: checkpoint });
    const crossRef = after.find((e) => e.item_id === "t-lane-a-recent1");
    expect(crossRef).toBeDefined();
    expect(crossRef?.to_stage).toBe("lane-a-merged");
    expect(crossRef?.note).toBe("abc1234");
  });

  test("respects an explicit fromStage when provided", () => {
    const event = repo.appendCrossRefEvent({
      itemId: "t-lane-a-fromstage",
      toStage: "lane-a-merged",
      fromStage: "lane-a-verified",
      actor: "executor:t-lane-a-fromstage",
    });
    expect(event.from_stage).toBe("lane-a-verified");
  });

  test("does not create or touch any pipeline_items row (orphan by design)", () => {
    const rawDb = (repo as unknown as { db: import("bun:sqlite").Database }).db;
    const itemsBefore = (rawDb.prepare("SELECT COUNT(*) AS c FROM pipeline_items").get() as { c: number }).c;

    repo.appendCrossRefEvent({
      itemId: "t-lane-a-noitem",
      toStage: "lane-a-started",
      actor: "executor:t-lane-a-noitem",
    });

    const itemsAfter = (rawDb.prepare("SELECT COUNT(*) AS c FROM pipeline_items").get() as { c: number }).c;
    expect(itemsAfter).toBe(itemsBefore);
  });
});
