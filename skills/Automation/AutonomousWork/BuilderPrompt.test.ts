/**
 * BuilderPrompt.test.ts
 * Verifies that BuilderPrompt.md contains the TestWriter Tests section and
 * testwriterConcerns field per spec verification-phase2-testwriter.md
 *
 * ISC rows covered: 4032, 6490, 8700
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const PROMPT_PATH = join(
  import.meta.dir,
  "Prompts",
  "BuilderPrompt.md"
);

describe("BuilderPrompt.md — TestWriter Tests section (ISC 4032)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("file exists", () => {
    expect(existsSync(PROMPT_PATH)).toBe(true);
  });

  it("contains a 'TestWriter Tests' section", () => {
    const hasSection =
      content.includes("TestWriter Tests") ||
      content.includes("TestWriter test");
    expect(hasSection).toBe(true);
  });

  it("instructs Builder not to modify TestWriter files", () => {
    const hasNoModify =
      content.includes("DO NOT modify") ||
      content.includes("do not modify") ||
      content.includes("must not modify");
    expect(hasNoModify).toBe(true);
  });

  it("instructs Builder not to delete TestWriter files", () => {
    const hasNoDelete =
      content.includes("DO NOT delete") ||
      content.includes("do not delete") ||
      content.includes("must not delete");
    expect(hasNoDelete).toBe(true);
  });

  it("instructs Builder not to rewrite TestWriter test assertions", () => {
    const hasNoRewrite =
      content.includes("DO NOT rewrite") ||
      content.includes("do not rewrite") ||
      content.includes("must not rewrite");
    expect(hasNoRewrite).toBe(true);
  });

  it("mentions testwriterConcerns as the escalation mechanism for disagreements", () => {
    expect(content).toContain("testwriterConcerns");
  });
});

describe("BuilderPrompt.md — accepts {{TESTWRITER_FILES}} template variable (ISC 6490)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("contains {{TESTWRITER_FILES}} template variable", () => {
    expect(content).toContain("{{TESTWRITER_FILES}}");
  });

  it("{{TESTWRITER_FILES}} appears in the TestWriter contract section", () => {
    const twIdx = content.indexOf("TestWriter Tests");
    const filesIdx = content.indexOf("{{TESTWRITER_FILES}}");
    expect(twIdx).toBeGreaterThan(-1);
    expect(filesIdx).toBeGreaterThan(-1);
    // TESTWRITER_FILES should appear in or near the TestWriter section
    expect(filesIdx).toBeGreaterThan(twIdx - 100);
    const nextSectionIdx = content.indexOf("\n## ", twIdx + 1);
    if (nextSectionIdx > -1) {
      expect(filesIdx).toBeLessThan(nextSectionIdx + 500);
    }
  });
});

describe("BuilderPrompt.md — return JSON includes testwriterConcerns (ISC 8700)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("return JSON schema includes testwriterConcerns field", () => {
    expect(content).toContain("testwriterConcerns");
  });

  it("testwriterConcerns appears in the JSON return schema block", () => {
    // Find the JSON code block for return value
    const jsonBlockIdx = content.indexOf('"testwriterConcerns"');
    expect(jsonBlockIdx).toBeGreaterThan(-1);
    // Should be inside a JSON block (near other fields like "success", "completedRows")
    const jsonRegion = content.slice(Math.max(0, jsonBlockIdx - 200), jsonBlockIdx + 200);
    expect(jsonRegion).toContain("completedRows");
    expect(jsonRegion).toContain("failedRows");
  });

  it("testwriterConcerns is an array type", () => {
    // The JSON schema block should show testwriterConcerns as an array (e.g., [])
    // Search for the JSON form: "testwriterConcerns": []
    const jsonFormIdx = content.indexOf('"testwriterConcerns"');
    expect(jsonFormIdx).toBeGreaterThan(-1);
    const region = content.slice(jsonFormIdx, jsonFormIdx + 100);
    const isArray =
      region.includes("[]") ||
      region.includes("array") ||
      region.includes("Array") ||
      region.includes("[");
    expect(isArray).toBe(true);
  });
});
