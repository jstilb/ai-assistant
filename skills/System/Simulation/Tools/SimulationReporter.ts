#!/usr/bin/env bun
/**
 * SimulationReporter.ts - Structured report generation from simulation results
 *
 * Generates Markdown reports with exactly 5 sections:
 * 1. Executive Summary
 * 2. Fault Injection Timeline
 * 3. Agent Performance
 * 4. Recommendations
 * 5. Artifacts
 *
 * All state persistence via StateManager.
 *
 * Usage:
 *   bun SimulationReporter.ts report <simulation-id>
 *   bun SimulationReporter.ts report-from-file <results.json>
 *   bun SimulationReporter.ts export-evals <simulation-id>
 *   bun SimulationReporter.ts list
 */

import { existsSync, mkdirSync, readdirSync, appendFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { createStateManager } from "../../../../lib/core/StateManager.ts";
import { exportToEvalsSuite } from "./EvalsIntegration.ts";
import { emitInsight, emitEvalSignal, emitNotification } from "../../../../lib/core/SkillIntegrationBridge";

const KAYA_HOME = process.env.HOME + "/.claude";
const REPORTS_DIR = join(KAYA_HOME, "skills/System/Simulation/Reports");
const TRANSCRIPTS_DIR = join(KAYA_HOME, "skills/System/Simulation/Transcripts");
const STATE_PATH = join(KAYA_HOME, "skills/System/Simulation/state/reports-state.json");

// --- Types ---

interface RunResult {
  runIndex: number;
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
  seed?: number;
}

interface SimulationResult {
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
  summary: string;
  transcriptPath?: string;
  reportPath?: string;
}

// --- StateManager ---

const ReportsRegistrySchema = z.object({
  reports: z.record(z.string(), z.object({
    scenarioId: z.string(),
    scenarioName: z.string(),
    passRate: z.number(),
    totalRuns: z.number(),
    reportPath: z.string(),
    createdAt: z.string(),
  })),
});

const stateManager = createStateManager({
  path: STATE_PATH,
  schema: ReportsRegistrySchema,
  defaults: { reports: {} },
});

// --- Report Generation ---

function generateReport(result: SimulationResult): string {
  const statusLabel = result.passRate >= 0.9 ? "PASS" : result.passRate >= 0.5 ? "PARTIAL" : "FAIL";
  const passRatePct = Math.round(result.passRate * 100);

  let report = `# Simulation Report: ${result.scenarioName}

**Status:** ${statusLabel} (${passRatePct}% pass rate)
**Scenario ID:** ${result.scenarioId}
**Type:** ${result.scenarioType}
**Date:** ${new Date(result.startedAt).toLocaleDateString()}

---

## 1. Executive Summary

| Metric | Value |
|--------|-------|
| Total Runs | ${result.totalRuns} |
| Passed | ${result.passed} |
| Failed | ${result.failed} |
| Errors | ${result.errors} |
| Pass Rate | ${passRatePct}% |
| Total Duration | ${(result.totalDuration_ms / 1000).toFixed(1)}s |
| Avg Run Duration | ${Math.round(result.totalDuration_ms / result.totalRuns)}ms |

${result.summary}

---

## 2. Fault Injection Timeline

| Run | Status | Duration | Faults Injected | Invariants Passed |
|-----|--------|----------|-----------------|-------------------|
`;

  for (const run of result.runs) {
    const invPassed = run.invariantResults.filter((r) => r.passed).length;
    const invTotal = run.invariantResults.length;
    report += `| ${run.runIndex + 1} | ${run.status.toUpperCase()} | ${run.duration_ms}ms | ${run.faultsInjected} | ${invPassed}/${invTotal} |\n`;
  }

  // Fault type breakdown
  const faultCounts: Record<string, number> = {};
  let totalFaults = 0;
  for (const run of result.runs) {
    totalFaults += run.faultsInjected;
  }

  report += `
**Total faults injected across all runs:** ${totalFaults}

---

## 3. Agent Performance

### Invariant Analysis

`;

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
  const failedRuns = result.runs.filter((r) => r.status !== "pass");
  if (failedRuns.length > 0) {
    report += `\n### Failed Run Details\n\n`;

    for (const run of failedRuns.slice(0, 5)) {
      report += `**Run ${run.runIndex + 1} (${run.status}):**\n`;

      if (run.error) {
        report += `- Error: ${run.error}\n`;
      }

      const failedInvariants = run.invariantResults.filter((r) => !r.passed);
      if (failedInvariants.length > 0) {
        for (const inv of failedInvariants) {
          report += `- Failed: ${inv.name} — ${inv.details || "No details"}\n`;
        }
      }

      if (run.agentResponse) {
        report += `- Response excerpt: \`${run.agentResponse.slice(0, 200).replace(/`/g, "'")}\`\n`;
      }
      report += `\n`;
    }
  }

  // --- Section 4: Recommendations ---
  report += `---

## 4. Recommendations

`;

  if (result.passRate >= 0.9) {
    report += `- Agent behavior is stable under test conditions\n`;
    report += `- Consider increasing fault probability to find degradation threshold\n`;
    report += `- Add more invariants to increase test coverage\n`;
  } else if (result.passRate >= 0.5) {
    report += `- Agent shows partial resilience but has failure modes\n`;
    for (const [name, stats] of Object.entries(invariantStats)) {
      if (stats.failed > 0) {
        report += `- **${name}** failed ${stats.failed} times — investigate and fix\n`;
      }
    }
    report += `- Consider adding retry logic for transient failures\n`;
  } else {
    report += `- Agent behavior is unreliable under these conditions\n`;
    report += `- Priority fix needed for failing invariants before deployment\n`;
    report += `- Review error handling patterns in the target skill\n`;
  }

  // --- Section 5: Artifacts ---
  report += `
---

## 5. Artifacts

| Artifact | Path |
|----------|------|
| This Report | \`${REPORTS_DIR}/${result.scenarioId}-*.md\` |
| Transcript | \`${result.transcriptPath || TRANSCRIPTS_DIR + "/" + result.scenarioId + "-*.jsonl"}\` |
| Scenario | \`Scenarios/${result.scenarioId}.yaml\` |

---

*Generated by SimulationReporter | ${new Date().toISOString()}*
`;

  return report;
}

function exportToEvals(result: SimulationResult): Record<string, unknown> {
  return {
    suite: {
      id: `sim-${result.scenarioId}`,
      name: `Simulation: ${result.scenarioName}`,
      description: `Auto-generated from simulation ${result.scenarioId}`,
      tasks: result.runs.map((run) => ({
        id: `sim-run-${run.runIndex}`,
        input: `Simulation run ${run.runIndex + 1}`,
        expected: "pass",
        actual: run.status,
        score: run.status === "pass" ? 1 : 0,
        metadata: {
          faultsInjected: run.faultsInjected,
          invariants: run.invariantResults,
        },
      })),
    },
    metrics: {
      pass_at_1: result.passRate,
      total: result.totalRuns,
      passed: result.passed,
      failed: result.failed,
    },
  };
}

async function findResult(simulationId: string): Promise<SimulationResult | null> {
  if (!existsSync(REPORTS_DIR)) return null;

  const files = readdirSync(REPORTS_DIR).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    if (file.startsWith(simulationId) || file.includes(simulationId)) {
      try {
        const { readFileSync } = await import("fs");
        const content = readFileSync(join(REPORTS_DIR, file), "utf-8");
        return JSON.parse(content);
      } catch { continue; }
    }
  }
  return null;
}

async function saveReport(result: SimulationResult, report: string): Promise<string> {
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });

  const reportPath = join(REPORTS_DIR, `${result.scenarioId}-${Date.now()}.md`);
  const { writeFileSync } = await import("fs");
  writeFileSync(reportPath, report);

  // Register in state
  await stateManager.update((s) => ({
    reports: {
      ...s.reports,
      [`${result.scenarioId}-${Date.now()}`]: {
        scenarioId: result.scenarioId,
        scenarioName: result.scenarioName,
        passRate: result.passRate,
        totalRuns: result.totalRuns,
        reportPath,
        createdAt: new Date().toISOString(),
      },
    },
  }));

  // Phase 3: Integration Backbone - Emit insight to MemoryStore
  await emitInsight({
    source: 'Simulation',
    type: 'research',
    category: 'simulation_result',
    title: `Simulation ${result.scenarioId}: ${result.passed}/${result.totalRuns} passed`,
    content: report,
    tags: ['simulation', 'pattern', 'fault-resilience', result.scenarioType, result.scenarioId],
    tier: 'warm',
    metadata: {
      scenarioId: result.scenarioId,
      scenarioType: result.scenarioType,
      passRate: result.passRate,
      totalRuns: result.totalRuns,
      faultsInjected: result.runs.reduce((sum, r) => sum + r.faultsInjected, 0),
    },
  }).catch(err => console.error('[SimulationReporter] Failed to emit insight:', err));

  // Emit eval signals for invariant violations
  for (const run of result.runs) {
    const failedInvariants = run.invariantResults.filter(inv => !inv.passed);
    for (const violation of failedInvariants) {
      await emitEvalSignal({
        source: 'Simulation',
        signalType: 'failure',
        description: `Invariant "${violation.name}" failed: ${violation.details || 'No details'}`,
        category: 'behavioral_invariant',
        severity: 'high',
        rawData: {
          scenarioId: result.scenarioId,
          runIndex: run.runIndex,
          invariant: violation.name,
          details: violation.details,
          faultsInjected: run.faultsInjected,
        },
      }).catch(err => console.error('[SimulationReporter] Failed to emit eval signal:', err));
    }
  }

  // Auto-export to Evals suite for regression testing
  try {
    const exported = await exportToEvalsSuite(result);
    console.error(`[SimulationReporter] Exported ${exported.testCount} test cases to ${exported.suitePath}`);
  } catch (err) {
    console.error('[SimulationReporter] Failed to export evals suite:', err instanceof Error ? err.message : String(err));
  }

  // Emit notification on completion
  const statusEmoji = result.passRate >= 0.9 ? '✅' : result.passRate >= 0.5 ? '⚠️' : '❌';
  emitNotification(
    `${statusEmoji} Simulation complete: ${result.passed}/${result.totalRuns} passed for ${result.scenarioId}`,
    { agentName: 'Simulation', priority: result.passRate < 0.5 ? 'high' : 'normal' }
  );

  return reportPath;
}

// --- CLI ---

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!existsSync(REPORTS_DIR)) {
    mkdirSync(REPORTS_DIR, { recursive: true });
  }

  switch (command) {
    case "report": {
      const simId = args[0];
      if (!simId) { console.error("Usage: report <simulation-id>"); process.exit(1); }

      const result = await findResult(simId);
      if (!result) { console.error(`Simulation result not found: ${simId}`); process.exit(1); }

      const report = generateReport(result);
      const reportPath = await saveReport(result, report);
      console.log(report);
      console.error(`Report saved to ${reportPath}`);
      break;
    }

    case "report-from-file": {
      const filePath = args[0];
      if (!filePath || !existsSync(filePath)) {
        console.error("Usage: report-from-file <results.json>");
        process.exit(1);
      }

      const { readFileSync } = await import("fs");
      const result: SimulationResult = JSON.parse(readFileSync(filePath, "utf-8"));
      const report = generateReport(result);
      console.log(report);
      break;
    }

    case "export-evals": {
      const simId = args[0];
      const suiteName = args[1]; // Optional suite name
      if (!simId) { console.error("Usage: export-evals <simulation-id> [suite-name]"); process.exit(1); }

      const result = await findResult(simId);
      if (!result) { console.error(`Simulation result not found: ${simId}`); process.exit(1); }

      // Use the new exportToEvalsSuite function
      const exported = await exportToEvalsSuite(result, suiteName);
      console.log(JSON.stringify({
        success: true,
        suitePath: exported.suitePath,
        testCount: exported.testCount,
        message: `Exported ${exported.testCount} test cases to ${exported.suitePath}`,
      }, null, 2));
      break;
    }

    case "list": {
      const files = existsSync(REPORTS_DIR)
        ? readdirSync(REPORTS_DIR).filter((f) => f.endsWith(".json"))
        : [];
      const reports = [];
      for (const f of files) {
        try {
          const { readFileSync } = await import("fs");
          const r: SimulationResult = JSON.parse(readFileSync(join(REPORTS_DIR, f), "utf-8"));
          reports.push({
            file: f,
            scenarioId: r.scenarioId,
            scenarioName: r.scenarioName,
            passRate: `${Math.round(r.passRate * 100)}%`,
            runs: r.totalRuns,
            date: r.startedAt,
          });
        } catch {
          reports.push({ file: f, error: "Could not parse" });
        }
      }
      console.log(JSON.stringify(reports, null, 2));
      break;
    }

    default:
      console.log(`SimulationReporter - Structured report generation

Commands:
  report <simulation-id>              Generate 5-section Markdown report
  report-from-file <results.json>     Report from result file
  export-evals <simulation-id>        Export to Evals format
  list                                 List available reports

Report sections: Executive Summary, Fault Injection Timeline, Agent Performance, Recommendations, Artifacts`);
      break;
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

export { generateReport, exportToEvals, findResult, saveReport };
export type { SimulationResult, RunResult };
