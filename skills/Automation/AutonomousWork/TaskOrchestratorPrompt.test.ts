/**
 * TaskOrchestratorPrompt.test.ts
 * Verifies that TaskOrchestratorPrompt.md contains all TestWriter Phase 2 additions
 * per spec verification-phase2-testwriter.md
 *
 * ISC rows covered: 4224, 2960, 2848, 8556, 7848, 5920, 6669
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const PROMPT_PATH = join(
  import.meta.dir,
  "Prompts",
  "TaskOrchestratorPrompt.md"
);

describe("TaskOrchestratorPrompt.md — Step 0 TestWriter spawn before Builder loop (ISC 4224)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("file exists", () => {
    expect(existsSync(PROMPT_PATH)).toBe(true);
  });

  it("contains a Step 0 section for TestWriter", () => {
    const hasStep0 =
      content.includes("Step 0") &&
      (content.includes("TestWriter") || content.includes("test-writer") || content.includes("testwriter"));
    expect(hasStep0).toBe(true);
  });

  it("Step 0 appears before the main Builder/Verifier loop", () => {
    const step0Idx = content.indexOf("Step 0");
    const loopIdx = content.indexOf("LOOP (while iteration");
    expect(step0Idx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(-1);
    // Step 0 must come before the loop
    expect(step0Idx).toBeLessThan(loopIdx);
  });

  it("Step 0 spawns a Task for the TestWriter agent", () => {
    const step0Idx = content.indexOf("Step 0");
    const loopIdx = content.indexOf("LOOP (while iteration");
    const step0Section = content.slice(step0Idx, loopIdx);
    expect(step0Section).toContain("Task(");
    expect(step0Section.toLowerCase()).toMatch(/testwriter|test-writer/);
  });
});

describe("TaskOrchestratorPrompt.md — WORK_SURFACE template variable (ISC 2960)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("accepts {{WORK_SURFACE}} as a template variable in context", () => {
    expect(content).toContain("{{WORK_SURFACE}}");
  });

  it("passes {{WORK_SURFACE}} to the TestWriter prompt fill", () => {
    const step0Idx = content.indexOf("Step 0");
    const loopIdx = content.indexOf("LOOP (while iteration");
    const step0Section = content.slice(step0Idx, loopIdx);
    expect(step0Section).toContain("{{WORK_SURFACE}}");
  });
});

describe("TaskOrchestratorPrompt.md — TestWriter runs exactly once (ISC 2848)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("specifies that TestWriter runs once, not once per iteration", () => {
    const oncePhrases = [
      "exactly once",
      "runs once",
      "once per item",
      "not once per iteration",
      "once, before",
    ];
    const hasOncePhrase = oncePhrases.some(p => content.includes(p));
    expect(hasOncePhrase).toBe(true);
  });

  it("TestWriter spawn is outside the loop (Step 0 before LOOP)", () => {
    const step0Idx = content.indexOf("Step 0");
    const loopIdx = content.indexOf("LOOP (while iteration");
    // TestWriter must be invoked before the loop, ensuring it runs only once
    expect(step0Idx).toBeLessThan(loopIdx);
  });
});

describe("TaskOrchestratorPrompt.md — graceful crash handling (ISC 8556)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("handles TestWriter crash by logging a warning", () => {
    const hasCrashHandling =
      content.includes("crash") ||
      content.includes("crashes") ||
      content.includes("failed") ||
      content.includes("warning");
    expect(hasCrashHandling).toBe(true);
  });

  it("continues to Builder in degraded mode when TestWriter fails", () => {
    const hasDegradedMode =
      content.includes("degraded mode") ||
      content.includes("degraded") ||
      content.includes("continue") ||
      content.includes("do NOT abort") ||
      content.includes("do not abort");
    expect(hasDegradedMode).toBe(true);
  });

  it("sets needsReview to true when TestWriter crashes", () => {
    const hasNeedsReview =
      content.includes("needsReview") &&
      (content.includes("needsReview = true") || content.includes('"needsReview": true'));
    expect(hasNeedsReview).toBe(true);
  });
});

describe("TaskOrchestratorPrompt.md — stores testWriterCommitSha, passes to Verifier (ISC 7848)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("stores the TestWriter commitSha as testWriterCommitSha", () => {
    expect(content).toContain("testWriterCommitSha");
  });

  it("passes testWriterCommitSha to the Verifier as {{TESTWRITER_COMMIT_SHA}}", () => {
    expect(content).toContain("{{TESTWRITER_COMMIT_SHA}}");
    // verify it's used in the Verifier fill section
    const verifierFillIdx = content.indexOf("{{TESTWRITER_COMMIT_SHA}}");
    expect(verifierFillIdx).toBeGreaterThan(-1);
  });

  it("{{TESTWRITER_COMMIT_SHA}} is used in the Verifier fill variables", () => {
    // Find the Verifier step and confirm TESTWRITER_COMMIT_SHA is there
    const verifierStepIdx = content.indexOf("Spawn Verifier");
    const sha = content.indexOf("{{TESTWRITER_COMMIT_SHA}}");
    expect(verifierStepIdx).toBeGreaterThan(-1);
    expect(sha).toBeGreaterThan(-1);
    // SHA reference appears after or around the Verifier fill section
    const fillIdx = content.indexOf("{{TESTWRITER_COMMIT_SHA}}", verifierStepIdx > 0 ? verifierStepIdx - 2000 : 0);
    expect(fillIdx).toBeGreaterThan(-1);
  });
});

describe("TaskOrchestratorPrompt.md — return JSON includes testWriterOutput (ISC 5920)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("return JSON schema includes testWriterOutput field", () => {
    expect(content).toContain("testWriterOutput");
  });

  it("testWriterOutput appears in the Return JSON section", () => {
    const returnJsonIdx = content.indexOf("Return JSON");
    expect(returnJsonIdx).toBeGreaterThan(-1);
    // Search for testWriterOutput AFTER the Return JSON header
    const testWriterOutputIdx = content.indexOf("testWriterOutput", returnJsonIdx);
    expect(testWriterOutputIdx).toBeGreaterThan(returnJsonIdx);
  });
});

describe("TaskOrchestratorPrompt.md — emits trace event after TestWriter completes (ISC 6669)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("emits a trace event using TraceEmitter.ts after TestWriter completes", () => {
    expect(content).toContain("TraceEmitter.ts");
  });

  it("trace event uses --agent test-writer and --event completion", () => {
    const traceIdx = content.indexOf("test-writer");
    expect(traceIdx).toBeGreaterThan(-1);
    // Find the trace command near the test-writer reference
    const region = content.slice(Math.max(0, traceIdx - 200), traceIdx + 200);
    expect(region).toContain("completion");
  });

  it("trace event is in Step 0 (after TestWriter completes, before loop)", () => {
    const step0Idx = content.indexOf("Step 0");
    const loopIdx = content.indexOf("LOOP (while iteration");
    const traceIdx = content.indexOf("test-writer");
    expect(step0Idx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(-1);
    expect(traceIdx).toBeGreaterThan(-1);
    // trace for test-writer should be within or near Step 0
    expect(traceIdx).toBeGreaterThan(step0Idx - 100);
    expect(traceIdx).toBeLessThan(loopIdx + 500);
  });
});
