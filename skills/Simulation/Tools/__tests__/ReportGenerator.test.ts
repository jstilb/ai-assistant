import { describe, test, expect } from "bun:test";
import {
  generateMarkdownReport,
  type SimulationResult,
  REPORT_SECTIONS,
} from "../ReportGenerator.ts";

// ============================================
// ISC #6: Report Generator Tests
// 5 required sections, data accuracy
// ============================================

function makeResult(overrides: Partial<SimulationResult> = {}): SimulationResult {
  return {
    scenarioId: "test-001",
    scenarioName: "Test Scenario",
    scenarioType: "chaos",
    totalRuns: 5,
    passed: 4,
    failed: 1,
    errors: 0,
    passRate: 0.8,
    startedAt: "2026-02-09T12:00:00Z",
    completedAt: "2026-02-09T12:05:00Z",
    totalDuration_ms: 300000,
    runs: [
      {
        runIndex: 0,
        seed: 42,
        status: "pass",
        duration_ms: 55000,
        faultsInjected: 2,
        invariantResults: [
          { name: "no_writes_outside_sandbox", passed: true },
          { name: "graceful_errors", passed: true },
        ],
      },
      {
        runIndex: 1,
        seed: 43,
        status: "pass",
        duration_ms: 60000,
        faultsInjected: 1,
        invariantResults: [
          { name: "no_writes_outside_sandbox", passed: true },
          { name: "graceful_errors", passed: true },
        ],
      },
      {
        runIndex: 2,
        seed: 44,
        status: "fail",
        duration_ms: 65000,
        faultsInjected: 3,
        invariantResults: [
          { name: "no_writes_outside_sandbox", passed: true },
          { name: "graceful_errors", passed: false, details: "Hallucinated success" },
        ],
        error: "Invariant violation",
      },
      {
        runIndex: 3,
        seed: 45,
        status: "pass",
        duration_ms: 58000,
        faultsInjected: 1,
        invariantResults: [
          { name: "no_writes_outside_sandbox", passed: true },
          { name: "graceful_errors", passed: true },
        ],
      },
      {
        runIndex: 4,
        seed: 46,
        status: "pass",
        duration_ms: 62000,
        faultsInjected: 2,
        invariantResults: [
          { name: "no_writes_outside_sandbox", passed: true },
          { name: "graceful_errors", passed: true },
        ],
      },
    ],
    transcriptPath: "/tmp/test-transcript.jsonl",
    ...overrides,
  };
}

describe("ReportGenerator", () => {
  test("report contains exactly 5 required sections", () => {
    const result = makeResult();
    const report = generateMarkdownReport(result);

    expect(report).toContain("## 1. Executive Summary");
    expect(report).toContain("## 2. Fault Injection Timeline");
    expect(report).toContain("## 3. Agent Performance");
    expect(report).toContain("## 4. Recommendations");
    expect(report).toContain("## 5. Artifacts");
  });

  test("REPORT_SECTIONS constant has 5 entries", () => {
    expect(REPORT_SECTIONS.length).toBe(5);
    expect(REPORT_SECTIONS).toEqual([
      "Executive Summary",
      "Fault Injection Timeline",
      "Agent Performance",
      "Recommendations",
      "Artifacts",
    ]);
  });

  test("executive summary matches simulation data", () => {
    const result = makeResult();
    const report = generateMarkdownReport(result);

    expect(report).toContain("5");  // totalRuns
    expect(report).toContain("4");  // passed
    expect(report).toContain("1");  // failed
    expect(report).toContain("0");  // errors
    expect(report).toContain("80%"); // passRate
  });

  test("fault injection timeline lists all runs", () => {
    const result = makeResult();
    const report = generateMarkdownReport(result);

    // Each run row should be present
    for (let i = 0; i < result.runs.length; i++) {
      expect(report).toContain(`${i + 1}`);
    }
  });

  test("agent performance section shows invariant stats", () => {
    const result = makeResult();
    const report = generateMarkdownReport(result);

    expect(report).toContain("no_writes_outside_sandbox");
    expect(report).toContain("graceful_errors");
  });

  test("recommendations section changes based on pass rate", () => {
    // High pass rate
    const highPass = makeResult({ passRate: 0.95, passed: 19, failed: 1, totalRuns: 20 });
    const highReport = generateMarkdownReport(highPass);
    expect(highReport).toContain("stable");

    // Low pass rate
    const lowPass = makeResult({ passRate: 0.2, passed: 1, failed: 4, totalRuns: 5 });
    const lowReport = generateMarkdownReport(lowPass);
    expect(lowReport).toContain("unreliable");
  });

  test("artifacts section includes transcript path", () => {
    const result = makeResult({ transcriptPath: "/tmp/my-transcript.jsonl" });
    const report = generateMarkdownReport(result);

    expect(report).toContain("/tmp/my-transcript.jsonl");
  });

  test("report includes scenario metadata", () => {
    const result = makeResult();
    const report = generateMarkdownReport(result);

    expect(report).toContain("test-001");     // scenarioId
    expect(report).toContain("Test Scenario"); // scenarioName
    expect(report).toContain("chaos");          // scenarioType
  });

  test("report includes total faults count", () => {
    const result = makeResult();
    const report = generateMarkdownReport(result);

    // Total faults: 2 + 1 + 3 + 1 + 2 = 9
    expect(report).toContain("9");
  });

  test("failed run details are included", () => {
    const result = makeResult();
    const report = generateMarkdownReport(result);

    expect(report).toContain("Invariant violation");
    expect(report).toContain("Hallucinated success");
  });

  test("handles empty runs array", () => {
    const result = makeResult({ runs: [], totalRuns: 0, passed: 0, failed: 0 });
    const report = generateMarkdownReport(result);

    expect(report).toContain("## 1. Executive Summary");
    expect(report).toContain("## 5. Artifacts");
  });

  test("report is valid markdown", () => {
    const result = makeResult();
    const report = generateMarkdownReport(result);

    // Check markdown structure
    expect(report.startsWith("#")).toBe(true);
    expect(report).toContain("|");  // Tables
    expect(report).toContain("---"); // Horizontal rules
  });
});
