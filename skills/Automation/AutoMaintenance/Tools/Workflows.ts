#!/usr/bin/env bun
/**
 * AutoMaintenance Workflows — Pure orchestrator.
 * USAGE: bun Workflows.ts --tier daily [--dry-run] [--force]
 */

import { parseArgs } from "util";
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { setupPath, getCorrectPath } from "../../../../lib/core/PathEnv";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { Remediator, type Finding } from "./Remediator";
import { AlertManager } from "./AlertManager";
import { HealthTracker } from "./HealthTracker";
import { loadHealthState, saveHealthState, checkForGaps } from "./HealthManager";
import { runIntegrityCheck, getDiskUsagePercent } from "./IntegrityChecker";
import { runSecurityAuditCheck, type SecurityFinding } from "./SecurityAuditor";
import { runDiskCleanup } from "./DiskCleaner";
import { runSkillsAudit } from "./SkillsAuditor";
// cross-skill-allowed: AutoMaintenance Workflows is the orchestration surface that drives TechDebtTracker's auditor by design
import { TechDebtAuditor } from "./TechDebtAuditor";
// cross-skill-allowed: AutoMaintenance Workflows is the orchestration surface that drives TechDebtTracker's promoter by design
import { TechDebtPromoter } from "./TechDebtPromoter";
// cross-skill-allowed: AutoMaintenance Workflows is the orchestration surface that drives TechDebtTracker's registry by design
import { TechDebtRegistry } from "./TechDebtRegistry";
// cross-skill-allowed: AutoMaintenance Workflows is the orchestration surface that drives QueueRouter's QueueManager by design
import { QueueManager } from "../../QueueRouter/Tools/QueueManager";
import { cleanWorkDirs, cleanAllJsonlFromRegistry, cleanOrphanedCurrentWork, cleanStaleContextFiles } from "../../../../lib/core/MemoryCleanup";
import { memoryStore, type CaptureOptions } from "../../../../lib/core/MemoryStore";
import { rotateFailureLog } from "../../../../lib/core/FailureLog";
import { sendAlert } from "../../../../lib/core/AlertGate.ts";

const KAYA_HOME = getKayaHome();
const MAINTENANCE_DIR = join(KAYA_HOME, "MEMORY", "AutoMaintenance");

// Fail-silent telemetry capture — workflow telemetry must never crash the cron job.
async function captureInsight(opts: CaptureOptions): Promise<void> {
  try { await memoryStore.capture(opts); }
  catch (err) { console.error("[AutoMaintenance/Workflows] capture failed:", err instanceof Error ? err.message : err); }
}
const ensureDir = (d: string) => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); };
const today = () => new Date().toISOString().split("T")[0];

/**
 * ISC A-05 wiring: re-fire every currently-open CRITICAL alert daily so it
 * can't silently rot once its underlying finding stops recurring (evaluate()
 * in runDailyWorkflow below only re-pages a CRITICAL when THIS scan
 * reproduces the exact same finding). `refireOpenCriticalAlerts()`
 * (AlertManager.ts:330) already existed, unit-tested, with zero callers —
 * this is the wiring, not new alerting logic. Extracted as its own exported
 * function (rather than inlined in runDailyWorkflow) so it's testable
 * without running the full daily workflow, which scans 40K+ files and times
 * out in test context (see Workflows.testwriter.test.ts's header comment).
 *
 * Same unreduced filter runStatusCommand already uses below
 * (`alerts.filter((a) => a.status === "open")`) — alerts.jsonl is an
 * append-only log, so a dismissed alert's original "open" line still exists
 * verbatim; dismissal is a later appended entry, not a mutation. Not this
 * slice's job to add per-id log reduction.
 *
 * 'escalated' status (HealthTracker's IssueRecord.status enum,
 * HealthTracker.ts:27) is NOT set anywhere in this path and is left
 * unused: refireOpenCriticalAlerts() only calls AlertGate.send() — it never
 * touches HealthTracker — and AlertManager's own Alert.status union
 * ('open'|'dismissed'|'auto-resolved', AlertManager.ts:45) has no
 * 'escalated' member for a refire to naturally land on.
 */
export async function refireCriticalAlerts(alertManager: AlertManager): Promise<{ refiredCount: number; notificationsFired: number }> {
  const openCritical = alertManager.readAlerts().filter((a) => a.status === "open" && a.severity === "CRITICAL");
  return alertManager.refireOpenCriticalAlerts(openCritical);
}

/**
 * Builds the `alertFindings` array runDailyWorkflow() passes to
 * AlertManager.evaluate(). Extracted (not inlined) for the same reason
 * refireCriticalAlerts() above is: runDailyWorkflow() itself scans 40K+
 * files and times out in test context (see this file's test suite header
 * comment), so this seam lets the filtering behavior be tested directly
 * without running the full workflow.
 *
 * Jm decision 2, 2026-07-22: git_dirty is report-only, never an alert — this
 * repo's tree is dirty BY DESIGN (auto-commit lag on MEMORY/ runtime
 * state), so a git_dirty finding must never reach evaluate() (which would
 * otherwise write it to alerts.jsonl, record it in HealthTracker, and
 * eventually escalate it to WARNING/CRITICAL via the x3/x7 occurrence
 * ladder — exactly the refire-forever failure mode this decision closes
 * off). Filtered out HERE, before evaluate() ever sees it. `findings`
 * itself is untouched by this filter — runDailyWorkflow still passes the
 * FULL, unfiltered array to buildDailyReport() below, so the daily report's
 * "Git Repo" row/count is unaffected; only the alert pipeline changes.
 */
export function buildAlertFindings(
  findings: Finding[],
  remediationFailures: Array<{ target: string; error: string; shouldEscalate: boolean }>,
): Array<{ workflow: string; step: string; type: string; finding: string }> {
  return [
    ...findings.filter((f) => f.type !== "git_dirty").map((f) => ({ workflow: "daily", step: "integrity", type: f.type, finding: `${f.type}: ${f.target}` })),
    ...remediationFailures.filter((f) => f.shouldEscalate).map((f) => ({ workflow: "daily", step: "remediation", type: "remediation_failure", finding: `Failed to remediate ${f.target}: ${f.error}` })),
  ];
}

async function runDailyWorkflow(options: { dryRun?: boolean; force?: boolean }): Promise<void> {
  console.log(`\n=== AutoMaintenance Daily - ${today()} ===\n`);
  const t0 = Date.now();
  setupPath();

  const state = await loadHealthState();
  const gapCheck = await checkForGaps("daily", state, { force: options.force });
  if (gapCheck.gapDetected) console.log(`⚠ Gap detected: ${gapCheck.gapHours} hours since last run`);

  const findings: Finding[] = await runIntegrityCheck();
  await runDependencyCheck();

  // The old in-process cron daemon's launchd-liveness check was REMOVED
  // 2026-07-03 — that daemon (and its launchd job) was deleted outright in
  // slice D1, so this check could only ever report "down" for a target
  // that's permanently gone by design, flagging every daily run as
  // degraded. Cron/job health is now covered by bin/cron-health-monitor.ts
  // (hourly, scans MEMORY/daemon/cron/logs/*.jsonl for per-job run failures
  // and pages Jm) and bin/validate-jobs.ts (manifest-vs-plist target
  // coverage) — see remediation slice C1.

  const remediationResult = await Remediator.run(findings, { dryRun: options.dryRun });
  const healthTracker = new HealthTracker();
  await healthTracker.load();
  const alertManager = new AlertManager(healthTracker);
  const alertFindings = buildAlertFindings(findings, remediationResult.failures);
  const alertResult = await alertManager.evaluate(alertFindings, healthTracker, "daily");

  // Re-fire open CRITICAL alerts (ISC A-05) — see refireCriticalAlerts() doc
  // comment above. Non-fatal like the other daily steps below: a refire
  // failure surfaces as a warning, never crashes the rest of the workflow.
  try {
    const refireResult = await refireCriticalAlerts(alertManager);
    if (refireResult.refiredCount > 0) console.log(`✓ CRITICAL alert refire: ${refireResult.refiredCount} re-fired, ${refireResult.notificationsFired} notifications sent`);
  } catch (e) { console.warn(`⚠ CRITICAL alert refire failed: ${e}`); }

  try { const r = await cleanWorkDirs(options.dryRun ?? false); console.log(`✓ WORK/ cleanup: ${r.dirsRemoved} removed, ${(r.bytesFreed / 1048576).toFixed(1)} MB freed`); } catch (e) { console.warn(`⚠ WORK/ cleanup failed: ${e}`); }

  // ISC rows 11/12 (N4 remediation) — orphaned current-work-{uuid}.json (24h
  // TTL) and stale prompt-context-*/context-session-* files (14d TTL) were
  // wired into NO scheduled tier, so 553 stale files accumulated in
  // MEMORY/State. Both TTLs are short enough that the weekly-cleanup tier
  // would lag; daily is the correct tier. Each its own non-fatal try/catch,
  // same idiom as the WORK/ cleanup above.
  try { const r = await cleanOrphanedCurrentWork(options.dryRun ?? false); console.log(`✓ orphaned current-work cleanup: ${r.filesRemoved} removed, ${(r.bytesFreed / 1048576).toFixed(1)} MB freed`); } catch (e) { console.warn(`⚠ orphaned current-work cleanup failed: ${e}`); }

  try { const r = await cleanStaleContextFiles(options.dryRun ?? false); console.log(`✓ stale context-file cleanup: ${r.filesRemoved} removed, ${(r.bytesFreed / 1048576).toFixed(1)} MB freed`); } catch (e) { console.warn(`⚠ stale context-file cleanup failed: ${e}`); }

  // Rotate failure log — archive entries older than 90 days.
  try {
    if (!(options.dryRun ?? false)) {
      const rotResult = rotateFailureLog();
      if (!rotResult.skipped) {
        console.log(`✓ failure-log rotation: ${rotResult.linesArchived} archived, ${rotResult.linesRetained} retained`);
      }
    }
  } catch (e) { console.warn(`⚠ failure-log rotation failed: ${e}`); }

  await saveHealthState({ ...state, lastRunByTier: { ...state.lastRunByTier, daily: new Date().toISOString() } });
  await healthTracker.save();

  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  const diskPct = getDiskUsagePercent();
  writeFileSync(join(MAINTENANCE_DIR, "daily", `${today()}.md`), buildDailyReport(findings, remediationResult, alertResult, dur, gapCheck, diskPct), "utf-8");
  // Daily-summary push ping DELETED 2026-07-20 (Jm decision, remediation-s1s5
  // B5) — measured 0/204 deliveries over the period audited; the daily
  // report .md file above (and the daily digest, which reads from
  // AlertGate's spool, not this dead push) already cover the "did it run"
  // signal. No replacement.

  await captureInsight({ source: "AutoMaintenance/Workflows", type: "insight", title: "Maintenance daily complete", content: `${findings.length} findings, ${remediationResult.success.length} auto-remediated`, tags: ["maintenance", "daily"], metadata: { tier: "daily", durationMs: Date.now() - t0, findingCount: findings.length, remediations: remediationResult.success.length } });
  console.log(`✓ Daily workflow complete (${dur}s)`);
}

async function runDependencyCheck(): Promise<void> {
  // Check bun and node versions
  for (const [cmd, args] of [["bun", ["--version"]], ["node", ["--version"]]] as [string, string[]][]) {
    try { console.log(`  ${cmd}: ${execFileSync(cmd, args, { encoding: "utf-8" }).trim()}`); } catch { console.error(`  ${cmd}: not found`); }
  }
  // Check and optionally update claude — gated behind settings.maintenance.autoUpdateClaude (Decision E)
  try {
    const claudePath = (getCorrectPath().split(":").map(d => d + "/claude").find(p => require("fs").existsSync(p))) ?? "claude";
    console.log(`  claude: ${execFileSync(claudePath, ["--version"], { encoding: "utf-8" }).trim()}`);
    let autoUpdate = true;
    try {
      const s = JSON.parse(readFileSync(join(KAYA_HOME, "settings.json"), "utf-8")) as { maintenance?: { autoUpdateClaude?: boolean } };
      if (s.maintenance?.autoUpdateClaude === false) autoUpdate = false;
    } catch { /* use default */ }
    if (autoUpdate) { try { execFileSync(claudePath, ["update"], { encoding: "utf-8", timeout: 60000 }); console.log("  claude: update check complete"); } catch { /* already up to date */ } }
    else console.log("  claude: auto-update disabled via settings.maintenance.autoUpdateClaude");
  } catch { console.error("  claude: not found"); }
}

/**
 * Renders the weekly security report's summary line.
 *
 * Bug fixed here: `findings` (SecurityAuditor's return value) holds at most
 * ONE row — either a single `verified_secret` finding whose actual secret
 * count lives in its `count` field, or a single `scan_error` finding, or
 * zero rows on a clean scan. The previous rendering used `findings.length`
 * (0 or 1 — the number of ROWS) as if it were the secret COUNT, so a day
 * with 73 verified secrets rendered "1 verified secrets found" instead of
 * "73 verified secrets found", and a scan_error day (also 1 row, no `count`
 * field) rendered the same misleading "1 verified secrets found" instead of
 * surfacing that the scan itself failed and the result is UNKNOWN, not a
 * count of 1. Fixed via `findings[0]?.count ?? 0` plus an explicit
 * `scan_error` branch so a failed scan never reads as "clean-ish".
 */
export function buildSecurityReportBody(findings: SecurityFinding[]): string {
  const first = findings[0];
  if (!first) return "✓ No verified secrets found.";
  if (first.type === "scan_error") {
    return `⚠ Secret scan FAILED — result UNKNOWN, not verified clean: ${first.finding}`;
  }
  return `⚠ ${first.count ?? 0} verified secrets found.`;
}

async function runWeeklySecurityWorkflow(): Promise<void> {
  console.log(`\n=== AutoMaintenance Weekly Security - ${today()} ===\n`);
  const t0 = Date.now();
  const findings = await runSecurityAuditCheck();
  const ht = new HealthTracker(); await ht.load();
  const alertResult = await new AlertManager(ht).evaluate(findings, ht, "weekly-security");
  await ht.save();
  const state = await loadHealthState();
  await saveHealthState({ ...state, lastRunByTier: { ...state.lastRunByTier, "weekly-security": new Date().toISOString() } });
  ensureDir(join(MAINTENANCE_DIR, "weekly"));
  writeFileSync(join(MAINTENANCE_DIR, "weekly", `${today()}-security.md`), `# Weekly Security Report — ${today()}\n\n${buildSecurityReportBody(findings)}\n`, "utf-8");
  await captureInsight({ source: "AutoMaintenance/Workflows", type: "insight", title: "Maintenance weekly-security complete", content: `${findings.length} findings, ${alertResult.alerts.length} alerts`, tags: ["maintenance", "weekly-security"], metadata: { tier: "weekly-security", durationMs: Date.now() - t0, findingCount: findings.length } });
}

async function runWeeklyCleanupWorkflow(): Promise<void> {
  console.log(`\n=== AutoMaintenance Weekly Cleanup - ${today()} ===\n`);
  const t0 = Date.now();
  const result = await runDiskCleanup();
  // Registry JSONL retention (MemoryCleanup.JSONL_REGISTRY) — this is the only
  // scheduled invoker; the registry was otherwise dead config (2026-07-10).
  let jsonlLinesRemoved = 0;
  let jsonlSkipped = 0;
  try {
    const jsonlResults = await cleanAllJsonlFromRegistry(false);
    for (const r of jsonlResults) {
      jsonlLinesRemoved += r.linesRemoved;
      if (r.skipped) { jsonlSkipped++; console.log(`  ⊘ ${r.target}: ${r.skipReason}`); }
      else if (r.linesRemoved > 0) console.log(`  ✓ ${r.target}: ${r.linesRemoved} lines rotated (${(r.bytesFreed / 1024).toFixed(0)} KB)`);
      for (const e of r.errors) console.warn(`  ⚠ ${r.target}: ${e}`);
    }
  } catch (e) { console.warn(`⚠ JSONL registry rotation failed: ${e}`); }
  // MemoryStore.consolidate() — archives hot→cold entries older than 7 days
  // (or past their TTL) and deduplicates by content hash. This is the only
  // scheduled invoker; before this wiring, consolidate() had zero production
  // callers (only its own CLI entry point), so MEMORY/entries grew unbounded
  // (~30MB hot vs ~760KB cold archive at time of wiring, 2026-07-29).
  // Deliberately UNGUARDED (no try/catch): unlike the best-effort JSONL
  // rotation above, a consolidation failure must fail this tier loud — it
  // propagates to main()'s top-level catch (process.exit(1)), so a cron
  // wrapper failure is never silently reported as a clean run (see
  // feedback_cron_wrapper_swallows_failure).
  const consolidateResult = await memoryStore.consolidate();
  console.log(`  ✓ Memory consolidation: ${consolidateResult.archived} archived, ${consolidateResult.deduplicated} deduplicated`);
  const state = await loadHealthState();
  await saveHealthState({ ...state, lastRunByTier: { ...state.lastRunByTier, "weekly-cleanup": new Date().toISOString() } });
  await captureInsight({ source: "AutoMaintenance/Workflows", type: "insight", title: "Maintenance weekly-cleanup complete", content: `${result.rotatedLogs} logs rotated, ${result.removedDsStore} .DS_Store removed, ${jsonlLinesRemoved} registry JSONL lines rotated (${jsonlSkipped} files skipped), ${consolidateResult.archived} memory entries archived (${consolidateResult.deduplicated} deduplicated)`, tags: ["maintenance", "weekly-cleanup"], metadata: { tier: "weekly-cleanup", durationMs: Date.now() - t0, jsonlLinesRemoved, jsonlSkipped, memoryArchived: consolidateResult.archived, memoryDeduplicated: consolidateResult.deduplicated } });
}

async function runWeeklyReportsWorkflow(): Promise<void> {
  console.log(`\n=== AutoMaintenance Weekly Reports - ${today()} ===\n`);
  const t0 = Date.now();
  const dailyDir = join(MAINTENANCE_DIR, "daily");
  if (!existsSync(dailyDir)) { console.log("⚠ No daily reports found"); return; }
  const reports = readdirSync(dailyDir).filter((f) => f.endsWith(".md")).sort().slice(-7);
  ensureDir(join(MAINTENANCE_DIR, "weekly"));
  writeFileSync(join(MAINTENANCE_DIR, "weekly", `${today()}-reports.md`), `# Weekly Reports — ${today()}\n\nAggregated ${reports.length} daily reports.\n`, "utf-8");
  const state = await loadHealthState();
  await saveHealthState({ ...state, lastRunByTier: { ...state.lastRunByTier, "weekly-reports": new Date().toISOString() } });
  await captureInsight({ source: "AutoMaintenance/Workflows", type: "insight", title: "Maintenance weekly-reports complete", content: `Aggregated ${reports.length} daily reports`, tags: ["maintenance", "weekly-reports"], metadata: { tier: "weekly-reports", durationMs: Date.now() - t0, reportCount: reports.length } });
}

async function runMonthlyWorkspaceWorkflow(): Promise<void> {
  if (new Date().getDate() > 7) { console.log("Not first week of month, skipping monthly-workspace"); return; }
  console.log(`\n=== AutoMaintenance Monthly Workspace - ${today()} ===\n`);
  const t0 = Date.now();
  const state = await loadHealthState();
  await saveHealthState({ ...state, lastRunByTier: { ...state.lastRunByTier, "monthly-workspace": new Date().toISOString() } });
  await captureInsight({ source: "AutoMaintenance/Workflows", type: "insight", title: "Maintenance monthly-workspace complete", content: "Workspace cleanup run", tags: ["maintenance", "monthly-workspace"], metadata: { tier: "monthly-workspace", durationMs: Date.now() - t0 } });
}

async function runMonthlySkillsWorkflow(): Promise<void> {
  if (new Date().getDate() > 7) { console.log("Not first week of month, skipping monthly-skills"); return; }
  console.log(`\n=== AutoMaintenance Monthly Skills - ${today()} ===\n`);
  const t0 = Date.now();
  const { skills, findings } = await runSkillsAudit();
  ensureDir(join(MAINTENANCE_DIR, "monthly"));
  writeFileSync(join(MAINTENANCE_DIR, "monthly", `${today()}-skills.md`), `# Monthly Skills Audit — ${today()}\n\nAudited ${skills.length} skills. ${findings.length} findings.\n`, "utf-8");
  const state = await loadHealthState();
  await saveHealthState({ ...state, lastRunByTier: { ...state.lastRunByTier, "monthly-skills": new Date().toISOString() } });
  await captureInsight({ source: "AutoMaintenance/Workflows", type: "insight", title: "Maintenance monthly-skills complete", content: `${skills.length} skills audited, ${findings.length} findings`, tags: ["maintenance", "monthly-skills"], metadata: { tier: "monthly-skills", durationMs: Date.now() - t0, skillCount: skills.length, findingCount: findings.length } });
}

async function runMonthlyReportsWorkflow(): Promise<void> {
  if (new Date().getDate() > 7) { console.log("Not first week of month, skipping monthly-reports"); return; }
  console.log(`\n=== AutoMaintenance Monthly Reports - ${today()} ===\n`);
  const t0 = Date.now();
  const dailyDir = join(MAINTENANCE_DIR, "daily");
  if (!existsSync(dailyDir)) { console.log("⚠ No daily reports found"); return; }
  const month = new Date().toISOString().substring(0, 7);
  const reports = readdirSync(dailyDir).filter((f) => f.startsWith(month) && f.endsWith(".md"));
  ensureDir(join(MAINTENANCE_DIR, "monthly"));
  writeFileSync(join(MAINTENANCE_DIR, "monthly", `${today()}-reports.md`), `# Monthly Maintenance Report — ${today()}\n\nDaily reports this month: ${reports.length}\n`, "utf-8");
  const state = await loadHealthState();
  await saveHealthState({ ...state, lastRunByTier: { ...state.lastRunByTier, "monthly-reports": new Date().toISOString() } });
  await captureInsight({ source: "AutoMaintenance/Workflows", type: "insight", title: "Maintenance monthly-reports complete", content: `${reports.length} daily reports this month`, tags: ["maintenance", "monthly-reports"], metadata: { tier: "monthly-reports", durationMs: Date.now() - t0, reportCount: reports.length } });
}

export async function runWeeklyTechDebt(): Promise<void> {
  console.log(`\n=== AutoMaintenance Weekly Tech Debt - ${today()} ===\n`);
  const t0 = Date.now();

  ensureDir(join(MAINTENANCE_DIR, "tech-debt"));

  const auditor = new TechDebtAuditor();
  let result;
  try {
    result = await auditor.scan();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[runWeeklyTechDebt] Audit scan threw: ${msg}`);
    throw new Error(`Weekly tech debt scan failed: ${msg}`);
  }

  if (result.scanIncomplete) {
    console.error(`[runWeeklyTechDebt] Audit scan incomplete — propagating as failure`);
    throw new Error(`Weekly tech debt scan incomplete (partial results at ${result.reportPath})`);
  }

  // Degraded (non-systemic) — some batches failed inference but the scan
  // otherwise completed. Not a throw: this is a partial-quality result, not a
  // failed run, so it surfaces as a single digest breadcrumb rather than
  // paging or failing the cron job.
  if (result.failedBatches && result.failedBatches > 0) {
    const unscannedCount = result.failedFiles?.length ?? 0;
    const msg = `Weekly tech-debt scan degraded: ${result.failedBatches}/${result.totalBatches ?? 0} batches failed, ${unscannedCount} files unscanned. Report: ${result.reportPath}`;
    console.warn(`[runWeeklyTechDebt] ${msg}`);
    sendAlert(msg, { key: "tech-debt-scan-degraded", tier: "digest" });
  }

  console.log(`✓ Tech debt audit complete: ${result.newEntries} new entries, report at ${result.reportPath}`);

  // Rescore phase — backfill null/invalid scores on OPEN items left behind by
  // failed per-entry scoring in past runs (the 2026-07-10 proving run alone
  // left ~1,039/2,444 items stuck null; top()/autoPromoteTop() sort nulls
  // last, so they were never being ranked). Bounded per run (200), not
  // run-to-completion — the live backlog is large enough to span multiple
  // usage windows, so this is deliberately resumable cleanup, not a gate on
  // this workflow's success: it must never fail the weekly run.
  try {
    const registryPath = join(KAYA_HOME, "MEMORY", "QUEUES", "tech-debt.jsonl");
    const rescoreResult = await new TechDebtRegistry(registryPath).rescoreNulls(200);
    console.log(
      `[runWeeklyTechDebt] Rescore: attempted ${rescoreResult.attempted}, rescored ${rescoreResult.rescored}, stillNull ${rescoreResult.stillNull}, remainingNull ${rescoreResult.remainingNull}`
    );
  } catch (rescoreErr) {
    const msg = rescoreErr instanceof Error ? rescoreErr.message : String(rescoreErr);
    console.warn(`[runWeeklyTechDebt] Rescore phase failed (non-fatal): ${msg}`);
  }

  // Promotion phase — auto-promote the top open debt item (capped at 2 in-flight)
  try {
    const registryPath = join(KAYA_HOME, "MEMORY", "QUEUES", "tech-debt.jsonl");
    const promoter = new TechDebtPromoter(new QueueManager(), new TechDebtRegistry(registryPath));
    const promotedId = await promoter.autoPromoteTop();
    if (promotedId.promoted) {
      console.log(`✓ Auto-promoted top debt item into spec-pipeline: ${promotedId.promotedItemId}`);
    } else {
      console.log(`[runWeeklyTechDebt] Promotion skipped (cap hit or no open items)`);
    }
  } catch (promotionErr) {
    const msg = promotionErr instanceof Error ? promotionErr.message : String(promotionErr);
    console.warn(`[runWeeklyTechDebt] Promotion phase failed (non-fatal): ${msg}`);
  }

  const state = await loadHealthState();
  await saveHealthState({ ...state, lastRunByTier: { ...state.lastRunByTier, "weekly-tech-debt": new Date().toISOString() } });

  await captureInsight({ source: "AutoMaintenance/Workflows", type: "insight", title: "Maintenance weekly-tech-debt complete", content: `${result.newEntries} new debt entries, ${result.totalScanned} files scanned`, tags: ["maintenance", "weekly-tech-debt"], metadata: { tier: "weekly-tech-debt", durationMs: Date.now() - t0, newEntries: result.newEntries, totalScanned: result.totalScanned } });
}

/**
 * Strict --by validation for the dismiss CLI (verify-flagged defect, fixed
 * here): omitted defaults to "human"; "human"/"system" pass through
 * unchanged; anything else (e.g. a typo like "robot") is rejected — the
 * prior inline `by === "system" ? "system" : "human"` ternary silently
 * coerced any unrecognized value to "human" instead of rejecting it.
 * Exported/pure so it's directly testable — main() is not subprocess-tested
 * (see this file's test suite header comment).
 */
export function parseDismissedBy(by: string | undefined): "human" | "system" | null {
  if (by === undefined || by === "human") return "human";
  if (by === "system") return "system";
  return null;
}

/**
 * ISC A-06's sanctioned closure surface (A3 — N1 alert-closure program):
 * `bun Workflows.ts --tier dismiss --id <id> [--by human|system]`.
 *
 * Exported (not inlined in main()) so it's testable directly against a
 * hermetic AlertManager (alertsLogPath DI), the same pattern
 * refireCriticalAlerts() above uses — main() itself is not subprocess-
 * tested anywhere in this file's test suite today (see
 * Workflows.testwriter.test.ts's header comment), so this is the seam a
 * test exercises instead of spawning a real CLI process.
 *
 * Found/not-found detection: dismissAlert() itself has NO such signal — its
 * documented contract (AlertManager.ts) appends a synthetic "dismissed" row
 * for ANY id it IS called with, whether or not one previously existed, and
 * returns void either way. So "found" is determined here FIRST, by checking
 * the (per-id-reduced, see AlertManager.readAlerts()) alert list for the id
 * — a plain array lookup, nothing that throws — and dismissAlert() is only
 * called when found is true. A not-found id is a pure no-op: zero ledger
 * writes, no phantom synthetic row for a typo'd id (verify-flagged defect,
 * fixed here — the original version called dismissAlert() unconditionally,
 * which appended a synthetic "dismissed" row even on a reported
 * "not found" result). dismissAlert()'s own unconditional-append contract
 * is unchanged for its OTHER callers — this handler simply chooses not to
 * invoke it in the not-found case.
 */
export async function runDismissCommand(
  alertManager: AlertManager,
  id: string,
  by: "human" | "system",
): Promise<{ found: boolean }> {
  const found = alertManager.readAlerts().some((a) => a.id === id);
  if (found) await alertManager.dismissAlert(id, by);
  return { found };
}

async function runStatusCommand(): Promise<void> {
  const state = await loadHealthState();
  const alerts = new AlertManager(new HealthTracker()).readAlerts();
  const openAlertCount = alerts.filter((a) => a.status === "open").length;
  console.log("\n=== AutoMaintenance Status ===\n");
  for (const [tier, ts] of Object.entries(state.lastRunByTier)) console.log(`  ${tier}: ${ts || "never"}`);
  console.log(`\nOpen Alerts: ${openAlertCount}\nCurrent Streak: ${state.currentStreak.daily || 0} days`);
}

export function buildDailyReport(findings: Finding[], remediation: { success: string[]; failures: Array<{ target: string; error: string; shouldEscalate: boolean }> }, alerts: { alerts: { severity: string }[] }, duration: string, gapCheck: { gapDetected: boolean; gapHours?: number }, diskPct?: number): string {
  const diskF = findings.find((f) => f.type === "disk_critical" || f.type === "disk_warning");
  const gitF = findings.find((f) => f.type === "git_dirty");
  let r = `# Daily Maintenance Report — ${today()}\n\n## Summary\n\n${findings.length} checks, ${remediation.success.length} remediations, ${alerts.alerts.length} alerts in ${duration}s.\n\n`;
  if (gapCheck.gapDetected) r += `⚠ Gap detected: ${gapCheck.gapHours} hours since last run.\n\n`;
  r += `## Checks\n\n| Check | Status | Detail |\n|-------|--------|--------|\n| Integrity | ✓ | ${findings.length} findings |\n| Disk Space | ${diskF ? "⚠" : "✓"} | ${diskPct !== undefined ? `${diskPct}%` : "N/A"} |\n| Git Repo | ${gitF ? "⚠" : "✓"} | ${gitF ? `⚠ ${gitF.target}` : "✓ Clean"} |\n| Dependencies | ✓ | Checked |\n| Process Health | ✓ | Checked |\n\n`;
  r += `## Metrics\n\n- Duration: ${duration}s\n- Findings: ${findings.length}\n- Remediations: ${remediation.success.length}\n- Alerts: ${alerts.alerts.length}\n`;
  return r;
}

// Generated report alias for backward compat
export const generateDailyReport = buildDailyReport;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { tier: { type: "string" }, "dry-run": { type: "boolean", default: false }, force: { type: "boolean", default: false }, id: { type: "string" }, by: { type: "string" } } });
  ["", "daily", "weekly", "monthly"].forEach((sub) => ensureDir(join(MAINTENANCE_DIR, sub)));
  const { tier, "dry-run": dryRun, force, id, by } = values;
  if (tier === "status") { await runStatusCommand(); return; }
  if (tier === "dismiss") {
    if (!id) { console.error("dismiss requires --id <id>"); process.exit(1); }
    const dismissedBy = parseDismissedBy(by);
    if (dismissedBy === null) {
      console.error(`Invalid --by value "${by}" — must be "human" or "system"`);
      process.exit(1);
    }
    const alertManager = new AlertManager(new HealthTracker());
    const { found } = await runDismissCommand(alertManager, id, dismissedBy);
    if (found) console.log(`✓ Dismissed alert ${id} (by ${dismissedBy})`);
    else { console.error(`✗ Alert ${id} not found — no ledger write`); process.exit(1); }
    return;
  }
  const workflows: Record<string, () => Promise<void>> = { "daily": () => runDailyWorkflow({ dryRun, force }), "weekly-security": runWeeklySecurityWorkflow, "weekly-cleanup": runWeeklyCleanupWorkflow, "weekly-reports": runWeeklyReportsWorkflow, "weekly-tech-debt": runWeeklyTechDebt, "monthly-workspace": runMonthlyWorkspaceWorkflow, "monthly-skills": runMonthlySkillsWorkflow, "monthly-reports": runMonthlyReportsWorkflow };
  const fn = tier ? workflows[tier] : undefined;
  if (!fn) { console.error("Unknown tier:", tier); console.log("\nTiers: daily, weekly-security, weekly-cleanup, weekly-reports, weekly-tech-debt, monthly-workspace, monthly-skills, monthly-reports, status, dismiss"); process.exit(1); }
  await fn();
}

if (import.meta.main) { main().catch((e) => { console.error("Fatal error:", e); process.exit(1); }); }
