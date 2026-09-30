/**
 * PhaseBookkeeping.ts — phase-level ISC bookkeeping: human-gated phase
 * annotation, mark-phase-done, per-phase ISC filtering/formatting, and the
 * per-phase git summary.
 *
 * Extracted from WorkOrchestrator.ts (S11 decomposition, pass 2). Functions take
 * explicit `queue` / `iscManager` / `loadISC` dependencies (the `loadISC` shape
 * matches the orchestrator's own private `loadISC` semantics — returns
 * `undefined` for empty) rather than reaching into `this`.
 */

import { execFileSync } from "child_process";
import type { WorkQueue } from "../../WorkQueue.ts";
import type { ISCManager } from "../../ISCManager.ts";
import type { ISCRow, PhaseExecutionInfo } from "../../WorkOrchestrator.ts";

/**
 * Annotate each phase with `isHumanGated` = it owns ≥1 `human-required` ISC row
 * (WS2). Pure: mutates and returns the same phases array. `iscRowIds` reference
 * `ISCRow.id` values, matching the persisted rows.
 */
export function annotateHumanGatedPhases(phases: PhaseExecutionInfo[], rows: ISCRow[]): PhaseExecutionInfo[] {
  const humanRowIds = new Set(rows.filter((r) => r.disposition === "human-required").map((r) => r.id));
  for (const phase of phases) {
    phase.isHumanGated = phase.iscRowIds.some((id) => humanRowIds.has(id));
  }
  return phases;
}

/**
 * Format ISC rows as a markdown table with Verification Command column for agent consumption.
 * Optionally filter by phase row IDs.
 */
export function formatISCTableForAgents(
  loadISC: (itemId: string) => ISCRow[] | undefined,
  itemId: string,
  phaseRowIds?: number[],
): string {
  let rows = loadISC(itemId);
  if (!rows || rows.length === 0) return "No ISC rows found.";

  if (phaseRowIds && phaseRowIds.length > 0) {
    const idSet = new Set(phaseRowIds);
    rows = rows.filter((r) => idSet.has(r.id));
  }

  const header = "| ID | Description | Status | Verification Command |";
  const separator = "|----|-------------|--------|---------------------|";
  const lines = rows.map((r) => {
    const cmd = r.verification?.command ? `\`${r.verification.command}\`` : "";
    return `| ${r.id} | ${r.description} | ${r.status} | ${cmd} |`;
  });

  return [header, separator, ...lines].join("\n");
}

/**
 * Disposition the given ISC rows `human-required` (ADR-0006). Used by the
 * native per-phase gate (Verification.ts's verifyPhase): native UI verification
 * can't be automated in this environment, so these rows are routed to a
 * human/device check via CompletionPipeline rather than being silently
 * auto-DONE. Idempotent.
 */
export function markRowsHumanRequired(iscManager: ISCManager, itemId: string, rowIds: number[]): void {
  const rows = iscManager.load(itemId);
  if (!rows || rows.length === 0) return;
  const idSet = new Set(rowIds);
  let changed = false;
  for (const row of rows) {
    if (idSet.has(row.id) && row.disposition !== "human-required") {
      row.disposition = "human-required";
      changed = true;
    }
  }
  if (changed) iscManager.persist(itemId, rows);
}

/** Mark a phase as done. Appends to completedPhases (idempotent), calls markPartial. */
export function markPhaseDone(queue: WorkQueue, itemId: string, phaseNumber: number, totalPhases: number): boolean {
  const item = queue.getItem(itemId);
  if (!item) return false;

  const existing = item.completedPhases ?? [];
  if (!existing.includes(phaseNumber)) {
    existing.push(phaseNumber);
  }

  queue.markPartial(itemId, existing, totalPhases, `Phase ${phaseNumber}/${totalPhases} done`);
  return true;
}

/**
 * Get ISC rows for a specific phase (filtered by row IDs).
 * Used by Orchestrate.md to build per-phase ISC tables.
 */
export function getPhaseISC(
  loadISC: (itemId: string) => ISCRow[] | undefined,
  itemId: string,
  phaseRowIds: number[],
): ISCRow[] {
  const rows = loadISC(itemId);
  if (!rows) return [];
  const idSet = new Set(phaseRowIds);
  return rows.filter((r) => idSet.has(r.id));
}

/** Generate a git summary of prior work in an item's worktree (for PRIOR_WORK context). */
export function generatePhaseGitSummary(
  queue: WorkQueue,
  itemId: string,
  logCaughtError: (itemId: string, location: string, error: unknown) => void,
): string {
  const item = queue.getItem(itemId);
  const wtPath = item?.metadata?.worktreePath as string | undefined;
  if (!wtPath) return "";

  try {
    return execFileSync("git", ["log", "--oneline", "-20"], {
      encoding: "utf-8",
      timeout: 10000,
      cwd: wtPath,
    }).trim();
  } catch (e) {
    logCaughtError(itemId, "generatePhaseGitSummary", e);
    return "";
  }
}
