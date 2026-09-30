/**
 * Verification.ts — per-phase deterministic gate (Gate 1): verifyPhase.
 *
 * Extracted from WorkOrchestrator.ts (S11 decomposition, pass 2). Takes explicit
 * `queue` / `iscManager` / `commandRunner` dependencies plus an injected
 * `markRowsHumanRequired` callback — that helper now lives in PhaseBookkeeping.ts,
 * so verifyPhase calls it via DI rather than reaching into `this`.
 */

import type { WorkQueue, WorkItemMetadata } from "../../WorkQueue.ts";
import type { ISCManager } from "../../ISCManager.ts";
import type { CommandRunner } from "../../CommandRunner.ts";

export interface VerifyPhaseDeps {
  queue: WorkQueue;
  iscManager: ISCManager;
  commandRunner: CommandRunner;
  /** PhaseBookkeeping.ts's markRowsHumanRequired, bound to the orchestrator's iscManager. */
  markRowsHumanRequired: (itemId: string, rowIds: number[]) => void;
}

export interface VerifyPhaseOpts {
  iscRowIds: number[];
  worktreePath: string | undefined;
  workSurface: "browser" | "cli" | "api" | "integration" | "native";
  specPath: string | undefined;
}

export interface VerifyPhaseResult {
  phaseNumber: number;
  passed: boolean;
  evidence: string;
  humanVerificationRequired: boolean;
}

/**
 * Per-phase hard gate (Phase 6: Gate 1, deterministic — no RuntimeVerifier).
 *
 * Runs this phase's declared ISC verify commands before the next phase starts.
 * A definitive non-zero exit fails the phase — the phased loop must NOT call
 * mark-phase-done when this returns `{ passed: false }`. The richer "actually run
 * the artifact" check (dev server, browser, screenshots) now lives only at the
 * item level (Gate 2 / Phase L); the per-phase gate is the deterministic floor.
 *
 * Skip conditions (return { passed: true, evidence: "skipped: <reason>" }):
 *   - item not found in queue
 *   - worktreePath is absent (worktree not yet created, e.g. TRIVIAL item)
 *
 * native surface → the phase's rows are dispositioned `human-required` (ADR-0006)
 * and the phase passes (deferred to a human/device check), never auto-DONE.
 *
 * @param opts.iscRowIds    Row IDs belonging to this phase (drives which verify
 *                          commands run + which rows the native lock dispositions).
 * @param opts.worktreePath Explicit override (falls back to item metadata.worktreePath).
 * @param opts.workSurface  This phase's surface (native triggers the human lock).
 * @param opts.specPath     Optional spec path (reserved; not currently read).
 */
export async function verifyPhase(
  deps: VerifyPhaseDeps,
  itemId: string,
  phaseNumber: number,
  opts: VerifyPhaseOpts,
): Promise<VerifyPhaseResult> {
  const { queue, iscManager, commandRunner, markRowsHumanRequired } = deps;

  // Graceful skip: item not found
  const item = queue.getItem(itemId);
  if (!item) {
    return { phaseNumber, passed: true, evidence: `skipped: item ${itemId} not found in queue`, humanVerificationRequired: false };
  }

  // Graceful skip: no worktree available
  const worktreePath = opts.worktreePath ??
    ((item.metadata as WorkItemMetadata)?.worktreePath as string | undefined);
  if (!worktreePath) {
    return { phaseNumber, passed: true, evidence: `skipped: no worktreePath for item ${itemId} phase ${phaseNumber}`, humanVerificationRequired: false };
  }

  // Resolve this phase's ISC rows. Prefer the explicit phase rows; fall back to ALL
  // the item's rows when the caller (e.g. the CLI gate) didn't pass --phase-rows so
  // native is never silently auto-DONE just because row IDs were omitted (ADR-0006).
  const allRows = iscManager.load(itemId) ?? [];
  const phaseRowIds = opts.iscRowIds.length > 0 ? opts.iscRowIds : allRows.map((r) => r.id);
  const idSet = new Set(phaseRowIds);
  const phaseRows = allRows.filter((r) => idSet.has(r.id));

  // ADR-0006: native UI can't be auto-verified here. Disposition this phase's rows
  // `human-required` so CompletionPipeline routes a jm-task and the item is NEVER
  // auto-DONE without a device check. (Gate 2 / Phase L enforces the same lock at
  // the item level.) The phase itself passes — it is deferred, not failed.
  if (opts.workSurface === "native") {
    if (phaseRowIds.length > 0) markRowsHumanRequired(itemId, phaseRowIds);
    return {
      phaseNumber,
      passed: true,
      evidence: `phase ${phaseNumber}: native surface — deferred to human/device check (rows dispositioned human-required)`,
      humanVerificationRequired: true,
    };
  }

  // Gate 1 (per-phase deterministic floor): run this phase's declared ISC verify
  // commands → exit codes, via the security-gated CommandRunner. A definitive
  // non-zero exit fails the phase; rows with no/unparseable/inconclusive command
  // are skipped (deferred to the item-level gates), neither passing nor failing.
  const ran: string[] = [];
  const failed: string[] = [];
  for (const row of phaseRows) {
    const result = commandRunner.runVerificationCommand(row, worktreePath);
    if (result === null) continue; // no command / unparseable / inconclusive → skip
    ran.push(`#${row.id}`);
    if (result === false) failed.push(`#${row.id} (${row.verification?.command ?? "?"})`);
  }

  if (failed.length > 0) {
    return {
      phaseNumber,
      passed: false,
      evidence: `phase ${phaseNumber} FAILED: ${failed.length} verify command(s) exited non-zero: ${failed.join("; ")}`,
      humanVerificationRequired: false,
    };
  }

  const ranSummary = ran.length > 0
    ? `${ran.length} declared verify command(s) passed (${ran.join(", ")})`
    : "no runnable verify commands for this phase — deferred to the item-level gates";
  return {
    phaseNumber,
    passed: true,
    evidence: `phase ${phaseNumber} passed: ${ranSummary}`,
    humanVerificationRequired: false,
  };
}
