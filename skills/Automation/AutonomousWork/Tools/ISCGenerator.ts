/**
 * ISCGenerator.ts — Extracted from WorkOrchestrator.ts
 *
 * ISC row generation from spec files and templates.
 * - generateISC: spec-based (Strategy 1) and template-based (Strategy 2)
 * - templateRows: default ISC rows for items without a spec
 * - normalizeSource: canonicalize ISCRow.source field
 * - inferVerificationCommand: crude dev default when the comprehension omits a verifyCommand
 */

import { existsSync, readFileSync } from "fs";
import type { WorkItem } from "./WorkQueue.ts";
import type { EffortLevel } from "./WorkQueue.ts";
import type { ISCRow, ISCRowDisposition } from "./WorkOrchestrator.ts";
import type { ISCManager } from "./ISCManager.ts";
import { normalizeVerificationCommand } from "./VerificationUtils.ts";
import { comprehendSpec } from "./LLMSpecComprehension.ts";
import type { InferenceFn } from "./SkepticalVerifier.ts";
import type { ComprehendedSpec, ComprehendedRow } from "./Types.ts";

export class ISCGenerator {
  constructor(
    private readonly iscManager: ISCManager,
    private readonly resolveItemCwd: (item: WorkItem) => string,
    private readonly classifyDisposition: (description: string) => ISCRowDisposition,
    private readonly inferenceFn?: InferenceFn,
    private readonly persistComprehendedSpec?: (itemId: string, spec: ComprehendedSpec) => void,
  ) {}

  async generateISC(item: WorkItem, effort: EffortLevel): Promise<ISCRow[]> {
    // Strategy 1: spec-based generation via LLM comprehension
    if (item.specPath && existsSync(item.specPath)) {
      try {
        const specContent = readFileSync(item.specPath, "utf-8");
        const comprehended = await comprehendSpec(specContent, {
          ...(this.inferenceFn ? { inferenceFn: this.inferenceFn } : {}),
          // specId enables Slice-4 fidelity logging on live (non-mock) runs only.
          specId: item.id,
        });

        const itemCwd = this.resolveItemCwd(item);
        const rows: ISCRow[] = comprehended.rows.map((row: ComprehendedRow) => {
          const disposition = (row.humanRequired || row.native)
            ? "human-required" as ISCRowDisposition
            : this.classifyDisposition(row.description);

          // invertExit is the LLM's judgment (comprehension Rule 7): true when the row
          // asserts ABSENCE and the verifyCommand passes by exiting non-zero. Read it
          // off the comprehended row — no description re-scan.
          const invertExit = row.invertExit === true;
          let verification: ISCRow["verification"];
          if (row.verifyCommand !== null) {
            const normalizedCmd = normalizeVerificationCommand(row.verifyCommand, itemCwd);
            verification = {
              method: "command",
              command: normalizedCmd,
              success_criteria: `Verified complete: ${row.description}`,
              ...(invertExit ? { invertExit: true } : {}),
            };
          } else {
            const inferredCmd = this.inferVerificationCommand(row.description, item);
            verification = {
              method: "inferred",
              command: inferredCmd,
              success_criteria: `Verified complete: ${row.description}`,
              ...(invertExit ? { invertExit: true } : {}),
            };
          }

          return {
            id: row.id,
            description: row.description,
            status: "PENDING" as const,
            parallel: false,
            source: "EXPLICIT" as const,
            disposition,
            verification,
          };
        });

        // Persist comprehendedSpec to metadata for downstream consumers
        // (replaces the separate shadow block that's being removed)
        this.persistComprehendedSpec?.(item.id, comprehended);

        return rows;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error(`[ISCGenerator] comprehendSpec failed for "${item.specPath}": ${errMsg}. Returning EXECUTION_FAILED row.`);
        return [{
          id: 1,
          description: `ISC generation failed: comprehendSpec error for "${item.specPath}": ${errMsg}`,
          status: "EXECUTION_FAILED" as const,
          infraFault: true,
          parallel: false,
          source: "INFERRED" as const,
          verification: {
            method: "manual",
            success_criteria: "Spec comprehension must succeed before work can proceed",
          },
        }];
      }
    }

    // Strategy 2: template-based generation (no spec present)
    return this.templateRows(item, effort);
  }

  templateRows(item: WorkItem, effort: EffortLevel): ISCRow[] {
    const rows: ISCRow[] = [];
    if (item.workType === "dev") {
      rows.push({ id: 1, description: "Implement core functionality", status: "PENDING", source: "INFERRED", parallel: false, verification: { method: "test", command: "bun test", success_criteria: "Core tests pass" } });
      rows.push({ id: 2, description: "Add tests and validation", status: "PENDING", source: "INFERRED", parallel: false, verification: { method: "test", command: "bun test", success_criteria: "All tests pass" } });
    } else if (item.workType === "research") {
      rows.push({ id: 1, description: "Gather sources and context", status: "PENDING", source: "INFERRED", parallel: false, verification: { method: "manual", success_criteria: "Sources documented" } });
      rows.push({ id: 2, description: "Synthesize findings", status: "PENDING", source: "INFERRED", parallel: false, verification: { method: "manual", success_criteria: "Synthesis complete" } });
    } else {
      rows.push({ id: 1, description: `Complete: ${item.title}`, status: "PENDING", source: "INFERRED", parallel: false, verification: { method: "manual", success_criteria: "Work completed" } });
    }

    if (effort === "THOROUGH" || effort === "DETERMINED") {
      rows.push({ id: rows.length + 1, description: "Edge case handling and robustness", status: "PENDING", source: "INFERRED", parallel: false, verification: { method: "test", command: "bun test", success_criteria: "Edge cases covered" } });
    }

    return rows;
  }

  normalizeSource(source?: string): ISCRow["source"] {
    if (!source) return undefined;
    const upper = source.toUpperCase().trim();
    if (upper === "EXPLICIT") return "EXPLICIT";
    if (upper === "INFERRED") return "INFERRED";
    if (upper === "IMPLICIT") return "IMPLICIT";
    if (upper === "RESEARCH") return "RESEARCH";
    return undefined;
  }

  /**
   * S5c: the inferVerificationFromSpecContext file-path/TC regex was removed — guessing a
   * verification command from the row description is content-interpretation that the LLM
   * comprehension (which emits a verifyCommand per row) now owns. Only a crude dev default remains.
   */
  inferVerificationCommand(_description: string, item: WorkItem): string | undefined {
    if (item.workType === "dev") return "bun test";
    return undefined;
  }
}
