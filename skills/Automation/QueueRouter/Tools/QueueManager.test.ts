import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import {
  validateSpecPipelineTransition,
  SPEC_PIPELINE_TRANSITIONS,
  generateId,
  loadQueueItems,
  saveQueueItems,
  appendQueueItem,
  archiveItems,
  getQueueFilePath,
  type QueueItem,
  type QueueItemStatus,
} from "./QueueManager.ts";

// ============================================================================
// Helpers
// ============================================================================

const TEST_DIR = join(tmpdir(), `qm-test-${Date.now()}`);
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
  });

  test("2. generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

// ============================================================================
// validateSpecPipelineTransition
// ============================================================================

describe("validateSpecPipelineTransition", () => {
  test("3. valid transition: awaiting-context → researching returns null", () => {
    const result = validateSpecPipelineTransition("awaiting-context", "researching");
    expect(result).toBeNull();
  });

  test("4. valid transition: researching → generating-spec returns null", () => {
    const result = validateSpecPipelineTransition("researching", "generating-spec");
    expect(result).toBeNull();
  });

  test("5. valid transition: generating-spec → revision-needed returns null", () => {
    const result = validateSpecPipelineTransition("generating-spec", "revision-needed");
    expect(result).toBeNull();
  });

  test("6. invalid transition: awaiting-context → generating-spec returns error string", () => {
    const result = validateSpecPipelineTransition("awaiting-context", "generating-spec");
    expect(typeof result).toBe("string");
    expect(result).toContain("Invalid spec-pipeline transition");
  });

  test("7. terminal state escalated has no allowed transitions", () => {
    expect(SPEC_PIPELINE_TRANSITIONS["escalated"]).toEqual([]);
    const result = validateSpecPipelineTransition("escalated", "researching");
    expect(typeof result).toBe("string");
  });

  test("8. non-spec-pipeline fromStatus returns null (not our concern)", () => {
    // standard queue statuses are not governed by spec-pipeline rules
    const result = validateSpecPipelineTransition("pending", "completed");
    expect(result).toBeNull();
  });

  test("9. transition from revision-needed can go to researching or escalated", () => {
    expect(validateSpecPipelineTransition("revision-needed", "researching")).toBeNull();
    expect(validateSpecPipelineTransition("revision-needed", "escalated")).toBeNull();
  });

  test("10. all spec-pipeline states are present in transition map", () => {
    const states = [
      "awaiting-context",
      "researching",
      "generating-spec",
      "revision-needed",
      "escalated",
    ];
    for (const state of states) {
      expect(SPEC_PIPELINE_TRANSITIONS[state]).toBeDefined();
    }
  });
});

// ============================================================================
// JSONL persistence: loadQueueItems / saveQueueItems / appendQueueItem
//
// NOTE: QUEUES_DIR is resolved at module load time from KAYA_HOME, so we
// cannot override it per-test via env. Instead, each test uses a unique queue
// name to avoid cross-test contamination. Cleanup removes the test JSONL files.
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
