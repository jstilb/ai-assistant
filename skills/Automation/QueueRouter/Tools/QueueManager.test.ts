import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { pinKayaHome, restoreKayaHome } from "../../../../lib/test/pinKayaHome.ts";
import {
  generateId,
  loadQueueItems,
  saveQueueItems,
  appendQueueItem,
  archiveItems,
  releaseLucidTaskBacklinks,
  getQueueFilePath,
  type QueueItem,
  type QueueItemStatus,
} from "./QueueManager.ts";
import {
  ALLOWED_TRANSITIONS,
  getPipelineRepository,
  resetPipelineRepository,
} from "./PipelineRepository.ts";

// ============================================================================
// Helpers
// ============================================================================

// Redirect KAYA_HOME to a temp directory so tests never write to the live
// MEMORY/QUEUES/ directory. Must be set BEFORE the dynamic import below.
const TEST_DIR = pinKayaHome("qm-test-");
mkdirSync(join(TEST_DIR, "MEMORY/QUEUES"), { recursive: true });
const UNIQUE_SUFFIX = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    created: now,
    updated: now,
    source: "test",
    priority: 2,
    status: "pending",
    type: "task",
    queue: "default",
    payload: { title: "Test Task", description: "A test task" },
    ...overrides,
  };
}

/** Return a unique test queue name to avoid cross-test JSONL state contamination. */
function testQueue(label: string): string {
  return `_test-${UNIQUE_SUFFIX}-${label}`;
}

/** Collect all test queue paths created during a test for cleanup. */
const createdQueueFiles: string[] = [];

// ============================================================================
// generateId
// ============================================================================

describe("generateId", () => {
  test("1. generates a non-empty string", () => {
    const id = generateId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(id).toStartWith("q-");
  });

  test("2. generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

// ============================================================================
// Canonical spec-pipeline transition coverage (S2: replaces validateSpecPipelineTransition tests)
// All spec-pipeline statuses map to canonical Stages; transitions are verified
// directly against PipelineRepository.ALLOWED_TRANSITIONS.
// ============================================================================

describe("canonical spec-pipeline transitions", () => {
  // awaiting-context → intake in canonical Stage
  test("3. intake → researching allowed in canonical (awaiting-context → researching)", () => {
    expect(ALLOWED_TRANSITIONS["intake"]).toContain("researching");
  });

  test("4. researching → generating-spec allowed in canonical", () => {
    expect(ALLOWED_TRANSITIONS["researching"]).toContain("generating-spec");
  });

  test("5. generating-spec → revision-needed allowed in canonical", () => {
    expect(ALLOWED_TRANSITIONS["generating-spec"]).toContain("revision-needed");
  });

  test("6. intake → generating-spec is NOT in canonical (awaiting-context → generating-spec illegal)", () => {
    // awaiting-context maps to intake; intake does not allow directly jumping to generating-spec
    expect(ALLOWED_TRANSITIONS["intake"]).not.toContain("generating-spec");
  });

  test("7. escalated is terminal in canonical — no auto-transitions to researching/generating-spec", () => {
    const exits = ALLOWED_TRANSITIONS["escalated"];
    expect(exits).not.toContain("researching");
    expect(exits).not.toContain("generating-spec");
  });

  test("8. intake → in-progress allowed in canonical (execution claim path)", () => {
    // Standard execution claim path: intake → in-progress
    expect(ALLOWED_TRANSITIONS["intake"]).toContain("in-progress");
  });

  test("9. revision-needed can go to researching or escalated in canonical", () => {
    expect(ALLOWED_TRANSITIONS["revision-needed"]).toContain("researching");
    expect(ALLOWED_TRANSITIONS["revision-needed"]).toContain("escalated");
  });

  test("10. all spec-pipeline stages are present in canonical transition map", () => {
    const stages = [
      "intake",           // awaiting-context → intake
      "researching",
      "generating-spec",
      "revision-needed",
      "escalated",
      "needs-grilling",
    ] as const;
    for (const stage of stages) {
      expect(ALLOWED_TRANSITIONS[stage]).toBeDefined();
    }
  });
});

// ============================================================================
// JSONL persistence: loadQueueItems / saveQueueItems / appendQueueItem
//
// KAYA_HOME is set to a temp directory above. All queue file I/O goes to
// TEST_DIR/MEMORY/QUEUES/ — never the live directory.
// ============================================================================

describe("JSONL persistence", () => {
  afterEach(() => {
    // Clean up any JSONL files created during tests
    for (const filePath of createdQueueFiles.splice(0)) {
      try { if (existsSync(filePath)) rmSync(filePath); } catch {}
    }
  });

  test("11. loadQueueItems returns empty array for missing file", () => {
    const items = loadQueueItems(`_nonexistent-${Date.now()}`);
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(0);
  });

  test("12. saveQueueItems and loadQueueItems round-trip single item", () => {
    const q = testQueue("single");
    const item = makeItem({ queue: q });
    saveQueueItems(q, [item]);
    createdQueueFiles.push(getQueueFilePath(q));
    const loaded = loadQueueItems(q);
    expect(loaded.length).toBe(1);
    expect(loaded[0].id).toBe(item.id);
    expect(loaded[0].payload.title).toBe("Test Task");
  });

  test("13. saveQueueItems and loadQueueItems round-trip multiple items", () => {
    const q = testQueue("multi");
    const items = [
      makeItem({ queue: q, payload: { title: "Alpha", description: "a" } }),
      makeItem({ queue: q, payload: { title: "Beta", description: "b" } }),
      makeItem({ queue: q, payload: { title: "Gamma", description: "c" } }),
    ];
    saveQueueItems(q, items);
    createdQueueFiles.push(getQueueFilePath(q));
    const loaded = loadQueueItems(q);
    expect(loaded.length).toBe(3);
    const titles = loaded.map(i => i.payload.title);
    expect(titles).toContain("Alpha");
    expect(titles).toContain("Beta");
    expect(titles).toContain("Gamma");
  });

  test("14. appendQueueItem adds item to existing queue", () => {
    const q = testQueue("append");
    const first = makeItem({ queue: q });
    saveQueueItems(q, [first]);
    createdQueueFiles.push(getQueueFilePath(q));
    const second = makeItem({ queue: q, payload: { title: "Appended", description: "appended" } });
    appendQueueItem(q, second);
    const loaded = loadQueueItems(q);
    expect(loaded.length).toBe(2);
    expect(loaded[1].payload.title).toBe("Appended");
  });

  test("15. appendQueueItem creates queue file if it does not exist", () => {
    const q = testQueue("fresh");
    const item = makeItem({ queue: q });
    appendQueueItem(q, item);
    createdQueueFiles.push(getQueueFilePath(q));
    const loaded = loadQueueItems(q);
    expect(loaded.length).toBe(1);
    expect(loaded[0].id).toBe(item.id);
  });

  test("16. saveQueueItems overwrites prior content", () => {
    const q = testQueue("overwrite");
    const original = [makeItem({ queue: q })];
    saveQueueItems(q, original);
    createdQueueFiles.push(getQueueFilePath(q));

    const replacement = [
      makeItem({ queue: q, payload: { title: "New1", description: "n1" } }),
      makeItem({ queue: q, payload: { title: "New2", description: "n2" } }),
    ];
    saveQueueItems(q, replacement);
    const loaded = loadQueueItems(q);
    expect(loaded.length).toBe(2);
    expect(loaded.map(i => i.payload.title)).not.toContain("Test Task");
  });
});

// ============================================================================
// archiveItems
// ============================================================================

describe("archiveItems", () => {
  afterEach(() => {
    for (const filePath of createdQueueFiles.splice(0)) {
      try { if (existsSync(filePath)) rmSync(filePath); } catch {}
    }
  });

  test("17. archiveItems appends provided items to an archive JSONL file", () => {
    const q = testQueue("archiveitems");
    const completed = makeItem({ queue: q, status: "completed" });
    const completed2 = makeItem({ queue: q, status: "completed" });

    archiveItems(q, [completed, completed2]);

    // Derive the archive path using getQueueFilePath logic (same base dir, "archive" subdir)
    const baseFile = getQueueFilePath(q);
    const baseDir = baseFile.replace(/\/[^/]+\.jsonl$/, "");
    const archivePath = join(baseDir, "archive", `${q}-archive.jsonl`);
    createdQueueFiles.push(archivePath);

    expect(existsSync(archivePath)).toBe(true);
  });

  test("18. archiveItems with empty array is a no-op", () => {
    const q = testQueue("archive-empty");
    // Should not throw
    expect(() => archiveItems(q, [])).not.toThrow();
  });
});

// ============================================================================
// saveState atomic tmp-then-rename (ISC row 1)
// ============================================================================

describe("saveState atomic write", () => {
  const qm = new (require("./QueueManager").QueueManager as typeof import("./QueueManager").QueueManager)();

  test("19. state.json is valid JSON after multiple concurrent add() calls", async () => {
    // Run 5 concurrent add operations — each eventually calls saveState()
    const q = testQueue("concurrent-state");
    const adds = Array.from({ length: 5 }, (_, i) =>
      qm.add({ title: `Concurrent task ${i}`, description: `desc ${i}` }, { queue: q })
    );
    await Promise.allSettled(adds);

    // state.json must still be valid JSON (no partial write)
    const stateFile = join(TEST_DIR, "MEMORY", "QUEUES", "state.json");
    if (existsSync(stateFile)) {
      const content = require("fs").readFileSync(stateFile, "utf-8");
      expect(() => JSON.parse(content)).not.toThrow();
    }
  });

  test("20. no .tmp file left behind after saveState()", async () => {
    await qm.add({ title: "Cleanup check task", description: "test" }, { queue: testQueue("tmp-check") });

    const queuesDir = join(TEST_DIR, "MEMORY", "QUEUES");
    const files = require("fs").readdirSync(queuesDir);
    const tmpFiles = files.filter((f: string) => f.includes(".tmp."));
    expect(tmpFiles.length).toBe(0);
  });
});

// ============================================================================
// cleanup archival policy (terminal-status allowlist + back-link release)
// ============================================================================

describe("cleanup archival policy", () => {
  const qm = new (require("./QueueManager").QueueManager as typeof import("./QueueManager").QueueManager)();
  const OLD = new Date(Date.now() - 90 * 86400_000).toISOString();

  test("21. cleanup never archives live working statuses, regardless of age", async () => {
    const q = testQueue("cleanup-live");
    const liveStatuses: QueueItemStatus[] = [
      "needs-grilling", "awaiting-context", "researching", "generating-spec",
      "revision-needed", "escalated", "pending", "in_progress", "awaiting_approval", "approved",
    ];
    const live = liveStatuses.map((status) =>
      makeItem({ status, created: OLD, updated: OLD, queue: q })
    );
    saveQueueItems(q, live);

    await qm.cleanup(30, { releaseBacklinks: async () => 0 });

    const after = loadQueueItems(q);
    expect(after.length).toBe(live.length);
  });

  test("22. cleanup archives old terminal items and passes them to back-link release", async () => {
    const q = testQueue("cleanup-terminal");
    const terminalStatuses: QueueItemStatus[] = ["completed", "failed", "rejected"];
    const swept = terminalStatuses.map((status) =>
      makeItem({
        status,
        created: OLD,
        updated: OLD,
        queue: q,
        payload: { title: `t-${status}`, description: "d", context: { lucidTaskId: `lt-${status}` } },
      })
    );
    const fresh = makeItem({ status: "completed", queue: q });
    saveQueueItems(q, [...swept, fresh]);

    const releasedItems: QueueItem[] = [];
    await qm.cleanup(30, {
      releaseBacklinks: async (items) => {
        releasedItems.push(...items.filter((i) => i.queue === q));
        return items.length;
      },
    });

    const after = loadQueueItems(q);
    expect(after.map((i) => i.id)).toEqual([fresh.id]);
    expect(releasedItems.map((i) => i.payload.context?.lucidTaskId).sort()).toEqual([
      "lt-completed", "lt-failed", "lt-rejected",
    ]);
  });

  test("23. releaseLucidTaskBacklinks is a safe no-op when tasks don't exist", async () => {
    const item = makeItem({
      status: "failed",
      payload: { title: "x", description: "y", context: { lucidTaskId: "lt-missing" } },
    });
    const cleared = await releaseLucidTaskBacklinks([item]);
    expect(cleared).toBe(0);
  });
});

// ============================================================================
// ArchiveManager.restoreArchivedItem (status preservation)
// ============================================================================

describe("restoreArchivedItem", () => {
  test("24. restore preserves the archived status instead of forcing pending", async () => {
    const { restoreArchivedItem } = await import("./ArchiveManager.ts");
    const q = testQueue("restore-status");
    const item = makeItem({ status: "needs-grilling", queue: q });
    // S4: discoverQueues reads pipeline.db — seed a sentinel item so the queue is discoverable
    const sentinel = makeItem({ id: generateId(), status: "pending", queue: q });
    appendQueueItem(q, sentinel);
    archiveItems(q, [item]);

    const restored = await restoreArchivedItem(item.id);

    expect(restored?.status).toBe("needs-grilling");
    const active = loadQueueItems(q);
    expect(active.find((i) => i.id === item.id)?.status).toBe("needs-grilling");
  });
});

// ============================================================================
// S4 — discoverQueues reads pipeline.db with no JSONL files
// ============================================================================

describe("S4 — QueueManager.discoverQueues db-native (no JSONL)", () => {
  const S4_QUEUE = testQueue("s4-qm-discover");

  beforeEach(() => {
    // Evict singleton so each run gets a clean slate on the TEST_DIR db
    resetPipelineRepository();
  });

  afterEach(() => {
    resetPipelineRepository();
  });

  test("list() without queue filter discovers queue from pipeline.db — no .jsonl file", async () => {
    // Insert directly via repo — NO appendQueueItem call (which would shadow-write JSONL)
    const repo = getPipelineRepository();
    const itemId = `s4-qm-${Date.now()}`;
    repo.upsert({ id: itemId, queue: S4_QUEUE, title: "S4 QM Discovery Test" });

    // Verify no JSONL for S4_QUEUE exists
    const jsonlPath = join(TEST_DIR, "MEMORY", "QUEUES", `${S4_QUEUE}.jsonl`);
    expect(existsSync(jsonlPath)).toBe(false);

    // list() with no filter calls discoverQueues() internally
    // RED before S4: readdirSync finds no .jsonl for S4_QUEUE → list returns []
    // GREEN after S4: db query finds S4_QUEUE → item returned
    const { QueueManager } = await import("./QueueManager.ts");
    const qm = new QueueManager();
    const items = await qm.list();
    const foundQueues = [...new Set(items.map(i => i.queue))];
    expect(foundQueues).toContain(S4_QUEUE);
  });
});

// ============================================================================
// S6 — cold-start: no manifest.json, no JSONL — get/remove route via repo.get
// ============================================================================

describe("S6 — cold-start: get/remove via repo.get (no manifest.json, no JSONL)", () => {
  beforeEach(() => {
    resetPipelineRepository();
  });

  afterEach(() => {
    resetPipelineRepository();
  });

  test("25. get(id) resolves via repo.get when no manifest.json and no JSONL exist", async () => {
    // Ensure no manifest.json exists
    const manifestPath = join(TEST_DIR, "MEMORY", "QUEUES", "manifest.json");
    if (existsSync(manifestPath)) {
      rmSync(manifestPath);
    }

    // Seed the row directly into pipeline.db — no JSONL shadow write
    const repo = getPipelineRepository();
    const itemId = `s6-get-${Date.now()}`;
    const coldQueue = testQueue("s6-cold-get");
    repo.upsert({ id: itemId, queue: coldQueue, title: "S6 Cold Get Test" });

    // Verify no JSONL file exists for this queue
    const jsonlPath = join(TEST_DIR, "MEMORY", "QUEUES", `${coldQueue}.jsonl`);
    expect(existsSync(jsonlPath)).toBe(false);
    // Verify no manifest.json exists
    expect(existsSync(manifestPath)).toBe(false);

    const { QueueManager } = await import("./QueueManager.ts");
    const qm = new QueueManager();

    const item = await qm.get(itemId);
    expect(item).not.toBeNull();
    expect(item!.id).toBe(itemId);
    expect(item!.queue).toBe(coldQueue);
  });

  test("26. remove(id) resolves via repo.get when no manifest.json and no JSONL exist", async () => {
    // Ensure no manifest.json exists
    const manifestPath = join(TEST_DIR, "MEMORY", "QUEUES", "manifest.json");
    if (existsSync(manifestPath)) {
      rmSync(manifestPath);
    }

    const { QueueManager, appendQueueItem } = await import("./QueueManager.ts");
    const qm = new QueueManager();

    // Use appendQueueItem so item exists in both pipeline.db and JSONL (real removal test)
    const coldQueue = testQueue("s6-cold-remove");
    const item = makeItem({ id: `s6-rm-${Date.now()}`, queue: coldQueue });
    appendQueueItem(coldQueue, item);

    // Delete manifest.json if it was just created
    if (existsSync(manifestPath)) {
      rmSync(manifestPath);
    }

    // Verify removal works with no manifest
    const result = await qm.remove(item.id);
    expect(result).toBe(true);

    // Confirm gone
    const after = await qm.get(item.id);
    expect(after).toBeNull();
  });
});

// ============================================================================
// A3 — updateSpecPipelineStatus atomic transition via repo.transition()
// ============================================================================

describe("A3 — updateSpecPipelineStatus atomic transition", () => {
  function eventsFor(id: string): Array<{ from_stage: string | null; to_stage: string; actor: string }> {
    const repo = getPipelineRepository();
    const rawDb = (repo as unknown as { db: import("bun:sqlite").Database }).db;
    return rawDb
      .prepare("SELECT from_stage, to_stage, actor FROM pipeline_events WHERE item_id = ? AND from_stage IS NOT NULL")
      .all(id) as Array<{ from_stage: string | null; to_stage: string; actor: string }>;
  }

  // updateSpecPipelineStatus() always reads via loadQueueItems("spec-pipeline")
  // (hardcoded queue name — see QueueManager.ts ~1986), so seed items must land
  // in the real "spec-pipeline" queue, not a per-test testQueue() sandbox.

  test("27. legal crossing writes exactly one pipeline_events row with the actor", async () => {
    const item = makeItem({ status: "awaiting-context", queue: "spec-pipeline" });
    appendQueueItem("spec-pipeline", item);

    const { QueueManager } = await import("./QueueManager.ts");
    const qm = new QueueManager();
    const updated = await qm.updateSpecPipelineStatus(item.id, "researching");
    expect(updated?.status).toBe("researching");

    const rows = eventsFor(item.id);
    expect(rows.length).toBe(1);
    expect(rows[0].from_stage).toBe("intake");
    expect(rows[0].to_stage).toBe("researching");
    expect(rows[0].actor).toBe("QueueManager.updateSpecPipelineStatus");

    const after = await qm.get(item.id);
    expect(after?.status).toBe("researching");
  });

  test("28. illegal crossing throws, writes no event, and leaves the stage unchanged", async () => {
    const item = makeItem({ status: "escalated", queue: "spec-pipeline" });
    appendQueueItem("spec-pipeline", item);

    const { QueueManager } = await import("./QueueManager.ts");
    const qm = new QueueManager();
    await expect(qm.updateSpecPipelineStatus(item.id, "generating-spec"))
      .rejects.toThrow(/Invalid spec-pipeline transition/);

    expect(eventsFor(item.id).length).toBe(0);

    const after = await qm.get(item.id);
    expect(after?.status).toBe("escalated");
  });
});

// Global cleanup: restore the pinned KAYA_HOME
afterAll(async () => {
  await restoreKayaHome();
});
