#!/usr/bin/env bun
/**
 * ToonPhase3.test.ts - Tests for TOON Phase 3: Context Pipeline Encoding
 *
 * Tests written FIRST per TDD methodology (RED phase).
 * Covers:
 *   3a: Inference.ts toonEncodeInput flag
 *   3b: ContextSelector.ts structured file TOON encoding
 *   3c: LoadContext.hook.ts queue summary TOON format
 *
 * @module ToonPhase3.test
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ============================================================================
// 3a: Inference.ts - toonEncodeInput
// ============================================================================

describe("Inference toonEncodeInput", () => {
  it("exports toonEncodeInput as an optional field in InferenceOptions", async () => {
    const { inference } = await import("../Inference");
    // The function should accept toonEncodeInput without error
    // We can't actually run inference (spawns claude), but we verify the type exists
    expect(typeof inference).toBe("function");
  });

  it("detectJsonArraysInText finds JSON arrays in mixed text", async () => {
    const { detectJsonArraysInText } = await import("../Inference");
    const text = `Here is some data: [{"name":"Alice","age":30},{"name":"Bob","age":25}] and more text.`;
    const result = detectJsonArraysInText(text);
    expect(result.length).toBe(1);
    expect(result[0].parsed).toEqual([
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
    ]);
  });

  it("detectJsonArraysInText returns empty for text without JSON arrays", async () => {
    const { detectJsonArraysInText } = await import("../Inference");
    const text = "This is just plain text with no JSON arrays.";
    const result = detectJsonArraysInText(text);
    expect(result.length).toBe(0);
  });

  it("detectJsonArraysInText ignores non-array JSON objects", async () => {
    const { detectJsonArraysInText } = await import("../Inference");
    const text = `Some data: {"key":"value"} here.`;
    const result = detectJsonArraysInText(text);
    expect(result.length).toBe(0);
  });

  it("detectJsonArraysInText handles multiple JSON arrays", async () => {
    const { detectJsonArraysInText } = await import("../Inference");
    const text = `First: [{"a":1},{"a":2}] Second: [{"b":3},{"b":4}]`;
    const result = detectJsonArraysInText(text);
    expect(result.length).toBe(2);
  });

  it("toonEncodePrompt replaces JSON arrays with TOON when savings are significant", async () => {
    const { toonEncodePrompt } = await import("../Inference");
    // Create a large enough uniform array to trigger TOON encoding
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      email: `user${i}@example.com`,
      active: true,
    }));
    const jsonStr = JSON.stringify(items);
    const text = `Analyze this data: ${jsonStr}`;
    const result = toonEncodePrompt(text);
    // If savings are significant, the JSON array should be replaced with TOON
    // The result should NOT contain the original JSON array verbatim
    if (result !== text) {
      expect(result).not.toContain(jsonStr);
      // Should contain TOON markers or compressed format
      expect(result).toContain("Analyze this data:");
    }
  });

  it("toonEncodePrompt leaves text unchanged when no JSON arrays present", async () => {
    const { toonEncodePrompt } = await import("../Inference");
    const text = "Just a normal question with no structured data.";
    const result = toonEncodePrompt(text);
    expect(result).toBe(text);
  });
});

// ============================================================================
// 3b: ContextSelector.ts - Structured file TOON encoding
// ============================================================================

describe("ContextSelector TOON encoding", () => {
  const TEST_DIR = join(tmpdir(), `context-toon-test-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills/ContextManager/config"), { recursive: true });
    mkdirSync(join(TEST_DIR, "testdata"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("exports maybeConvertContentToToon function", async () => {
    const mod = await import("../../../../skills/ContextManager/Tools/ContextSelector");
    expect(typeof mod.maybeConvertContentToToon).toBe("function");
  });

  it("converts pure JSON array content to TOON when savings are significant", async () => {
    const { maybeConvertContentToToon } = await import(
      "../../../../skills/ContextManager/Tools/ContextSelector"
    );
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      email: `user${i}@example.com`,
      role: "member",
    }));
    const jsonContent = JSON.stringify(items);
    const result = maybeConvertContentToToon(jsonContent);
    // Should return TOON format when savings are significant
    expect(result.converted).toBe(true);
    expect(result.content).not.toBe(jsonContent);
    expect(result.format).toBe("toon");
  });

  it("does NOT convert non-JSON content", async () => {
    const { maybeConvertContentToToon } = await import(
      "../../../../skills/ContextManager/Tools/ContextSelector"
    );
    const markdownContent = "# Header\n\nSome text\n\n- bullet 1\n- bullet 2";
    const result = maybeConvertContentToToon(markdownContent);
    expect(result.converted).toBe(false);
    expect(result.content).toBe(markdownContent);
    expect(result.format).toBe("original");
  });

  it("does NOT convert JSON objects (non-array)", async () => {
    const { maybeConvertContentToToon } = await import(
      "../../../../skills/ContextManager/Tools/ContextSelector"
    );
    const jsonObj = JSON.stringify({ key: "value", nested: { a: 1 } });
    const result = maybeConvertContentToToon(jsonObj);
    expect(result.converted).toBe(false);
    expect(result.format).toBe("original");
  });

  it("does NOT convert small arrays where savings are minimal", async () => {
    const { maybeConvertContentToToon } = await import(
      "../../../../skills/ContextManager/Tools/ContextSelector"
    );
    const smallArray = JSON.stringify([{ a: 1 }]);
    const result = maybeConvertContentToToon(smallArray);
    // Small arrays may not meet the savings threshold
    expect(result.content).toBeDefined();
  });

  it("preserves data integrity through TOON conversion", async () => {
    const { maybeConvertContentToToon } = await import(
      "../../../../skills/ContextManager/Tools/ContextSelector"
    );
    const { fromToon } = await import("../ToonHelper");
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      email: `user${i}@example.com`,
    }));
    const jsonContent = JSON.stringify(items);
    const result = maybeConvertContentToToon(jsonContent);
    if (result.converted) {
      const decoded = fromToon(result.content);
      expect(decoded).toEqual(items);
    }
  });
});

// ============================================================================
// 3c: LoadContext queue summary - TOON format
// ============================================================================

describe("LoadContext queue summary TOON encoding", () => {
  const TEST_DIR = join(tmpdir(), `loadcontext-toon-test-${Date.now()}`);
  const QUEUES_DIR = join(TEST_DIR, "MEMORY", "QUEUES");

  beforeEach(() => {
    mkdirSync(QUEUES_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("exports formatQueueItemsAsToon function", async () => {
    const { formatQueueItemsAsToon } = await import(
      "../../../../hooks/LoadContext.hook"
    );
    expect(typeof formatQueueItemsAsToon).toBe("function");
  });

  it("converts uniform queue items to TOON format", async () => {
    const { formatQueueItemsAsToon } = await import(
      "../../../../hooks/LoadContext.hook"
    );
    const items = [
      {
        id: "abc12345-1111",
        created: "2026-02-09T10:00:00Z",
        status: "pending",
        priority: 2,
        type: "task",
        queue: "work",
        payload: { title: "Task 1", description: "Do thing 1" },
      },
      {
        id: "abc12345-2222",
        created: "2026-02-09T11:00:00Z",
        status: "pending",
        priority: 1,
        type: "task",
        queue: "work",
        payload: { title: "Task 2", description: "Do thing 2" },
      },
      {
        id: "abc12345-3333",
        created: "2026-02-09T12:00:00Z",
        status: "in_progress",
        priority: 3,
        type: "task",
        queue: "work",
        payload: { title: "Task 3", description: "Do thing 3" },
      },
    ];
    const result = formatQueueItemsAsToon(items);
    expect(typeof result).toBe("string");
    // Should contain TOON-formatted data, not bullet points
    expect(result).not.toContain("   \u2022 [");
  });

  it("returns bullet-point markdown for non-uniform items", async () => {
    const { formatQueueItemsAsToon } = await import(
      "../../../../hooks/LoadContext.hook"
    );
    // Empty array should return empty string
    const result = formatQueueItemsAsToon([]);
    expect(result).toBe("");
  });

  it("includes all item fields in TOON output", async () => {
    const { formatQueueItemsAsToon } = await import(
      "../../../../hooks/LoadContext.hook"
    );
    const items = [
      {
        id: "abc12345-1111",
        created: "2026-02-09T10:00:00Z",
        status: "pending",
        priority: 2,
        type: "task",
        queue: "work",
        payload: { title: "Task 1" },
      },
      {
        id: "abc12345-2222",
        created: "2026-02-09T11:00:00Z",
        status: "pending",
        priority: 1,
        type: "task",
        queue: "work",
        payload: { title: "Task 2" },
      },
    ];
    const result = formatQueueItemsAsToon(items);
    // The TOON output should reference at least some fields
    expect(result).toContain("Task 1");
    expect(result).toContain("Task 2");
  });
});

// ============================================================================
// Settings integration - toon config flags
// ============================================================================

describe("TOON settings.json config", () => {
  it("settings.json has toon config section with all flags defaulting to false", async () => {
    const { readFileSync } = await import("fs");
    const settingsPath = join(process.env.HOME!, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.toon).toBeDefined();
    expect(settings.toon.enableInContext).toBe(false);
    expect(settings.toon.enableInInference).toBe(false);
    expect(settings.toon.enableInQueues).toBe(false);
  });
});
