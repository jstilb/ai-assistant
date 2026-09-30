/**
 * VerifierPrompt.test.ts
 * Verifies that VerifierPrompt.md contains the immutability check and
 * TestWriter template variables per spec verification-phase2-testwriter.md
 *
 * ISC rows covered: 6760, 9344, 7900
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const PROMPT_PATH = join(
  import.meta.dir,
  "Prompts",
  "VerifierPrompt.md"
);

describe("VerifierPrompt.md — immutability check step (ISC 6760)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("file exists", () => {
    expect(existsSync(PROMPT_PATH)).toBe(true);
  });

  it("contains an immutability check step", () => {
    const hasImmutabilityCheck =
      content.includes("Immutability Check") ||
      content.includes("immutability check") ||
      content.includes("TestWriter Immutability");
    expect(hasImmutabilityCheck).toBe(true);
  });

  it("contains git diff command for testwriter commit sha", () => {
    // Should have git diff <sha>..HEAD -- <file> pattern
    const hasGitDiff =
      content.includes("git diff") &&
      (content.includes("TESTWRITER_COMMIT_SHA") || content.includes("testwriter-commit-sha"));
    expect(hasGitDiff).toBe(true);
  });

  it("uses git -C {{WORKTREE_PATH}} diff {{TESTWRITER_COMMIT_SHA}}..HEAD", () => {
    const hasCommand =
      content.includes("git -C") &&
      content.includes("TESTWRITER_COMMIT_SHA") &&
      content.includes("..HEAD");
    expect(hasCommand).toBe(true);
  });

  it("runs the check for each TestWriter file", () => {
    // Should iterate over testwriter files
    const hasPerFile =
      content.includes("each file") ||
      content.includes("For each file") ||
      content.includes("for each");
    expect(hasPerFile).toBe(true);
  });
});

describe("VerifierPrompt.md — non-empty diff is hard FAIL (ISC 9344)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("specifies that non-empty diff for TestWriter file is a hard FAIL", () => {
    const hasHardFail =
      (content.includes("HARD FAILURE") || content.includes("hard FAIL") || content.includes("hard failure")) &&
      content.includes("non-empty");
    expect(hasHardFail).toBe(true);
  });

  it("specifies the check runs regardless of test results", () => {
    const runsRegardless =
      content.includes("regardless") ||
      content.includes("regardless of whether the tests pass") ||
      content.includes("even if");
    expect(runsRegardless).toBe(true);
  });

  it("a passing test suite with modified TestWriter tests is still a failure", () => {
    const passingStillFails =
      content.includes("passing test suite") ||
      content.includes("STILL a failure") ||
      content.includes("still a failure") ||
      content.includes("STILL a fail");
    expect(passingStillFails).toBe(true);
  });
});

describe("VerifierPrompt.md — accepts {{TESTWRITER_FILES}} and {{TESTWRITER_COMMIT_SHA}} (ISC 7900)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("contains {{TESTWRITER_FILES}} template variable", () => {
    expect(content).toContain("{{TESTWRITER_FILES}}");
  });

  it("contains {{TESTWRITER_COMMIT_SHA}} template variable", () => {
    expect(content).toContain("{{TESTWRITER_COMMIT_SHA}}");
  });

  it("both template variables appear in the context/header section", () => {
    const filesIdx = content.indexOf("{{TESTWRITER_FILES}}");
    const shaIdx = content.indexOf("{{TESTWRITER_COMMIT_SHA}}");
    // Both should be present at or near the beginning (context section)
    expect(filesIdx).toBeGreaterThan(-1);
    expect(shaIdx).toBeGreaterThan(-1);
    // Both should appear before the main task section
    const taskSectionIdx = content.indexOf("## Your Task");
    if (taskSectionIdx > -1) {
      // At least one occurrence should be in the context section
      expect(filesIdx).toBeLessThan(taskSectionIdx + 1000);
      expect(shaIdx).toBeLessThan(taskSectionIdx + 1000);
    }
  });
});
