/**
 * Orchestrate.test.ts
 * Verifies that Orchestrate.md passes {{WORK_SURFACE}} into the
 * TaskOrchestratorPrompt template variable fill table
 * per spec verification-phase2-testwriter.md
 *
 * ISC rows covered: 6704
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const WORKFLOW_PATH = join(
  import.meta.dir,
  "Workflows",
  "Orchestrate.md"
);

describe("Orchestrate.md — passes {{WORK_SURFACE}} to TaskOrchestratorPrompt (ISC 6704)", () => {
  let content: string;
  beforeAll(() => { content = readFileSync(WORKFLOW_PATH, "utf-8"); });

  it("file exists", () => {
    expect(existsSync(WORKFLOW_PATH)).toBe(true);
  });

  it("contains {{WORK_SURFACE}} template variable reference", () => {
    expect(content).toContain("{{WORK_SURFACE}}");
  });

  it("{{WORK_SURFACE}} appears in the template variable fill table", () => {
    // Find the template variable fill table (should be in Single-Shot Delegation section)
    const fillTableIdx = content.indexOf("| Variable | Source |");
    expect(fillTableIdx).toBeGreaterThan(-1);
    const fillTableEnd = content.indexOf("\n3.", fillTableIdx);
    const fillTableContent = content.slice(fillTableIdx, fillTableEnd > -1 ? fillTableEnd : fillTableIdx + 2000);
    expect(fillTableContent).toContain("{{WORK_SURFACE}}");
  });

  it("{{WORK_SURFACE}} is sourced from CapabilityRouter workSurface field", () => {
    const workSurfaceIdx = content.indexOf("{{WORK_SURFACE}}");
    const region = content.slice(workSurfaceIdx, workSurfaceIdx + 200);
    const hasSource =
      region.includes("CapabilityRouter") ||
      region.includes("workSurface") ||
      region.includes("surface") ||
      region.includes("Phase 1");
    expect(hasSource).toBe(true);
  });

  it("{{WORK_SURFACE}} is in the single-shot delegation section", () => {
    // Single-Shot Delegation section should contain the fill table with WORK_SURFACE
    const singleShotIdx = content.indexOf("Single-Shot Delegation");
    const workSurfaceIdx = content.indexOf("{{WORK_SURFACE}}");
    expect(singleShotIdx).toBeGreaterThan(-1);
    expect(workSurfaceIdx).toBeGreaterThan(singleShotIdx - 100);
  });
});
