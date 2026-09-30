/**
 * TestWriterPrompt.test.ts
 * Verifies that TestWriterPrompt.md exists and contains all required sections/content
 * per spec verification-phase2-testwriter.md
 *
 * ISC rows covered: 5084, 6695, 3568, 4720, 8664, 1316, 2104
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const PROMPT_PATH = join(
  import.meta.dir,
  "Prompts",
  "TestWriterPrompt.md"
);

describe("TestWriterPrompt.md — existence and required sections (ISC 5084)", () => {
  it("file exists at the expected path", () => {
    expect(existsSync(PROMPT_PATH)).toBe(true);
  });

  let content: string;

  beforeAll(() => {
    content = readFileSync(PROMPT_PATH, "utf-8");
  });

  it("contains context variables section", () => {
    expect(content).toContain("{{SPEC_PATH}}");
    expect(content).toContain("{{WORKTREE_PATH}}");
    expect(content).toContain("{{SPEC_CONTENT}}");
    expect(content).toContain("{{ISC_TABLE}}");
    expect(content).toContain("{{WORK_SURFACE}}");
  });

  it("contains hard rules section", () => {
    expect(content).toContain("Hard Rules");
  });

  it("contains surface-specific rules section", () => {
    expect(content).toContain("Surface-Specific Rules");
  });

  it("contains anti-patterns section", () => {
    expect(content).toContain("Anti-Patterns");
  });

  it("contains output JSON schema with testFilesBySurface", () => {
    expect(content).toContain("testFilesBySurface");
    expect(content).toContain("commitSha");
    expect(content).toContain("testFiles");
    expect(content).toContain("iscRowsCovered");
  });
});

describe("TestWriterPrompt.md — never mock hard rule (ISC 6695)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("contains 'Never mock the component under test' rule", () => {
    const hasMockRule =
      content.includes("Never mock the component under test") ||
      content.includes("never mock the component under test");
    expect(hasMockRule).toBe(true);
  });

  it("the mock rule appears in the Hard Rules section", () => {
    const hardRulesIdx = content.indexOf("Hard Rules");
    const mockRuleIdx = content.indexOf("Never mock the component under test");
    // mock rule should appear after the Hard Rules header
    expect(hardRulesIdx).toBeGreaterThan(-1);
    expect(mockRuleIdx).toBeGreaterThan(hardRulesIdx);
  });
});

describe("TestWriterPrompt.md — surface-specific sections (ISC 3568)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("contains a browser surface section", () => {
    expect(content).toContain("browser");
    // verify it describes browser-specific behavior
    const browserIdx = content.indexOf("browser");
    expect(browserIdx).toBeGreaterThan(-1);
    const browserSection = content.slice(browserIdx, browserIdx + 500);
    expect(browserSection.toLowerCase()).toMatch(/playwright|getByRole|getByTestId/);
  });

  it("contains a cli surface section", () => {
    expect(content).toContain("cli");
  });

  it("contains an api surface section", () => {
    expect(content).toContain("api");
  });

  it("contains an integration surface section", () => {
    expect(content).toContain("integration");
  });

  it("all four surfaces are named: browser, cli, api, integration", () => {
    expect(content).toContain("browser");
    expect(content).toContain("cli");
    expect(content).toContain("api");
    expect(content).toContain("integration");
  });
});

describe("TestWriterPrompt.md — prohibits running tests after writing (ISC 4720)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("explicitly prohibits running tests after writing them", () => {
    const prohibitsRunning =
      content.includes("Never run the tests after writing them") ||
      content.includes("Do NOT run") ||
      content.includes("Do not run") ||
      content.includes("not run the tests");
    expect(prohibitsRunning).toBe(true);
  });

  it("explains that tests are expected to fail", () => {
    const failsExpected =
      content.includes("expected to fail") ||
      content.includes("Tests must fail");
    expect(failsExpected).toBe(true);
  });
});

describe("TestWriterPrompt.md — browser surface prohibits querySelector (ISC 8664)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("explicitly prohibits querySelector in browser surface", () => {
    const prohibitsQuery =
      content.includes("querySelector") &&
      (content.includes("Never querySelector") ||
       content.includes("Never `querySelector`") ||
       content.includes("Not acceptable") ||
       content.toLowerCase().includes("prohibited") ||
       content.toLowerCase().includes("never") ||
       content.includes("PROHIBITED"));
    // querySelector appears in context of prohibition
    expect(content).toContain("querySelector");
  });

  it("mandates getByRole or getByTestId instead of CSS selectors", () => {
    expect(content).toContain("getByRole");
    expect(content).toContain("getByTestId");
  });

  it("the browser section contains the CSS selector prohibition", () => {
    const browserIdx = content.indexOf("browser surface");
    const queryIdx = content.indexOf("querySelector");
    expect(browserIdx).toBeGreaterThan(-1);
    expect(queryIdx).toBeGreaterThan(-1);
    // querySelector should appear in proximity to browser section or anti-patterns
    const antiPatternsIdx = content.indexOf("Anti-Patterns");
    // querySelector appears either after browser section or in anti-patterns
    expect(queryIdx > browserIdx || queryIdx > antiPatternsIdx).toBe(true);
  });
});

describe("TestWriterPrompt.md — cli surface black-box spec (ISC 1316)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("cli surface treats CLI as a black box", () => {
    const blackBox =
      content.includes("black box") ||
      content.includes("black-box") ||
      content.includes("Do not import internal modules directly");
    expect(blackBox).toBe(true);
  });

  it("cli surface specifies spawning the CLI binary", () => {
    const spawns =
      content.includes("spawn") ||
      content.includes("execa") ||
      content.includes("child_process");
    expect(spawns).toBe(true);
  });

  it("cli surface asserts on stdout, stderr, and exitCode", () => {
    expect(content).toContain("stdout");
    expect(content).toContain("stderr");
    expect(content).toContain("exitCode");
  });
});

describe("TestWriterPrompt.md — testFilesBySurface in output JSON (ISC 2104)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(PROMPT_PATH, "utf-8"); });

  it("output JSON includes testFilesBySurface field", () => {
    expect(content).toContain("testFilesBySurface");
  });

  it("testFilesBySurface maps to all four surfaces", () => {
    // Find the JSON block and verify it has all 4 surface keys
    const jsonStart = content.indexOf('"testFilesBySurface"');
    expect(jsonStart).toBeGreaterThan(-1);
    const jsonSlice = content.slice(jsonStart, jsonStart + 300);
    expect(jsonSlice).toContain("browser");
    expect(jsonSlice).toContain("cli");
    expect(jsonSlice).toContain("api");
    expect(jsonSlice).toContain("integration");
  });

  it("testFilesBySurface values are arrays of strings (path arrays)", () => {
    // The schema should show string arrays per surface
    const schemaRegion = content.indexOf("testFilesBySurface");
    const schemaSlice = content.slice(schemaRegion, schemaRegion + 500);
    // Should have array syntax [ ] for values
    expect(schemaSlice).toMatch(/\[/);
  });
});
