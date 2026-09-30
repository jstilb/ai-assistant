#!/usr/bin/env bun
/**
 * WorkOrchestratorCLI.ts — CLI entry point for WorkOrchestrator.
 *
 * Extracted from WorkOrchestrator.ts to keep the orchestrator class under the
 * ≤1800 line hard floor (ISC Bug 21).
 *
 * All commands delegate to WorkOrchestrator public API.
 */

import { parseArgs } from "util";
import type { TechDebtInput } from "./CompletionPipeline.ts";

/** Parse the --debt-incurred CLI flag (a JSON array of {description, location, category}). Exits 1 on invalid JSON or shape. */
function parseDebtIncurred(raw: string | undefined): TechDebtInput[] | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (e) { console.error(`Invalid --debt-incurred JSON: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
  if (!Array.isArray(parsed)) { console.error("--debt-incurred must be a JSON array"); process.exit(1); }
  const out: TechDebtInput[] = [];
  for (const item of parsed) {
    if (typeof item === "object" && item !== null) {
      const o = item as Record<string, unknown>;
      if (typeof o.description === "string" && typeof o.location === "string" && typeof o.category === "string") {
        out.push({ description: o.description, location: o.location, category: o.category });
        continue;
      }
    }
    console.error("--debt-incurred entries must be objects with string description, location, category");
    process.exit(1);
  }
  return out;
}
import { WorkOrchestrator } from "./WorkOrchestrator.ts";
import { SkepticalVerifier, type InferenceFn } from "./SkepticalVerifier.ts";

/**
 * TEST-ONLY SEAM — KAYA_TEST_SKIP_JUDGE.
 *
 * `verify`/`report-done` run WorkOrchestrator's SkepticalVerifier, whose Gate 3 (the
 * Sonnet LLM judge, ~$0.30, nondeterministic) has no other injection point at this CLI
 * subprocess boundary: `new WorkOrchestrator()` always builds a real `new
 * SkepticalVerifier()`, which makes a real inference call. HeadlessWorkDriver.test.ts
 * spawns THIS FILE as a real `bun WorkOrchestratorCLI.ts` subprocess (see that file's
 * hygiene notes), so it needs a way to force Gate 3 into a deterministic, free stub —
 * without weakening the production path.
 *
 * Setting KAYA_TEST_SKIP_JUDGE=1 swaps in a SkepticalVerifier whose Gate 3 inferenceFn
 * always returns a deterministic PASS, in place of the real inference call. Gate 1
 * (deterministic floor) and Gate 2 (Phase L live exercise) are NOT stubbed — they still
 * run for real against real evidence and can still legitimately FAIL or hard-block Gate
 * 3 (pair with KAYA_LIVE_VERIFY_MODE=self-verify, the existing Gate-2 seam in
 * LiveVerifyContext.ts, to also keep Gate 2 spawn-free).
 *
 * When KAYA_TEST_SKIP_JUDGE is unset (every production/cron invocation), this function
 * returns `new WorkOrchestrator()` — byte-for-byte the same construction as before this
 * seam existed. Nothing in the production driver/cron path ever sets this variable.
 */
function buildOrchestrator(): WorkOrchestrator {
  if (!process.env.KAYA_TEST_SKIP_JUDGE) return new WorkOrchestrator();
  const stubJudgeInferenceFn: InferenceFn = async () => ({
    success: true,
    parsed: { verdict: "PASS", confidence: 1, concerns: [], recommendation: undefined },
  });
  return new WorkOrchestrator(undefined, new SkepticalVerifier({ inferenceFn: stubJudgeInferenceFn }));
}

export async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean", short: "j" },
      "adversarial-concerns": { type: "string" },
      force: { type: "boolean" },
      "phase-rows": { type: "string" },
      output: { type: "string" },
      "debt-incurred": { type: "string" },
      surface: { type: "string" },
      spec: { type: "string" },
      "interactive-session": { type: "boolean" },
    },
    allowPositionals: true,
  });

  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(`
WorkOrchestrator — Unified orchestrator for autonomous work

Commands:
  init                  Validate DAG, load queue, recover orphans
  next-batch [n]        Get ready items (default 5)
  prepare <id>          Classify effort + generate ISC rows
  started <id>          Mark in_progress
  mark-done <id> <rows> Transition ISC rows PENDING→DONE (space-separated row IDs)
  verify <id>           Run verification + review gate
  report-done <id> <rows...> Atomic: mark-done + verify + complete
  complete <id> <rows...>    Alias for report-done (atomic single-process completion)
  retry <id> [err]      Record attempt, reset to pending (escalates after 3)
  fail <id> [err] --force  Force-fail (manual kill only)
  resume-blocked <id> [reason]  Re-pend a real item blocked on a human prereq (NOT resolveBlocked)
  status                Show queue state + blocked items
  report                Structured report (--json for machine-readable)
  recover               Run orphan recovery on stale in_progress items
  verify-phase <id> <phaseNum> --surface <s> [--spec <path>]
                        Per-phase RuntimeVerifier live gate (Slice 4).
                        Outputs { phaseNumber, passed, evidence } JSON.

Options:
  --json                JSON output
  --surface <s>         Work surface for verify-phase (browser|cli|api|integration|native)
  --spec <path>         Optional spec path for verify-phase
  --interactive-session (report-done/complete) Explicit opt-in to bypass the
                        interactive-session-lock defer on this item's auto-merge.
                        DEFAULT false (lock-respecting) — only pass this from an
                        attended Executive run inside Jm's own interactive session
                        (Orchestrate.md). The unattended HeadlessWorkDriver NEVER
                        passes this, so a fresh interactive-session.lock always
                        defers its merges instead of racing live uncommitted work.
  -h, --help            Show help
`);
    return;
  }

  const orch = buildOrchestrator();
  process.on("exit", () => orch.stopMonitoring());
  process.on("SIGINT", () => { orch.stopMonitoring(); process.exit(0); });
  process.on("SIGTERM", () => { orch.stopMonitoring(); process.exit(0); });

  switch (cmd) {
    case "init": {
      try {
        // cross-skill-allowed: self-heal sweep reconciles WorkQueue's approved-work items against QueueRouter's approvals store — WorkQueue/QueueRouter share the single-store pipeline design (ADR-003)
        const { loadQueueItems, appendQueueItem, saveQueueItems } = await import("../../QueueRouter/Tools/QueueManager.ts");
        const approvals = loadQueueItems("approvals");
        const existingIds = new Set(loadQueueItems("approved-work").map(i => i.id));
        const orphans = approvals.filter(i => i.status === "approved" && !existingIds.has(i.id));
        if (orphans.length > 0) {
          for (const item of orphans) {
            const promoted = { ...item, queue: "approved-work", status: "pending" as const, updated: new Date().toISOString(), routing: { ...item.routing, sourceQueue: "approvals", targetQueue: "approved-work" } };
            appendQueueItem("approved-work", promoted);
          }
          saveQueueItems("approvals", approvals.filter(i => !orphans.some(o => o.id === i.id)));
          console.log(`Self-healed: promoted ${orphans.length} orphaned item(s) from approvals → approved-work`);
        }

        const completedWorkIds = new Set(
          orch.getAllQueueItems()
            .filter(i => i.status === "completed")
            .map(i => i.id)
        );
        const freshApprovals = loadQueueItems("approvals");
        const staleApprovals = freshApprovals.filter(
          i => (i.status === "pending" || i.status === "approved") && completedWorkIds.has(i.id)
        );
        if (staleApprovals.length > 0) {
          for (const item of staleApprovals) {
            item.status = "completed";
            item.updated = new Date().toISOString();
            item.result = { completedAt: new Date().toISOString(), completedBy: "WorkOrchestrator/self-heal" };
          }
          saveQueueItems("approvals", freshApprovals);
          console.log(`Self-healed: marked ${staleApprovals.length} approvals item(s) as completed (work already done)`);
        }
      } catch (e) {
        console.error(`[init] Orphan scan failed (non-fatal): ${e instanceof Error ? e.message : e}`);
      }

      const result = await orch.init();
      if (values.json) { console.log(JSON.stringify(result)); } else { console.log(result.message); }
      process.exit(result.success ? 0 : 1);
      break;
    }

    case "next-batch": {
      const n = parseInt(positionals[1]) || 5;
      const result = await orch.nextBatch(n);
      if (values.json) { console.log(JSON.stringify(result)); }
      else {
        if (result.items.length === 0) { console.log(result.blocked > 0 ? `No ready items. ${result.blocked} blocked.` : "No items available."); }
        else { for (const item of result.items) { console.log(`  ${item.id}  ${item.title.slice(0, 50)}`); } }
      }
      break;
    }

    case "prepare": {
      const id = positionals[1];
      if (!id) { console.error("Usage: prepare <id>"); process.exit(1); }
      const result = await orch.prepare(id);
      if (values.json) { console.log(JSON.stringify(result, null, 2)); }
      else { console.log(`${result.success ? "Prepared" : "Failed"}: ${result.iscRows.length} ISC rows, effort ${result.effort}`); }
      process.exit(result.success ? 0 : 1);
      break;
    }

    case "started": {
      const id = positionals[1];
      if (!id) { console.error("Usage: started <id>"); process.exit(1); }
      const ok = orch.started(id);
      if (!ok) { console.log(JSON.stringify({ success: false, error: `Not found: ${id}` })); process.exit(1); }
      try {
        const wt = await orch.ensureFeatureBranch(id);
        console.log(JSON.stringify({ success: true, status: "in_progress", worktreePath: wt.workingDir, worktreeBranch: wt.branch }));
      } catch (e) {
        console.error(`[started] worktree creation failed: ${e instanceof Error ? e.message : String(e)}`);
        console.log(JSON.stringify({ success: true, status: "in_progress", worktreePath: null, worktreeError: String(e) }));
      }
      break;
    }

    case "mark-done": {
      const id = positionals[1];
      if (!id || positionals.length < 3) { console.error("Usage: mark-done <id> <row-ids...>"); process.exit(1); }
      const rowIds = positionals.slice(2).map(Number).filter(n => !isNaN(n));
      const result = orch.iscManager.markDone(id, rowIds);
      if (values.json) { console.log(JSON.stringify(result)); }
      else { console.log(result.success ? `Transitioned rows: ${result.transitioned.join(", ")}` : `Failed: ${result.error}`); }
      process.exit(result.success ? 0 : 1);
      break;
    }

    case "verify": {
      const id = positionals[1];
      if (!id) { console.error("Usage: verify <id>"); process.exit(1); }
      const result = await orch.verify(id);
      if (values.json) { console.log(JSON.stringify(result, null, 2)); }
      else {
        console.log(`Verification: ${result.success ? "PASSED" : "FAILED"}`);
        for (const f of result.failures) { console.log(`  ${f.id}. ${f.description}`); }
      }
      process.exit(result.success ? 0 : 1);
      break;
    }

    case "report-done": {
      const id = positionals[1];
      if (!id || positionals.length < 3) { console.error("Usage: report-done <id> <row-ids...> [--adversarial-concerns 'c1||c2'] [--debt-incurred '[{\"description\":..,\"location\":..,\"category\":..}]']"); process.exit(1); }
      const rowIds = positionals.slice(2).map(Number).filter(n => !isNaN(n));
      const adversarialConcerns = values["adversarial-concerns"]
        ? values["adversarial-concerns"].split("||").map(c => c.trim()).filter(Boolean)
        : undefined;
      const debtIncurred = parseDebtIncurred(values["debt-incurred"]);
      const result = await orch.reportDone(id, {
        completedRowIds: rowIds,
        adversarialConcerns,
        debtIncurred,
      }, { skipSessionLock: values["interactive-session"] === true });
      if (values.json) { console.log(JSON.stringify(result, null, 2)); }
      else { console.log(result.success ? `${id} → completed (verified by skeptical_verifier)` : `Blocked: ${result.reason}`); }
      process.exit(result.success ? 0 : 1);
      break;
    }

    case "complete": {
      // Alias for report-done — atomic single-process read-modify-write
      const id = positionals[1];
      if (!id || positionals.length < 3) { console.error("Usage: complete <id> <row-ids...> [--adversarial-concerns 'c1||c2'] [--debt-incurred '[{\"description\":..,\"location\":..,\"category\":..}]']"); process.exit(1); }
      const rowIds = positionals.slice(2).map(Number).filter(n => !isNaN(n));
      const adversarialConcerns = values["adversarial-concerns"]
        ? values["adversarial-concerns"].split("||").map(c => c.trim()).filter(Boolean)
        : undefined;
      const debtIncurred = parseDebtIncurred(values["debt-incurred"]);
      const result = await orch.reportDone(id, { completedRowIds: rowIds, adversarialConcerns, debtIncurred }, { skipSessionLock: values["interactive-session"] === true });
      if (values.json) { console.log(JSON.stringify(result)); }
      else { console.log(result.success ? `${id} → completed (verified by skeptical_verifier)` : `Blocked: ${result.reason}`); }
      process.exit(result.success ? 0 : 1);
      break;
    }

    case "retry": {
      const id = positionals[1];
      if (!id) { console.error("Usage: retry <id> [err]"); process.exit(1); }
      const result = await orch.retry(id, positionals[2]);
      if (values.json) { console.log(JSON.stringify(result)); }
      else if (!result.retried) { console.log(`Not found: ${id}`); }
      else if (result.escalated) { console.log(`${id} → escalated to human review (attempt ${result.attempt})`); }
      else { console.log(`${id} → retrying (attempt ${result.attempt})`); }
      break;
    }

    case "fail": {
      const id = positionals[1];
      if (!id) { console.error("Usage: fail <id> [err] --force"); process.exit(1); }
      if (!values.force) { console.error("Use 'retry' for normal failures. 'fail' requires --force (manual kill only)."); process.exit(1); }
      console.log(await orch.fail(id, positionals[2]) ? `${id} → failed (forced)` : `Not found: ${id}`);
      break;
    }

    case "resume-blocked": {
      // Re-pend a directly-blocked REAL item once its human PREREQ is satisfied
      // (NOT resolveBlocked, which completes human-PROXY items). Closes the
      // matching manual-<id> escalation LucidTask.
      const id = positionals[1];
      if (!id) { console.error("Usage: resume-blocked <id> [reason]"); process.exit(1); }
      const reason = positionals[2] || "Human prerequisite satisfied";
      try {
        const resumed = await orch.resumeBlocked(id, reason);
        if (!resumed) { console.log(`Not found: ${id}`); process.exit(1); }
        console.log(`${id} → resumed to pending (will run on next next-batch). Reason: ${reason}`);
      } catch (e) {
        console.error(`resume-blocked failed: ${e instanceof Error ? e.message : e}`);
        process.exit(1);
      }
      break;
    }

    case "status": {
      console.log(orch.status());
      break;
    }

    case "report": {
      if (values.json) {
        console.log(JSON.stringify(orch.report(), null, 2));
      } else {
        console.log(orch.reportMarkdown());
      }
      break;
    }

    case "mark-phase-done": {
      const id = positionals[1];
      const phaseNum = parseInt(positionals[2]);
      const total = parseInt(positionals[3]);
      if (!id || isNaN(phaseNum) || isNaN(total)) { console.error("Usage: mark-phase-done <id> <phaseNum> <totalPhases>"); process.exit(1); }
      const ok = orch.markPhaseDone(id, phaseNum, total);
      if (values.json) { console.log(JSON.stringify({ success: ok, itemId: id, phaseNumber: phaseNum, totalPhases: total })); }
      else { console.log(ok ? `Phase ${phaseNum}/${total} marked done for ${id}` : `Failed: item not found ${id}`); }
      process.exit(ok ? 0 : 1);
      break;
    }

    case "format-isc-table": {
      const id = positionals[1];
      if (!id) { console.error("Usage: format-isc-table <id> [--phase-rows 1,2,3]"); process.exit(1); }
      const phaseRowsArg = values["phase-rows" as keyof typeof values] as string | undefined;
      const phaseRowIds = phaseRowsArg ? phaseRowsArg.split(",").map(Number).filter(n => !isNaN(n)) : undefined;
      const table = orch.formatISCTableForAgents(id, phaseRowIds);
      console.log(table);
      break;
    }

    case "recover": {
      const result = await orch.init();
      if (values.json) { console.log(JSON.stringify({ recovered: result.recovered })); }
      else { console.log(`Recovered ${result.recovered} orphaned items`); }
      break;
    }

    case "verify-phase": {
      const id = positionals[1];
      const phaseNum = parseInt(positionals[2]);
      if (!id || isNaN(phaseNum)) {
        console.error("Usage: verify-phase <id> <phaseNum> --surface <browser|cli|api|integration|native> [--phase-rows 1,2,3] [--spec <path>]");
        process.exit(1);
      }
      const surfaceArg = values["surface" as keyof typeof values] as string | undefined;
      const validSurfaces = ["browser", "cli", "api", "integration", "native"] as const;
      if (!surfaceArg || !validSurfaces.includes(surfaceArg as (typeof validSurfaces)[number])) {
        console.error(`--surface is required and must be one of: ${validSurfaces.join(", ")}`);
        process.exit(1);
      }
      const surface = surfaceArg as "browser" | "cli" | "api" | "integration" | "native";
      const specPath = values["spec" as keyof typeof values] as string | undefined;
      // Phase row IDs: required for the native gate so verifyPhase can disposition
      // this phase's rows `human-required` (ADR-0006). Without them, verifyPhase
      // falls back to ALL the item's rows so native is never silently auto-DONE.
      const phaseRowsArg = values["phase-rows" as keyof typeof values] as string | undefined;
      const iscRowIds = phaseRowsArg
        ? phaseRowsArg.split(",").map(Number).filter(n => !isNaN(n))
        : [];

      // Resolve worktreePath from item metadata — CLI does not accept it as a flag
      // (the orchestrator reads it from queue item metadata set during `started`)
      const item = orch.queue.getItem(id);
      const worktreePath = item?.metadata?.worktreePath as string | undefined;

      const phaseResult = await orch.verifyPhase(id, phaseNum, {
        iscRowIds,
        worktreePath,
        workSurface: surface,
        specPath,
      });

      if (values.json || values["output" as keyof typeof values] === "json") {
        console.log(JSON.stringify(phaseResult));
      } else {
        const status = phaseResult.passed ? "PASSED" : "FAILED";
        console.log(`Phase ${phaseResult.phaseNumber} gate: ${status}`);
        console.log(`Evidence: ${phaseResult.evidence}`);
      }
      process.exit(phaseResult.passed ? 0 : 1);
      break;
    }

    default:
      console.error(`Unknown: ${cmd}. Use --help.`);
      process.exit(1);
  }
}

if (import.meta.main) main().catch(console.error);
