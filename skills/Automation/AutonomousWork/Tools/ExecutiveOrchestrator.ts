#!/usr/bin/env bun
/**
 * ExecutiveOrchestrator.ts - Top-level orchestrator for autonomous work
 *
 * Loads queue items, delegates per-item execution to TaskOrchestrator,
 * collects results, and runs spot-checks on Verifier reports.
 *
 * Per-item execution is handled by TaskOrchestrator (dependency injection).
 * In production, builderFn/verifierFn closures call Task(); tests pass mocks.
 *
 * Usage:
 *   bun run ExecutiveOrchestrator.ts run              # Run all ready queue items
 *   bun run ExecutiveOrchestrator.ts spot-check <id>  # Spot-check a verifier report
 *   bun run ExecutiveOrchestrator.ts status           # Show queue status
 */

import { parseArgs } from "util";
import { readFileSync, existsSync } from "fs";
import { WorkQueue, type WorkItem, type EffortLevel } from "./WorkQueue.ts";
import { TaskOrchestrator, type VerifierReport, type LoopResult, type BuilderFn, type VerifierFn } from "./TaskOrchestrator.ts";
import { parseSpec, validateRowCount, type ISCCriterion } from "./SpecParser.ts";
import { extractISC } from "./SpecParser.ts";

// ============================================================================
// Types
// ============================================================================

export interface SpotCheckResult {
  approved: boolean;
  concerns: string[];
  /** Informational signals for Sonnet judgment — do not gate approval */
  signals: string[];
}

export interface ItemRunResult {
  itemId: string;
  title: string;
  loopResult: LoopResult;
}

// ============================================================================
// ExecutiveOrchestrator Class
// ============================================================================

export class ExecutiveOrchestrator {
  private queue: WorkQueue;

  constructor(queue?: WorkQueue) {
    this.queue = queue ?? new WorkQueue();
  }

  // --------------------------------------------------------------------------
  // run() — load ready items, delegate to TaskOrchestrators, collect results
  // --------------------------------------------------------------------------

  /**
   * Run all ready queue items.
   *
   * @param builderFn - Builder function to inject into each TaskOrchestrator
   * @param verifierFn - Verifier function to inject into each TaskOrchestrator
   * @param maxItems - Maximum items to process in this run (default: 5)
   */
  async run(
    _builderFn: BuilderFn,
    _verifierFn: VerifierFn,
    _maxItems: number = 5,
  ): Promise<ItemRunResult[]> {
    throw new Error(
      "ExecutiveOrchestrator.run() is deprecated — use WorkOrchestrator.reportDone(). " +
      "This method bypassed SkepticalVerifier and is no longer safe to call."
    );
  }

  // --------------------------------------------------------------------------
  // spotCheck() — cross-check Verifier report against spec ISC rows
  // --------------------------------------------------------------------------

  /**
   * Spot-check a Verifier report against the spec's ISC rows.
   *
   * Steps:
   *   1. Re-extract ISC rows from the spec independently using SpecParser
   *   2. Select 2-3 rows to scrutinize (random + highest-concern rows)
   *   3. Check selected rows' evidence from the Verifier report
   *   4. For non-TRIVIAL effort: reject if >30% linkedTest is null
   *   5. Flag discrepancies (PASS but no evidence, or linkedTest is null)
   *
   * @param itemId - ID of the work item being spot-checked
   * @param verifierReport - The VerifierReport to scrutinize
   * @param specPath - Path to the spec file for independent ISC extraction
   * @param effort - Effort level (used for linkedTest null ratio check)
   */
  spotCheck(
    itemId: string,
    verifierReport: VerifierReport,
    specPath: string,
    effort: EffortLevel = "STANDARD",
    workingDir?: string,
  ): SpotCheckResult {
    const concerns: string[] = [];

    // Step 1: Re-extract ISC rows from spec independently
    let specExtractedRows: ISCCriterion[] = [];
    if (existsSync(specPath)) {
      const specContent = readFileSync(specPath, "utf-8");
      specExtractedRows = extractISC(specContent);

      // Cross-check: validate row count against raw spec
      const rowWarning = validateRowCount(specContent, specExtractedRows);
      if (rowWarning) {
        concerns.push(`Row count warning: ${rowWarning}`);
      }
    }

    // Step 2: Select 2-3 rows to scrutinize (FAIL-first, fill remaining with random PASS)
    const failRows = verifierReport.rows.filter(r => r.verdict === "FAIL");
    const passRows = verifierReport.rows.filter(r => r.verdict === "PASS");

    const selectedRows: typeof verifierReport.rows[number][] = [];

    // FAIL rows get priority (up to 2)
    selectedRows.push(...failRows.slice(0, 2));

    // Fill remaining slots with random PASS rows to reach 2-3 total
    const targetCount = Math.min(3, failRows.length + passRows.length);
    const remainingSlots = targetCount - selectedRows.length;
    if (remainingSlots > 0 && passRows.length > 0) {
      const shuffled = [...passRows].sort(() => Math.random() - 0.5);
      selectedRows.push(...shuffled.slice(0, remainingSlots));
    }

    // Step 3: Check evidence on selected rows
    for (const row of selectedRows) {
      if (row.verdict === "PASS") {
        // PASS with no evidence is suspicious
        if (!row.evidence || row.evidence.trim().length === 0) {
          concerns.push(
            `ISC #${row.iscId}: PASS verdict but evidence is empty — unverifiable`
          );
        }
        // PASS with null linkedTest is suspicious (no test to back the claim)
        if (row.linkedTest === null) {
          concerns.push(
            `ISC #${row.iscId}: PASS verdict but no linkedTest — cannot verify independently`
          );
        }
      }
    }

    // Step 4: Track linkedTest null ratio as informational signal for Sonnet judgment
    // Not a hard blocker — context-dependent (API work, docs, config may legitimately have no tests)
    const signals: string[] = [];
    if (effort !== "TRIVIAL" && verifierReport.rows.length > 0) {
      const nullLinkedTestCount = verifierReport.rows.filter(r => r.linkedTest === null).length;
      const nullRatio = nullLinkedTestCount / verifierReport.rows.length;

      if (nullRatio > 0.30) {
        signals.push(
          `linkedTest null ratio is ${(nullRatio * 100).toFixed(0)}% (${nullLinkedTestCount}/${verifierReport.rows.length}) — Sonnet should evaluate whether this is expected for the task type`
        );
      }
    }

    // Step 5: Run verification commands for STANDARD+ items
    const isStandardPlus = effort !== "TRIVIAL" && effort !== "QUICK";
    if (isStandardPlus && workingDir && specExtractedRows.length > 0) {
      const suspiciousRows = verifierReport.rows
        .filter(r => r.verdict === "PASS" && r.linkedTest === null);
      const rowsToCheck = suspiciousRows.length > 0
        ? suspiciousRows.slice(0, 2)
        : verifierReport.rows.filter(r => r.verdict === "PASS").slice(0, 2);

      for (const row of rowsToCheck) {
        const specRow = specExtractedRows.find(r => r.number === row.iscId);
        const command = specRow?.embeddedCommand;
        if (command) {
          try {
            const result = Bun.spawnSync(["bash", "-c", command], {
              cwd: workingDir,
              timeout: 30_000,
            });
            if (result.exitCode !== 0) {
              concerns.push(
                `ISC #${row.iscId}: verification command failed (exit ${result.exitCode}): ${command}`
              );
            }
          } catch (e) {
            concerns.push(`ISC #${row.iscId}: verification command error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }

    const approved = concerns.length === 0;
    return { approved, concerns, signals };
  }

  // --------------------------------------------------------------------------
  // status() — return queue status
  // --------------------------------------------------------------------------

  status(): ReturnType<WorkQueue["getStats"]> {
    return this.queue.getStats();
  }
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const { positionals, values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean", short: "j" },
      output: { type: "string" },
      spec: { type: "string" },
      effort: { type: "string" },
      worktree: { type: "string" },
      "verifier-report": { type: "string" },
    },
    allowPositionals: true,
  });

  const cmd = positionals[0];

  if (values.help || !cmd) {
    console.log(`
ExecutiveOrchestrator — Top-level autonomous work orchestrator

Commands:
  run              Run all ready queue items (Builder/Verifier loops)
  spot-check <id>  Spot-check a verifier report for an item
  status           Show queue state
`);
    return;
  }

  const exec = new ExecutiveOrchestrator();

  switch (cmd) {
    case "run": {
      console.log("ExecutiveOrchestrator: run command requires programmatic Builder/Verifier injection.");
      console.log("Use ExecutiveOrchestrator.run(builderFn, verifierFn) in code.");
      break;
    }

    case "spot-check": {
      const id = positionals[1];
      const specPath = values.spec;
      const reportJson = values["verifier-report"];
      if (!id || !specPath || !reportJson) {
        console.error("Usage: spot-check <id> --spec <path> --verifier-report '<json>' [--effort <level>] [--worktree <path>]");
        process.exit(1);
      }
      let report: import("./TaskOrchestrator.ts").VerifierReport;
      try {
        report = JSON.parse(reportJson);
      } catch {
        console.error("Failed to parse --verifier-report JSON");
        process.exit(1);
        return;
      }
      const effort = (values.effort ?? "STANDARD") as import("./WorkQueue.ts").EffortLevel;
      const worktree = values.worktree;
      const result = exec.spotCheck(id, report, specPath, effort, worktree);
      if (values.json || values.output === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result.approved ? `Spot-check APPROVED for ${id}` : `Spot-check REJECTED for ${id}: ${result.concerns.join("; ")}`);
      }
      break;
    }

    case "status": {
      const stats = exec.status();
      if (values.json) {
        console.log(JSON.stringify(stats, null, 2));
      } else {
        console.log(
          `Total: ${stats.total}  Pending: ${stats.pending}  In-Progress: ${stats.inProgress}  ` +
          `Completed: ${stats.completed}  Failed: ${stats.failed}  ` +
          `Blocked: ${stats.blocked}  Ready: ${stats.ready}`
        );
      }
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}. Use --help.`);
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
