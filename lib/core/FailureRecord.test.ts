/**
 * FailureRecord.test.ts - Smoke tests for FailureRecord
 */
import { describe, it, expect } from "bun:test";
import { recordFailure, recordFailureDump } from "./FailureRecord.ts";
import type { FailureRecordInput, FailureDumpInput } from "./FailureRecord.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const TMP_DIR = join(os.tmpdir(), `test-kaya-${Date.now()}`);

/**
 * Point both home env vars at `dir` (getKayaHome() prefers KAYA_HOME, so
 * setting only KAYA_DIR wrote into the real MEMORY when KAYA_HOME was
 * exported). The returned restore deletes a var that was unset before:
 * assigning `undefined` to process.env stores the string "undefined", which
 * made later tests create ./undefined/.cache/http.
 */
function pointKayaHomeAt(dir: string): () => void {
  const saved = { KAYA_HOME: process.env.KAYA_HOME, KAYA_DIR: process.env.KAYA_DIR };
  process.env.KAYA_HOME = dir;
  process.env.KAYA_DIR = dir;
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

describe("FailureRecord", () => {
  it("exports recordFailure and recordFailureDump functions", () => {
    expect(typeof recordFailure).toBe("function");
    expect(typeof recordFailureDump).toBe("function");
  });

  it("recordFailure creates a failure file and returns path", async () => {
    const input: FailureRecordInput = {
      transcriptPath: "/nonexistent/transcript.jsonl",
      rating: 2,
      sentimentSummary: "Test failure for smoke test",
      detailedContext: "Test context",
      sessionId: "test-session-smoke",
    };

    // Override KAYA_DIR to use temp dir
    const restoreEnv = pointKayaHomeAt(TMP_DIR);
    mkdirSync(join(TMP_DIR, "MEMORY", "LEARNING", "FAILURES"), { recursive: true });

    try {
      const resultPath = await recordFailure(input);
      expect(typeof resultPath).toBe("string");
      expect(resultPath.length).toBeGreaterThan(0);
    } finally {
      restoreEnv();
    }
  });

  it("recordFailureDump creates a structured dump and returns path", async () => {
    const input: FailureDumpInput = {
      sessionId: "test-session-dump",
      transcriptPath: "/nonexistent/transcript.jsonl",
      rating: 1,
      comment: "Smoke test failure dump",
    };

    const restoreEnv = pointKayaHomeAt(TMP_DIR);
    mkdirSync(join(TMP_DIR, "MEMORY", "LEARNING", "FAILURES"), { recursive: true });

    try {
      const resultPath = await recordFailureDump(input);
      expect(typeof resultPath).toBe("string");
      expect(resultPath.length).toBeGreaterThan(0);
    } finally {
      restoreEnv();
    }
  });
});
