#!/usr/bin/env bun
/**
 * ReportGenerator.ts - Markdown report generation with exactly 5 sections
 *
 * Generates structured simulation reports:
 *   1. Executive Summary
 *   2. Fault Injection Timeline
 *   3. Agent Performance
 *   4. Recommendations
 *   5. Artifacts
 *
 * All data in the report must match the transcript/results exactly.
 *
 * Usage:
 *   import { generateMarkdownReport } from "./ReportGenerator.ts";
 *   const report = generateMarkdownReport(simulationResult);
 */

// ============================================
// TYPES
// ============================================

export interface RunResult {
  runIndex: number;
  seed?: number;
  status: string;
  duration_ms: number;
  faultsInjected: number;
  invariantResults: Array<{
    name: string;
    passed: boolean;
    details?: string;
  }>;
  agentResponse?: string;
  error?: string;
}

export interface SimulationResult {
  scenarioId: string;
  scenarioName: string;
  scenarioType: string;
  totalRuns: number;
  passed: number;
  failed: number;
  errors: number;
  passRate: number;
  startedAt: string;
  completedAt: string;
  totalDuration_ms: number;
  runs: RunResult[];
  transcriptPath?: string;
}

// ============================================
// CONSTANTS
// ============================================

export const REPORT_SECTIONS: readonly string[] = [
  "Executive Summary",
  "Fault Injection Timeline",
  "Agent Performance",
  "Recommendations",
  "Artifacts",
];

// ============================================
// REPORT GENERATION
// ============================================

export function generateMarkdownReport(result: SimulationResult): string {
  const passRatePct = Math.round(result.passRate * 100);
  const statusLabel = result.passRate >= 0.9
    ? "PASS"
    : result.passRate >= 0.5
      ? "PARTIAL"
      : "FAIL";

  let report = "";

  // --- Header ---
  report += `# Simulation Report: ${result.scenarioName}\n\n`;
  report += `**Status:** ${statusLabel} (${passRatePct}% pass rate)\n`;
  report += `**Scenario ID:** ${result.scenarioId}\n`;
  report += `**Type:** ${result.scenarioType}\n`;
  report += `**Date:** ${result.startedAt}\n\n`;
  report += `---\n\n`;

  // --- Section 1: Executive Summary ---
  report += `## 1. Executive Summary\n\n`;
  report += `| Metric | Value |\n`;
  report += `|--------|-------|\n`;
  report += `| Total Runs | ${result.totalRuns} |\n`;
  report += `| Passed | ${result.passed} |\n`;
  report += `| Failed | ${result.failed} |\n`;
  report += `| Errors | ${result.errors} |\n`;
  report += `| Pass Rate | ${passRatePct}% |\n`;

  if (result.totalRuns > 0) {
    const avgDuration = Math.round(result.totalDuration_ms / result.totalRuns);
    report += `| Total Duration | ${(result.totalDuration_ms / 1000).toFixed(1)}s |\n`;
    report += `| Avg Run Duration | ${avgDuration}ms |\n`;
  }

  report += `\n---\n\n`;

  // --- Section 2: Fault Injection Timeline ---
  report += `## 2. Fault Injection Timeline\n\n`;

  if (result.runs.length > 0) {
    report += `| Run | Status | Duration | Faults Injected | Invariants Passed |\n`;
    report += `|-----|--------|----------|-----------------|-------------------|\n`;

    for (const run of result.runs) {
      const invPassed = run.invariantResults.filter(r => r.passed).length;
      const invTotal = run.invariantResults.length;
      report += `| ${run.runIndex + 1} | ${run.status.toUpperCase()} | ${run.duration_ms}ms | ${run.faultsInjected} | ${invPassed}/${invTotal} |\n`;
    }
  }

  // Total faults count
  const totalFaults = result.runs.reduce((sum, r) => sum + r.faultsInjected, 0);
  report += `\n**Total faults injected across all runs:** ${totalFaults}\n\n`;
  report += `---\n\n`;

  // --- Section 3: Agent Performance ---
  report += `## 3. Agent Performance\n\n`;
  report += `### Invariant Analysis\n\n`;

  const invariantStats: Record<string, { passed: number; failed: number }> = {};
  for (const run of result.runs) {
    for (const inv of run.invariantResults) {
      if (!invariantStats[inv.name]) {
        invariantStats[inv.name] = { passed: 0, failed: 0 };
      }
      if (inv.passed) {
        invariantStats[inv.name].passed++;
      } else {
        invariantStats[inv.name].failed++;
      }
    }
  }

  if (Object.keys(invariantStats).length > 0) {
    report += `| Invariant | Passed | Failed | Rate |\n`;
    report += `|-----------|--------|--------|------|\n`;

    for (const [name, stats] of Object.entries(invariantStats)) {
      const total = stats.passed + stats.failed;
      const rate = total > 0 ? Math.round((stats.passed / total) * 100) : 0;
      report += `| ${name} | ${stats.passed} | ${stats.failed} | ${rate}% |\n`;
    }
  } else {
    report += `No invariants defined for this scenario.\n`;
  }

  // Failed runs detail
  const failedRuns = result.runs.filter(r => r.status !== "pass");
  if (failedRuns.length > 0) {
    report += `\n### Failed Run Details\n\n`;
    for (const run of failedRuns.slice(0, 5)) {
      report += `**Run ${run.runIndex + 1} (${run.status}):**\n`;
      if (run.error) {
        report += `- Error: ${run.error}\n`;
      }
      const failedInvariants = run.invariantResults.filter(r => !r.passed);
      for (const inv of failedInvariants) {
        report += `- Failed: ${inv.name} -- ${inv.details || "No details"}\n`;
      }
      if (run.agentResponse) {
        report += `- Response excerpt: \`${run.agentResponse.slice(0, 200).replace(/`/g, "'")}\`\n`;
      }
      report += `\n`;
    }
  }

  report += `---\n\n`;

  // --- Section 4: Recommendations ---
  report += `## 4. Recommendations\n\n`;

  if (result.passRate >= 0.9) {
    report += `- Agent behavior is stable under test conditions\n`;
    report += `- Consider increasing fault probability to find degradation threshold\n`;
    report += `- Add more invariants to increase test coverage\n`;
  } else if (result.passRate >= 0.5) {
    report += `- Agent shows partial resilience but has failure modes\n`;
    for (const [name, stats] of Object.entries(invariantStats)) {
      if (stats.failed > 0) {
        report += `- **${name}** failed ${stats.failed} times -- investigate and fix\n`;
      }
    }
    report += `- Consider adding retry logic for transient failures\n`;
  } else {
    report += `- Agent behavior is unreliable under these conditions\n`;
    report += `- Priority fix needed for failing invariants before deployment\n`;
    report += `- Review error handling patterns in the target skill\n`;
  }

  report += `\n---\n\n`;

  // --- Section 5: Artifacts ---
  report += `## 5. Artifacts\n\n`;
  report += `| Artifact | Path |\n`;
  report += `|----------|------|\n`;
  report += `| This Report | \`Reports/${result.scenarioId}-*.md\` |\n`;
  report += `| Transcript | \`${result.transcriptPath || "Transcripts/" + result.scenarioId + "-*.jsonl"}\` |\n`;
  report += `| Scenario | \`Scenarios/${result.scenarioId}.yaml\` |\n\n`;
  report += `---\n\n`;
  report += `*Generated by ReportGenerator | ${new Date().toISOString()}*\n`;

  return report;
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "generate": {
      const filePath = args[0];
      if (!filePath) {
        console.error("Usage: generate <results.json>");
        process.exit(1);
      }
      const { readFileSync, existsSync } = await import("fs");
      if (!existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
      }
      const result: SimulationResult = JSON.parse(readFileSync(filePath, "utf-8"));
      const report = generateMarkdownReport(result);
      console.log(report);
      break;
    }

    default:
      console.log(`ReportGenerator - Markdown simulation report generation

Commands:
  generate <results.json>   Generate 5-section Markdown report

Sections: ${REPORT_SECTIONS.join(", ")}`);
      break;
  }
}
