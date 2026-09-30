/**
 * Workflows - Test Suite (TestWriter)
 * ISC Coverage: D-01, D-02, D-03, D-07, D-08, W-02, W-03, M-01, M-02, M-03
 *
 * These tests verify Workflows.ts structure and behavior WITHOUT running the
 * full workflow (which scans 40K+ files and times out in test context).
 * Integration testing of the full workflow is done via manual ISC
 * verification — use VerifyHarness.ts (./VerifyHarness.ts) to construct a
 * scratch-dir-backed AlertManager/HealthTracker for that verification
 * instead of invoking AlertManager/Workflows ad hoc; see VerifyHarness.ts's
 * docblock for why (2026-07-20 live-alerts.jsonl incident).
 */

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { buildSecurityReportBody, buildDailyReport, runDismissCommand, parseDismissedBy, buildAlertFindings } from "./Workflows";
import { AlertManager } from "./AlertManager";
import { HealthTracker } from "./HealthTracker";
import { AlertGate } from "../../../../lib/core/AlertGate.ts";
import type { SecurityFinding } from "./SecurityAuditor";
import type { Finding } from "./Remediator";

const WORKFLOWS_PATH = join(import.meta.dir, "Workflows.ts");
// W-02/M-02 (below) verify behavior that 77d1e235f extracted OUT of
// Workflows.ts into these domain files — Workflows.ts now only calls them.
const SECURITY_AUDITOR_PATH = join(import.meta.dir, "SecurityAuditor.ts");
const SKILLS_AUDITOR_PATH = join(import.meta.dir, "SkillsAuditor.ts");
const SKILL_DIR = join(import.meta.dir, "..");
const REPO_ROOT = join(import.meta.dir, "../../../..");

describe("Workflows - Source Verification", () => {
  const src = readFileSync(WORKFLOWS_PATH, "utf-8");

  it("D-01: daily workflow writes report to MEMORY/AutoMaintenance/daily/YYYY-MM-DD.md", () => {
    // Verify the daily workflow constructs the correct report path
    expect(src).toMatch(/daily.*\$\{.*date|today|yyyy/i);
    // Verify it writes a .md file
    expect(src).toMatch(/writeFileSync|writeSync|writeFile/);
  });

  it("D-02: daily workflow has no blocking sleep or long-running operations", () => {
    // Verify no explicit sleep/delay that would cause >5min runtime
    expect(src).not.toMatch(/setTimeout.*60000|sleep.*300/);
  });

  it("D-03: daily workflow includes disk space check", () => {
    // ISC D-03: Disk space check present in report
    expect(src.toLowerCase()).toMatch(/disk|df\s|statvfs|diskusage/);
  });

  it("D-07: daily workflow includes git status check", () => {
    // ISC D-07: Git status check present in report
    expect(src.toLowerCase()).toMatch(/git\s+status|git.*repo|repo.*health/);
  });

  it("D-08 (repaired 2026-07-22): daily report's Metrics section renders real computed findings/remediation/alert counts, not a fictional 'ISC score'", () => {
    // ISC D-08 as originally written asserted an "ISC Score" string that no
    // longer exists ANYWHERE in this codebase (confirmed repo-wide grep for
    // iscScore/ISC Score/isc_score, 2026-07-22 — zero non-test matches).
    // History: fc0572c38 wrote this assertion against a Workflows.ts that at
    // the time literally computed `ISC Score: ${checks}/${checks} (100%)` —
    // a hardcoded value that was ALWAYS 100% (checks/checks), i.e. vacuous
    // even when it existed. That whole "## ISC Results" section was deleted
    // outright by 77d1e235f (the same refactor that deleted SelfMonitor.ts
    // and extracted SecurityAuditor/SkillsAuditor/IntegrityChecker) and was
    // never replaced by an equivalent score. The honest, current contract is
    // buildDailyReport()'s "## Metrics" section: real per-run counts. Assert
    // that behavior executably instead of grepping source for dead text.
    const findings: Finding[] = [
      { type: "disk_warning", target: "/" },
      { type: "git_dirty", target: "repo" },
    ];
    const remediation = { success: ["disk_warning"], failures: [] as Array<{ target: string; error: string; shouldEscalate: boolean }> };
    const alerts = { alerts: [{ severity: "WARNING" }] };
    const report = buildDailyReport(findings, remediation, alerts, "12.3", { gapDetected: false }, 42);

    expect(report).toContain("## Metrics");
    expect(report).toContain("Findings: 2");
    expect(report).toContain("Remediations: 1");
    expect(report).toContain("Alerts: 1");
    // Confirm the deletion was deliberate and stayed deleted, rather than
    // silently reintroducing a vacuous score line under a new name.
    expect(report).not.toMatch(/ISC.*Score|iscScore|isc_score/i);
  });

  it("W-02 (repaired 2026-07-22): weekly-security's secret scan uses --only-verified (moved to SecurityAuditor.ts by 77d1e235f; Workflows.ts now only calls runSecurityAuditCheck())", () => {
    // ISC W-02: Secret scan uses --only-verified flag. This flag lived in
    // Workflows.ts until 77d1e235f extracted the secret-scan logic into
    // SecurityAuditor.ts (see SecurityAuditor.ts's runSecurityAuditCheck(),
    // ~L218: `args = [..., "--only-verified", ...]`). Workflows.ts's
    // runWeeklySecurityWorkflow() still drives it via runSecurityAuditCheck()
    // but no longer contains the flag string itself — verify both halves of
    // that seam: Workflows.ts wires the call, SecurityAuditor.ts holds the flag.
    expect(src).toMatch(/runSecurityAuditCheck/);
    const securityAuditorSrc = readFileSync(SECURITY_AUDITOR_PATH, "utf-8");
    expect(securityAuditorSrc).toContain("--only-verified");
  });

  it("W-03: weekly report generates summary table", () => {
    // ISC W-03: Weekly report includes 7-day summary table
    // Verify table generation logic exists
    expect(src.toLowerCase()).toMatch(/table|summary.*week|7.*day/);
  });

  it("M-01: monthly workflows guard on first 7 days of month", () => {
    // ISC M-01: Monthly tiers run only in first 7 days of month
    expect(src).toMatch(/getDate\(\)|dayOfMonth/);
    expect(src).toMatch(/<=?\s*7|>\s*7/);
  });

  it("M-02 (repaired 2026-07-22): monthly-skills checks every skill for SKILL.md (moved to SkillsAuditor.ts by 77d1e235f; Workflows.ts now only calls runSkillsAudit())", () => {
    // ISC M-02: Monthly-skills checks every skill for SKILL.md presence.
    // findSkills()/runSkillsAudit() lived in Workflows.ts until 77d1e235f
    // extracted them into SkillsAuditor.ts. Workflows.ts's
    // runMonthlySkillsWorkflow() still drives it via runSkillsAudit() but no
    // longer contains "SKILL.md" or findSkills() itself — verify both halves
    // of that seam.
    expect(src).toMatch(/runSkillsAudit/);
    const skillsAuditorSrc = readFileSync(SKILLS_AUDITOR_PATH, "utf-8");
    expect(skillsAuditorSrc).toMatch(/SKILL\.md/i);
    // SkillsAuditor.ts's findSkills() recursively iterates skills directories
    expect(skillsAuditorSrc.toLowerCase()).toMatch(/findskills|skills.*readdir|readdirsync/);
  });

  it("M-03: monthly report includes daily count", () => {
    // ISC M-03: Monthly report includes daily count for the month
    expect(src.toLowerCase()).toMatch(/daily.*report.*count|daily.*count|reports.*month/);
  });
});

describe("Workflows - Flags", () => {
  it("should support --dry-run flag", () => {
    const src = readFileSync(WORKFLOWS_PATH, "utf-8");
    expect(src).toMatch(/dry.?run/i);
  });

  it("should support --tier flag", () => {
    const src = readFileSync(WORKFLOWS_PATH, "utf-8");
    expect(src).toMatch(/--tier|tier.*arg/i);
  });

  it("should support the dismiss tier's --id and --by flags (A3 — ISC A-06)", () => {
    // Thin arg-parsing check, matching this describe's existing source-regex
    // style — main() itself is not subprocess-tested in this file (see
    // header comment); runDismissCommand() below is exercised directly.
    const src = readFileSync(WORKFLOWS_PATH, "utf-8");
    expect(src).toMatch(/tier\s*===\s*["']dismiss["']/);
    expect(src).toMatch(/id:\s*\{\s*type:\s*["']string["']\s*\}/);
    expect(src).toMatch(/by:\s*\{\s*type:\s*["']string["']\s*\}/);
  });
});

// ============================================================================
// A3 (ISC A-06) — dismiss CLI handler. Hermetic: scratch alertsLogPath +
// injected AlertGate with a recording send stub, mirroring
// AlertManager.testwriter.test.ts's makeGate()/beforeEach idiom (never the
// real getAlertGate() singleton or live alerts.jsonl).
// ============================================================================

describe("runDismissCommand (A3 — ISC A-06 dismiss CLI handler)", () => {
  function makeHermeticAlertManager(dir: string): AlertManager {
    const gate = new AlertGate({
      statePath: join(dir, "alert-gate.json"),
      spoolPath: join(dir, "digest-spool.jsonl"),
      send: async () => true,
    });
    return new AlertManager(new HealthTracker(), {
      alertsLogPath: join(dir, "alerts.jsonl"),
      gate,
    });
  }

  it("reports found:true and dismisses an id that has an existing open row", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "dismiss-cli-test-"));
    try {
      const alertManager = makeHermeticAlertManager(scratchDir);
      alertManager.writeAlert(
        { workflow: "daily", step: "test", type: "test_finding", finding: "dismiss-cli fixture" },
        "WARNING",
      );
      const [written] = alertManager.readAlerts();

      const result = await runDismissCommand(alertManager, written!.id, "human");

      expect(result.found).toBe(true);
      const reduced = alertManager.readAlerts();
      const row = reduced.find((a) => a.id === written!.id);
      expect(row?.status).toBe("dismissed");
      expect(row?.dismissedBy).toBe("human");
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("reports found:false for an id with no prior row and writes ZERO ledger rows (verify-fixed defect)", async () => {
    // Previously runDismissCommand() called dismissAlert() unconditionally,
    // so a typo'd/nonexistent id still appended a phantom synthetic
    // "dismissed" row to the ledger even while reporting found:false. Fixed:
    // dismissAlert() must not be called at all when the id isn't found —
    // this is a pure no-op against the ledger.
    const scratchDir = mkdtempSync(join(tmpdir(), "dismiss-cli-test-"));
    try {
      const alertManager = makeHermeticAlertManager(scratchDir);

      const result = await runDismissCommand(alertManager, "never-existed-id", "system");

      expect(result.found).toBe(false);
      const reduced = alertManager.readAlerts();
      expect(reduced.find((a) => a.id === "never-existed-id")).toBeUndefined();
      expect(reduced.length).toBe(0);
      expect(existsSync(join(scratchDir, "alerts.jsonl"))).toBe(false);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

describe("parseDismissedBy (A3 — strict --by validation, verify-fixed defect)", () => {
  it("omitted --by defaults to human", () => {
    expect(parseDismissedBy(undefined)).toBe("human");
  });

  it("accepts human and system unchanged", () => {
    expect(parseDismissedBy("human")).toBe("human");
    expect(parseDismissedBy("system")).toBe("system");
  });

  it("rejects an unrecognized value (e.g. a typo like \"robot\") instead of silently coercing to human", () => {
    // Previously `by === "system" ? "system" : "human"` silently coerced
    // ANY unrecognized string to "human". Fixed: only human/system/omitted
    // are valid; anything else is rejected (null), which main() turns into
    // a one-line usage error + exit 1, no ledger write.
    expect(parseDismissedBy("robot")).toBeNull();
    expect(parseDismissedBy("")).toBeNull();
    expect(parseDismissedBy("Human")).toBeNull(); // case-sensitive, not fuzzy
  });
});

// ============================================================================
// A5 (N4 remediation) — Jm decision 2, 2026-07-22: git_dirty is report-only,
// never an alert. This worktree's tree is dirty BY DESIGN (auto-commit lag
// on MEMORY/ runtime state), so the daily integrity check's git_dirty
// finding must never reach AlertManager.evaluate() — left unfiltered it
// would gain +1 occurrence/day forever and eventually re-escalate to
// WARNING/CRITICAL via the x3/x7 ladder. buildAlertFindings() is the
// extracted seam (mirrors refireCriticalAlerts() above) that runDailyWorkflow
// now calls instead of constructing alertFindings inline.
// ============================================================================

describe("buildAlertFindings (A5 — Jm decision 2, 2026-07-22: git_dirty is report-only)", () => {
  it("drops a git_dirty finding from the alert pipeline while a co-occurring finding still flows through", () => {
    const findings: Finding[] = [
      { type: "git_dirty", target: "3 modified files" },
      { type: "disk_critical", target: "97% used" },
    ];

    const alertFindings = buildAlertFindings(findings, []);

    expect(alertFindings.some((f) => f.type === "git_dirty")).toBe(false);
    expect(alertFindings.some((f) => f.type === "disk_critical")).toBe(true);
    expect(alertFindings.length).toBe(1);
  });

  it("still includes escalatable remediation failures alongside a filtered git_dirty finding", () => {
    const findings: Finding[] = [{ type: "git_dirty", target: "1 modified file" }];
    const remediationFailures = [{ target: "/some/path", error: "permission denied", shouldEscalate: true }];

    const alertFindings = buildAlertFindings(findings, remediationFailures);

    expect(alertFindings.some((f) => f.type === "git_dirty")).toBe(false);
    expect(alertFindings.some((f) => f.type === "remediation_failure")).toBe(true);
  });

  it("an all-git_dirty findings array with no remediation failures produces an EMPTY alertFindings array", () => {
    const findings: Finding[] = [{ type: "git_dirty", target: "5 modified files" }];
    expect(buildAlertFindings(findings, [])).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Behavioral: buildAlertFindings() feeding a hermetic AlertManager.evaluate()
// — proves git_dirty never produces an alerts.jsonl row and never reaches
// AlertGate.send(), while a co-occurring CRITICAL finding still does both.
// Mirrors Workflows.testwriter.test.ts's own makeHermeticAlertManager()
// idiom above (scratch alertsLogPath + injected AlertGate with a recording
// send stub) rather than AlertManager.testwriter.test.ts's fuller KAYA_HOME-
// pinning ceremony: HealthTracker.record()/getSeverity()/resolveAbsent() are
// pure in-memory Map operations (HealthTracker.ts) that never touch disk
// unless .load()/.save() are called, and this test calls neither — so a
// bare `new HealthTracker()` is already fully hermetic with zero live-KAYA_HOME
// exposure, matching the dismiss-CLI tests' own choice above.
// ----------------------------------------------------------------------------

describe("buildAlertFindings -> AlertManager.evaluate() (A5 behavioral)", () => {
  interface RecordedSend { message: string; channel: string }

  function makeHermeticAlertManagerWithRecorder(dir: string): { alertManager: AlertManager; sent: RecordedSend[] } {
    const sent: RecordedSend[] = [];
    const gate = new AlertGate({
      statePath: join(dir, "alert-gate.json"),
      spoolPath: join(dir, "digest-spool.jsonl"),
      send: async (message, channel) => { sent.push({ message, channel }); return true; },
    });
    const alertManager = new AlertManager(new HealthTracker(), {
      alertsLogPath: join(dir, "alerts.jsonl"),
      gate,
    });
    return { alertManager, sent };
  }

  it("git_dirty produces NO alerts.jsonl row and NO AlertGate send; a co-occurring verified_secret still does both", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "alert-findings-test-"));
    try {
      const { alertManager, sent } = makeHermeticAlertManagerWithRecorder(scratchDir);
      const findings: Finding[] = [
        { type: "git_dirty", target: "4 modified files" },
        { type: "verified_secret", target: "GitHub token in config.json" },
      ];
      // evaluate() classifies severity off FindingInput.type/.verified — the
      // finding shape buildAlertFindings() produces doesn't carry `verified`,
      // so build the verified_secret row directly to force an immediate
      // CRITICAL (page tier) for a deterministic, single-call assertion, and
      // run it through the SAME filtered array buildAlertFindings() emits.
      const alertFindings = buildAlertFindings(findings, []).map((f) =>
        f.type === "verified_secret" ? { ...f, verified: true } : f,
      );

      await alertManager.evaluate(alertFindings, new HealthTracker(), "daily");

      const rows = alertManager.readAlerts();
      expect(rows.some((a) => a.finding.includes("git_dirty"))).toBe(false);
      expect(rows.some((a) => a.finding.includes("verified_secret"))).toBe(true);

      expect(sent.length).toBe(1);
      expect(sent[0]!.message).toContain("verified_secret");
      expect(sent[0]!.message).not.toContain("git_dirty");
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// A5 — buildDailyReport() must keep receiving the FULL, unfiltered findings
// array: the "Git Repo" report row/count is unchanged by the A5 alert-path
// filter above (that filter only touches buildAlertFindings()'s output, a
// value buildDailyReport() never sees). Extends the D-08 pattern above,
// which already includes a git_dirty fixture but didn't assert the Git Repo
// row's own rendering directly.
// ============================================================================

describe("buildDailyReport (A5 — Git Repo row unaffected by the alert-path git_dirty filter)", () => {
  it("still renders the Git Repo row with the git_dirty finding's target when one is present", () => {
    const findings: Finding[] = [{ type: "git_dirty", target: "3 modified files" }];
    const remediation = { success: [], failures: [] as Array<{ target: string; error: string; shouldEscalate: boolean }> };
    const alerts = { alerts: [] as { severity: string }[] };
    const report = buildDailyReport(findings, remediation, alerts, "1.0", { gapDetected: false });

    expect(report).toMatch(/\|\s*Git Repo\s*\|\s*⚠\s*\|\s*⚠ 3 modified files\s*\|/);
  });

  it("renders the Git Repo row clean when no git_dirty finding is present", () => {
    const findings: Finding[] = [];
    const remediation = { success: [], failures: [] as Array<{ target: string; error: string; shouldEscalate: boolean }> };
    const alerts = { alerts: [] as { severity: string }[] };
    const report = buildDailyReport(findings, remediation, alerts, "1.0", { gapDetected: false });

    expect(report).toMatch(/\|\s*Git Repo\s*\|\s*✓\s*\|\s*✓ Clean\s*\|/);
  });
});

// ============================================================================
// B5 item 4 — "Daily maintenance complete" push ping DELETED (Jm decision:
// measured 0/204 deliveries). Grep-asserts the literal string is gone
// repo-wide in this worktree, not just from Workflows.ts, so a copy-paste
// revival elsewhere would also be caught.
// ============================================================================

describe("Workflows - dead ping deletion (B5 item 4)", () => {
  it("'Daily maintenance complete' does not appear anywhere in this worktree's .ts sources (excluding this test's own documentation of the deleted string)", () => {
    // --exclude-dir=worktrees (added 2026-07-22): on the SHARED tree,
    // REPO_ROOT recursively contains ~80 nested worktree checkouts under
    // .claude/worktrees/. Measured with the real /usr/bin/grep binary (the
    // one execFileSync actually invokes — NOT this shell's ugrep-backed
    // `grep` function/alias, which is much faster and not representative):
    // WITHOUT this exclude, the shared-tree run took 73-80s (exceeds the
    // 5s bun default) AND returned 69 real matches — every one a stale,
    // historically-checked-out worktree copy of Workflows.ts predating the
    // 2026-07-20 ping deletion, not a live revival. Excluding the
    // `worktrees` dir name drops shared-tree runtime to ~1-3s and 0 matches,
    // while still scanning every real (non-nested-worktree) source tree —
    // proven to still catch a genuine revival: see the manual proof in this
    // slice's report (planted string in a scratch dir outside any
    // `worktrees`-named directory was caught by this exact grep
    // construction; a copy planted inside a `worktrees`-named directory was
    // correctly skipped).
    let matches = "";
    try {
      matches = execFileSync(
        "grep",
        [
          "-rl",
          "--include=*.ts",
          "--exclude-dir=node_modules",
          "--exclude-dir=.git",
          "--exclude-dir=worktrees",
          "--exclude=Workflows.testwriter.test.ts",
          "Daily maintenance complete",
          REPO_ROOT,
        ],
        { encoding: "utf-8" },
      );
    } catch {
      // grep exits 1 (no matches found) -> execFileSync throws. That's the PASS case.
      matches = "";
    }
    expect(matches.trim()).toBe("");
  }, { timeout: 30000 }); // belt-and-braces: generous headroom (~10-30x the
  // ~1-3s observed post-fix shared-tree runtime) in case of concurrent
  // worktree-agent disk contention; the exclude-dir fix above is the real
  // fix, this is just a backstop against a slow run failing on timeout
  // alone rather than on its actual assertion.

  it("Workflows.ts no longer imports notifySync (its only prior caller)", () => {
    const src = readFileSync(WORKFLOWS_PATH, "utf-8");
    expect(src).not.toMatch(/notifySync/);
  });
});

// ============================================================================
// B5 item 5 — secrets-count rendering bug. `findings` from
// runSecurityAuditCheck() holds at most ONE row; the real count lives in
// that row's `.count` field, not `findings.length` (which is just 0 or 1).
// ============================================================================

// ============================================================================
// A6 (N4 remediation) — cleanOrphanedCurrentWork (24h TTL) and
// cleanStaleContextFiles (14d TTL) were wired into NO scheduled tier, letting
// 553 stale MEMORY/State files accumulate. Source-verification only: like
// cleanWorkDirs above (and per this file's header comment), runDailyWorkflow()
// itself scans 40K+ files and can't be executed in test context, so these
// assert the wiring shape directly against source rather than running the
// full daily workflow. Behavioral coverage of the two functions themselves
// (dryRun deletes nothing, KAYA_HOME-scoped) lives in MemoryCleanup.test.ts,
// which already establishes that hermetic pattern for this file's pair.
// ============================================================================

describe("Workflows - A6 (N4): orphaned current-work + stale context-file cleanup wired into daily tier", () => {
  const src = readFileSync(WORKFLOWS_PATH, "utf-8");

  it("imports cleanOrphanedCurrentWork and cleanStaleContextFiles from MemoryCleanup", () => {
    expect(src).toMatch(/import\s*\{[^}]*cleanOrphanedCurrentWork[^}]*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/\.\.\/lib\/core\/MemoryCleanup["']/);
    expect(src).toMatch(/import\s*\{[^}]*cleanStaleContextFiles[^}]*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/\.\.\/lib\/core\/MemoryCleanup["']/);
  });

  it("both cleanup calls appear after the cleanWorkDirs call, in source order", () => {
    const workDirsIdx = src.indexOf("cleanWorkDirs(options.dryRun");
    const orphanIdx = src.indexOf("cleanOrphanedCurrentWork(options.dryRun");
    const contextIdx = src.indexOf("cleanStaleContextFiles(options.dryRun");
    expect(workDirsIdx).toBeGreaterThan(-1);
    expect(orphanIdx).toBeGreaterThan(workDirsIdx);
    expect(contextIdx).toBeGreaterThan(orphanIdx);
  });

  it("each new cleanup call is wrapped in its own non-fatal try/catch with dryRun threaded from options.dryRun, matching the cleanWorkDirs idiom exactly", () => {
    // Literal substrings (not a brace-spanning regex — the calls' own
    // template-literal log lines contain `}` inside `${...}` interpolations,
    // which would prematurely terminate a `[^}]*`-style pattern). Each
    // assertion pins the exact try-open, dryRun-threading, and catch-open text.
    expect(src).toContain("try { const r = await cleanOrphanedCurrentWork(options.dryRun ?? false);");
    expect(src).toContain("} catch (e) { console.warn(`⚠ orphaned current-work cleanup failed: ${e}`); }");
    expect(src).toContain("try { const r = await cleanStaleContextFiles(options.dryRun ?? false);");
    expect(src).toContain("} catch (e) { console.warn(`⚠ stale context-file cleanup failed: ${e}`); }");
  });

  it("the three cleanup try/catches (WORK/, orphaned current-work, stale context files) are SIBLINGS, not nested inside one another — proven by exact textual adjacency, not merely line order", () => {
    // Verify-flagged defect in an earlier version of this test: it only
    // checked that each call's text appeared on a later line than the
    // previous one (`indexOf("\n", ...) < nextIndex`), which is trivially
    // true even if the two new calls are physically relocated INSIDE
    // cleanWorkDirs's try body (still on later lines, just nested) — a
    // planted probe proved that version green on a nested copy. Fixed here:
    // each call's FULL statement (its own complete, self-contained
    // `try { ... } catch (e) { ... }` on one line, this file's established
    // idiom) must appear verbatim, and after call N's statement ends, only
    // whitespace and/or full-line `//` comments may appear before call N+1's
    // statement begins — no other code, and specifically no unclosed outer
    // `try {` sitting in between. Nesting either breaks a call's own
    // statement apart (its catch no longer immediately follows its own
    // console.log) or inserts real code into the gap — either way this
    // adjacency check fails where the old line-order check did not.
    const workDirsStmt = "try { const r = await cleanWorkDirs(options.dryRun ?? false); console.log(`✓ WORK/ cleanup: ${r.dirsRemoved} removed, ${(r.bytesFreed / 1048576).toFixed(1)} MB freed`); } catch (e) { console.warn(`⚠ WORK/ cleanup failed: ${e}`); }";
    const orphanStmt = "try { const r = await cleanOrphanedCurrentWork(options.dryRun ?? false); console.log(`✓ orphaned current-work cleanup: ${r.filesRemoved} removed, ${(r.bytesFreed / 1048576).toFixed(1)} MB freed`); } catch (e) { console.warn(`⚠ orphaned current-work cleanup failed: ${e}`); }";
    const contextStmt = "try { const r = await cleanStaleContextFiles(options.dryRun ?? false); console.log(`✓ stale context-file cleanup: ${r.filesRemoved} removed, ${(r.bytesFreed / 1048576).toFixed(1)} MB freed`); } catch (e) { console.warn(`⚠ stale context-file cleanup failed: ${e}`); }";

    const isOnlyWhitespaceOrComments = (text: string): boolean =>
      text.split("\n").every((line) => {
        const t = line.trim();
        return t === "" || t.startsWith("//");
      });

    const workDirsIdx = src.indexOf(workDirsStmt);
    expect(workDirsIdx).toBeGreaterThan(-1); // must exist verbatim as one unbroken statement

    const orphanIdx = src.indexOf(orphanStmt);
    expect(orphanIdx).toBeGreaterThan(workDirsIdx);
    expect(isOnlyWhitespaceOrComments(src.slice(workDirsIdx + workDirsStmt.length, orphanIdx))).toBe(true);

    const contextIdx = src.indexOf(contextStmt);
    expect(contextIdx).toBeGreaterThan(orphanIdx);
    expect(isOnlyWhitespaceOrComments(src.slice(orphanIdx + orphanStmt.length, contextIdx))).toBe(true);
  });
});

describe("buildSecurityReportBody (B5 item 5)", () => {
  it("renders the real count from a count:73 fixture, not findings.length (1)", () => {
    const findings: SecurityFinding[] = [
      {
        workflow: "weekly-security",
        step: "secret-scan",
        type: "verified_secret",
        finding: "73 verified secrets found (40 aws, 33 github)",
        verified: true,
        count: 73,
      },
    ];
    const body = buildSecurityReportBody(findings);
    expect(body).toContain("73 verified secrets found");
    expect(body).not.toContain("1 verified secrets found");
  });

  it("renders a scan_error row distinguishably from a real zero-findings clean run", () => {
    const errorFindings: SecurityFinding[] = [
      {
        workflow: "weekly-security",
        step: "secret-scan",
        type: "scan_error",
        finding: "Secret scan FAILED — result UNKNOWN, NOT verified clean: exit status 1",
      },
    ];
    const errorBody = buildSecurityReportBody(errorFindings);
    const cleanBody = buildSecurityReportBody([]);

    expect(errorBody).toContain("FAILED");
    expect(errorBody).toContain("UNKNOWN");
    expect(errorBody).not.toBe(cleanBody);
    // Must never read as "0 verified secrets" / "1 verified secrets" — an
    // unknown scan result is not a count.
    expect(errorBody).not.toMatch(/\d+ verified secrets found/);
  });

  it("renders a real clean run (zero findings) as clean, not as an error", () => {
    const body = buildSecurityReportBody([]);
    expect(body).toContain("No verified secrets found");
  });
});
