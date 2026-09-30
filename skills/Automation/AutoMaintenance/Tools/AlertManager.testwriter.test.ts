/**
 * AlertManager - Test Suite (TestWriter)
 * ISC Coverage: A-01, A-02, A-05, A-06, A-07
 *
 * Hermetic: every AlertManager under test is constructed with an
 * alertsLogPath override (a per-test mkdtemp file) and an injected AlertGate
 * with a scratch statePath/spoolPath + a recording `send` stub — never the
 * real getAlertGate() singleton (which would really call
 * fetch/Telegram/live-home paths) — per Track C slice 3.1 of the alert-storm
 * remediation plan and B5's AlertGate migration (see AlertManager.ts's
 * AlertManagerOptions for the DI shape, mirrors HealthManager.test.ts's
 * makeGate() idiom).
 *
 * KAYA_HOME is ALSO pinned to a scratch dir (with the HealthManager
 * singleton reset per-test) — B5's own resolveAbsent() regression tests
 * exposed that without this, `healthTracker.load()` reads the REAL
 * ~/.claude/MEMORY/AutoMaintenance/health-state.json (hundreds of live
 * "daily:integrity:*" issue keys), so any test exercising resolveAbsent()
 * across the whole tracker map would silently operate on live production
 * data instead of the test's own fixtures. Mirrors the pin+reset pattern in
 * HealthTracker.testwriter.test.ts / HealthManager.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { readFileSync, appendFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { AlertManager, reduceAlertsById, type Alert } from "./AlertManager";
import { HealthTracker, generateIssueKey } from "./HealthTracker";
import { _resetHealthManagerForTest } from "./HealthManager";
import { AlertGate } from "../../../../lib/core/AlertGate.ts";
import { refireCriticalAlerts } from "./Workflows";
import { defaultKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================================================
// Regression guard: the real, unpinned alerts.jsonl must be byte- and
// mtime-identical before and after this whole suite runs — the exact
// invariant a forgotten pin/reset would violate.
// ============================================================================

const LIVE_ALERTS_LOG_PATH = join(
  defaultKayaHome(),
  "MEMORY",
  "AutoMaintenance",
  "alerts.jsonl"
);

function liveAlertsLogSignature(): { mtimeMs: number; hash: string } | null {
  if (!existsSync(LIVE_ALERTS_LOG_PATH)) return null;
  return {
    mtimeMs: statSync(LIVE_ALERTS_LOG_PATH).mtimeMs,
    hash: createHash("sha256").update(readFileSync(LIVE_ALERTS_LOG_PATH)).digest("hex"),
  };
}

let liveSignatureBeforeSuite: ReturnType<typeof liveAlertsLogSignature>;

beforeAll(() => {
  liveSignatureBeforeSuite = liveAlertsLogSignature();
});

afterAll(() => {
  expect(liveAlertsLogSignature()).toEqual(liveSignatureBeforeSuite);
});

interface RecordedSend {
  message: string;
  channel: string;
}

let scratchDir: string;
let testHome: string;
let alertsLogPath: string;
let sent: RecordedSend[];
let gate: AlertGate;
let alertManager: AlertManager;
let healthTracker: HealthTracker;

function makeGate(dir: string): AlertGate {
  return new AlertGate({
    statePath: join(dir, "alert-gate.json"),
    spoolPath: join(dir, "digest-spool.jsonl"),
    send: async (message, channel) => {
      sent.push({ message, channel });
      return true;
    },
  });
}

/**
 * Digest-tier rows never touch the `send` stub — they are appended to the
 * spool. refireOpenCriticalAlerts() moved to tier 'digest' on 2026-07-31
 * (daily re-nag of an already-triaged critical was pure alarm fatigue; the
 * FIRST occurrence still pages via evaluate()), so its tests read here.
 */
function readSpool(dir: string): Array<{ key: string; tier: string; message: string }> {
  const p = join(dir, "digest-spool.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), "alert-manager-test-"));
  testHome = join(scratchDir, "home");
  mkdirSync(join(testHome, "MEMORY", "AutoMaintenance"), { recursive: true });
  process.env.KAYA_HOME = testHome;
  _resetHealthManagerForTest();

  alertsLogPath = join(scratchDir, "alerts.jsonl");
  sent = [];
  gate = makeGate(scratchDir);

  healthTracker = new HealthTracker();
  await healthTracker.load();
  alertManager = new AlertManager(healthTracker, {
    alertsLogPath,
    gate,
  });
});

afterEach(() => {
  delete process.env.KAYA_HOME;
  _resetHealthManagerForTest();
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("AlertManager", () => {
  describe("verified secret detection", () => {
    it("should trigger CRITICAL alert for verified secret", async () => {
      // ISC A-01: Verified secret triggers CRITICAL alert + notification via AlertGate (tier: page)
      const findings = [
        {
          workflow: "weekly-security",
          step: "secret-scan",
          type: "verified_secret",
          finding: "GitHub token found in config.json",
          verified: true
        }
      ];

      const result = await alertManager.evaluate(findings, healthTracker);

      expect(result.alerts.length).toBeGreaterThan(0);
      const criticalAlert = result.alerts.find(a => a.severity === "CRITICAL");
      expect(criticalAlert).toBeDefined();
      expect(criticalAlert!.finding).toContain("GitHub token");
    });

    it("should route through the injected AlertGate (tier: page) for a verified secret", async () => {
      const findings = [
        {
          workflow: "weekly-security",
          step: "secret-scan",
          type: "verified_secret",
          finding: "API key found",
          verified: true
        }
      ];

      const result = await alertManager.evaluate(findings, healthTracker);

      // Verify the page-tier send was attempted via the injected recording
      // stub — never the real AlertGate singleton/network path.
      expect(result.notificationsFired).toBeGreaterThan(0);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent[0]!.message).toContain("API key found");
      expect(sent[0]!.message.startsWith("[CRITICAL]")).toBe(true);
    });

    it("should write alert to the scratch alerts.jsonl", async () => {
      const findings = [
        {
          workflow: "weekly-security",
          step: "secret-scan",
          type: "verified_secret",
          finding: "Secret in file.ts",
          verified: true
        }
      ];

      await alertManager.evaluate(findings, healthTracker);

      expect(existsSync(alertsLogPath)).toBe(true);
      const logContent = readFileSync(alertsLogPath, "utf-8");
      const lastLine = logContent.trim().split("\n").pop();
      const alert = JSON.parse(lastLine!);

      expect(alert.severity).toBe("CRITICAL");
      expect(alert.status).toBe("open");
    });
  });

  describe("unverified secret detection", () => {
    it("should log WARNING for unverified-only secrets and spool (not page)", async () => {
      // ISC A-02: Unverified-only secrets log WARNING, not CRITICAL
      const findings = [
        {
          workflow: "weekly-security",
          step: "secret-scan",
          type: "potential_secret",
          finding: "200 potential secrets detected",
          verified: false,
          count: 200
        }
      ];

      const result = await alertManager.evaluate(findings, healthTracker);

      const warningAlert = result.alerts.find(a => a.severity === "WARNING");
      expect(warningAlert).toBeDefined();

      const criticalAlert = result.alerts.find(a => a.severity === "CRITICAL");
      expect(criticalAlert).toBeUndefined();

      // WARNING routes to tier: 'digest' — spooled, never calls the page-tier send fn.
      expect(sent.length).toBe(0);
      const spoolContent = readFileSync(join(scratchDir, "digest-spool.jsonl"), "utf-8");
      expect(spoolContent).toContain("200 potential secrets detected");
    });
  });

  describe("scan_error escalation (E1 — secret-scan-honest)", () => {
    it("should trigger CRITICAL + notification on first occurrence of a scan_error, distinct from a clean result", async () => {
      // A trufflehog scan that failed to complete means the result is
      // UNKNOWN, not clean — must page on the very FIRST occurrence, same as
      // a confirmed verified_secret. Must NOT wait for occurrence-based
      // escalation (the x3/x7 path other finding types use).
      const findings = [
        {
          workflow: "weekly-security",
          step: "secret-scan",
          type: "scan_error",
          finding: "Secret scan FAILED — result UNKNOWN, NOT verified clean: exit status 1"
        }
      ];

      const result = await alertManager.evaluate(findings, healthTracker);

      const criticalAlert = result.alerts.find(a => a.severity === "CRITICAL");
      expect(criticalAlert).toBeDefined();
      expect(criticalAlert!.finding).toContain("UNKNOWN");
      expect(result.notificationsFired).toBeGreaterThan(0);
      expect(sent.length).toBeGreaterThan(0);
    });
  });

  describe("privacy violations", () => {
    it("should log WARNING for privacy violations on first detection", async () => {
      // ISC A-07: Privacy violations log as WARNING, not CRITICAL (unless recurring)
      const findings = [
        {
          workflow: "weekly-security",
          step: "privacy-validation",
          type: "privacy_violation",
          finding: "14 USER files found in SYSTEM locations"
        }
      ];

      const result = await alertManager.evaluate(findings, healthTracker);

      const warningAlert = result.alerts.find(a => a.severity === "WARNING");
      expect(warningAlert).toBeDefined();
      expect(warningAlert!.finding).toContain("USER files");
    });
  });

  describe("CRITICAL alert re-firing", () => {
    it("should re-fire CRITICAL alerts daily until dismissed", async () => {
      // ISC A-05: CRITICAL alert re-fires daily until dismissed
      const alertId = "test-alert-123";

      // Simulate existing open CRITICAL alert
      const openAlert = {
        id: alertId,
        timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        severity: "CRITICAL" as const,
        workflow: "daily",
        step: "test",
        finding: "Critical issue",
        status: "open" as const
      };

      const result = await alertManager.refireOpenCriticalAlerts([openAlert]);

      expect(result.refiredCount).toBeGreaterThan(0);
      expect(result.notificationsFired).toBeGreaterThan(0);
      // Digest tier (2026-07-31): the re-fire lands in the spool, not on the
      // page channel — Jm still sees it in the daily digest, without a ping.
      expect(sent).toHaveLength(0);
      expect(readSpool(scratchDir).some(e => e.message.includes("Critical issue"))).toBe(true);
    });
  });

  describe("daily-workflow wiring for ISC A-05 (Workflows.refireCriticalAlerts)", () => {
    // Exercises the actual wiring the daily tier calls (Workflows.ts's
    // refireCriticalAlerts), not refireOpenCriticalAlerts() directly —
    // proving readAlerts() -> filter(open && CRITICAL) -> refire is wired
    // correctly, using this file's existing hermetic AlertManager (scratch
    // alertsLogPath, injected recording gate — no real Telegram send).
    it("an open CRITICAL alert in alerts.jsonl is re-fired", async () => {
      alertManager.writeAlert(
        { workflow: "daily", step: "test", type: "remediation_failure", finding: "Disk remediation failed" },
        "CRITICAL",
      );

      const result = await refireCriticalAlerts(alertManager);

      expect(result.refiredCount).toBe(1);
      expect(result.notificationsFired).toBe(1);
      expect(sent).toHaveLength(0);
      expect(readSpool(scratchDir).some(e => e.message.includes("Disk remediation failed"))).toBe(true);
    });

    it("a dismissed CRITICAL alert is silent (not re-fired)", async () => {
      // Written directly as a single dismissed line (rather than
      // writeAlert() + dismissAlert(), which would append a SECOND line for
      // the same id and leave the original "open" line in the log too,
      // confounding the fixture) — isolates exactly the case this test
      // names: one dismissed CRITICAL alert, nothing else.
      const dismissed = {
        id: "dismissed-critical-1",
        timestamp: new Date().toISOString(),
        severity: "CRITICAL" as const,
        workflow: "daily",
        step: "test",
        finding: "Already-handled issue",
        status: "dismissed" as const,
        dismissedBy: "human" as const,
        dismissedAt: new Date().toISOString(),
      };
      appendFileSync(alertsLogPath, JSON.stringify(dismissed) + "\n");

      const result = await refireCriticalAlerts(alertManager);

      expect(result.refiredCount).toBe(0);
      expect(result.notificationsFired).toBe(0);
      expect(sent.length).toBe(0);
    });
  });

  describe("alert dismissal", () => {
    it("should set status to dismissed when alert is dismissed", async () => {
      // ISC A-06: /maintenance dismiss <id> sets status to "dismissed"
      const alertId = "dismiss-test-123";

      await alertManager.dismissAlert(alertId, "human");

      const alerts = alertManager.readAlerts();
      const dismissedAlert = alerts.find(a => a.id === alertId);

      if (dismissedAlert) {
        expect(dismissedAlert.status).toBe("dismissed");
        expect(dismissedAlert.dismissedBy).toBe("human");
        expect(dismissedAlert.dismissedAt).toBeDefined();
      }
    });
  });

  describe("evaluate() auto-resolves absent issues even on a CLEAN (empty-findings) scan", () => {
    // Regression for the "auto-resolve never runs on the clean-scan case"
    // bug: currentKeysByWorkflow was previously built ONLY from `findings`,
    // so evaluate([], tracker) — production's default shape on a healthy
    // day, since Workflows.ts's alertFindings is [] whenever both source
    // arrays come back clean — never populated an entry for the workflow at
    // all, and resolveAbsent() was never called. A prior "monitoring" issue
    // would then stay "monitoring" forever no matter how many clean scans
    // ran after it. Fixed by passing the in-scope workflow explicitly to
    // evaluate() so it seeds an (initially empty) entry regardless of
    // whether this scan produced any findings.
    it("resolves a prior issue under workflow W when evaluate(W) is called with zero findings", async () => {
      const staleFinding = { workflow: "daily", step: "integrity", type: "broken_symlink", finding: "broken_symlink: bin/old-tool" };
      const staleKey = generateIssueKey(staleFinding.workflow, staleFinding.step, staleFinding.finding);
      healthTracker.record(staleKey, {
        lastSeen: new Date().toISOString(),
        type: staleFinding.type,
        finding: staleFinding.finding,
        status: "monitoring",
      });
      expect(healthTracker.get(staleKey)!.status).toBe("monitoring");

      // Simulates the next, healthy "daily" scan: nothing found.
      const result = await alertManager.evaluate([], healthTracker, "daily");

      expect(result.resolvedKeys).toEqual([staleKey]);
      expect(healthTracker.get(staleKey)!.status).toBe("auto-resolved");
    });

    it("does NOT resolve an issue under a DIFFERENT workflow on a clean scan", async () => {
      const otherFinding = { workflow: "weekly-security", step: "secret-scan", type: "potential_secret", finding: "some finding" };
      const otherKey = generateIssueKey(otherFinding.workflow, otherFinding.step, otherFinding.finding);
      healthTracker.record(otherKey, {
        lastSeen: new Date().toISOString(),
        type: otherFinding.type,
        finding: otherFinding.finding,
        status: "monitoring",
      });

      await alertManager.evaluate([], healthTracker, "daily");

      expect(healthTracker.get(otherKey)!.status).toBe("monitoring");
    });

    it("without a workflow argument, evaluate([]) resolves nothing (documents the opt-in contract)", async () => {
      const staleKey = generateIssueKey("daily", "integrity", "broken_symlink: bin/old-tool");
      healthTracker.record(staleKey, {
        lastSeen: new Date().toISOString(),
        type: "broken_symlink",
        finding: "broken_symlink: bin/old-tool",
        status: "monitoring",
      });

      const result = await alertManager.evaluate([], healthTracker);

      expect(result.resolvedKeys).toEqual([]);
      expect(healthTracker.get(staleKey)!.status).toBe("monitoring");
    });
  });

  describe("alert persistence", () => {
    it("should append alerts to the scratch alerts.jsonl", async () => {
      const finding = {
        workflow: "daily",
        step: "integrity",
        type: "test_finding",
        finding: "Test finding message"
      };

      await alertManager.writeAlert(finding, "INFO");

      expect(existsSync(alertsLogPath)).toBe(true);
    });

    it("should preserve dismissed entries in alerts.jsonl", async () => {
      const alertId = "preserve-test-456";

      await alertManager.dismissAlert(alertId, "human");

      const logContent = readFileSync(alertsLogPath, "utf-8");
      expect(logContent).toContain(alertId);
      expect(logContent).toContain('"status":"dismissed"');
    });
  });
});

// ============================================================================
// A3 — N1 alert-closure program: issueKey threading, per-id reduction, and
// the dismiss CLI's handler. reduceAlertsById is pure (no fs/DI needed);
// the readAlerts()/writeAlert() tests below reuse this file's existing
// hermetic beforeEach (scratch alertsLogPath + injected AlertGate).
// ============================================================================

describe("reduceAlertsById (pure, A3)", () => {
  function makeAlert(overrides: Partial<Alert> & Pick<Alert, "id" | "status">): Alert {
    return {
      timestamp: new Date().toISOString(),
      severity: "INFO",
      workflow: "daily",
      step: "test",
      finding: "fixture finding",
      ...overrides,
    };
  }

  it("collapses duplicate ids to the LATEST (last-write-wins) status", () => {
    const open = makeAlert({ id: "dup-1", status: "open" });
    const dismissed = makeAlert({ id: "dup-1", status: "dismissed", dismissedBy: "human" });

    const reduced = reduceAlertsById([open, dismissed]);

    expect(reduced.length).toBe(1);
    expect(reduced[0]!.status).toBe("dismissed");
    expect(reduced[0]!.dismissedBy).toBe("human");
  });

  it("keeps all distinct ids", () => {
    const a = makeAlert({ id: "a", status: "open" });
    const b = makeAlert({ id: "b", status: "open" });
    const c = makeAlert({ id: "c", status: "dismissed" });

    const reduced = reduceAlertsById([a, b, c]);

    expect(reduced.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("returns [] for empty input", () => {
    expect(reduceAlertsById([])).toEqual([]);
  });

  it("output order is stable: first-seen order of ids, not chronological order of the winning row", () => {
    // "b" appears first in the input; its LATEST occurrence (dismissed) is
    // the 3rd element overall. Per this function's documented contract, "b"
    // still occupies the FIRST output slot (first-seen), carrying its
    // latest value (dismissed) — not "moved to the end" because its winning
    // row came later in the input.
    const bFirst = makeAlert({ id: "b", status: "open" });
    const aOnly = makeAlert({ id: "a", status: "open" });
    const bLatest = makeAlert({ id: "b", status: "dismissed" });

    const reduced = reduceAlertsById([bFirst, aOnly, bLatest]);

    expect(reduced.map((r) => r.id)).toEqual(["b", "a"]);
    expect(reduced.find((r) => r.id === "b")!.status).toBe("dismissed");
  });
});

describe("readAlerts() applies the per-id reduction (A3)", () => {
  it("after dismissAlert(id), the id no longer appears as open via readAlerts()", async () => {
    const finding = { workflow: "daily", step: "integrity", type: "test_finding", finding: "Some recurring issue" };
    alertManager.writeAlert(finding, "CRITICAL");

    const rawBefore = readFileSync(alertsLogPath, "utf-8").trim().split("\n").filter((l) => l.length > 0);
    expect(rawBefore.length).toBe(1);
    const writtenId = (JSON.parse(rawBefore[0]!) as Alert).id;

    let reduced = alertManager.readAlerts();
    expect(reduced.find((a) => a.id === writtenId)?.status).toBe("open");

    await alertManager.dismissAlert(writtenId, "human");

    // Raw file now holds TWO lines for the same id (append-only) ...
    const rawAfter = readFileSync(alertsLogPath, "utf-8").trim().split("\n").filter((l) => l.length > 0);
    expect(rawAfter.length).toBe(2);
    // ... but the reduced view collapses them to one, dismissed.
    reduced = alertManager.readAlerts();
    const matching = reduced.filter((a) => a.id === writtenId);
    expect(matching.length).toBe(1);
    expect(matching[0]!.status).toBe("dismissed");
  });

  it("issueKey round-trips through write -> read when threaded from evaluate()", async () => {
    const findings = [
      { workflow: "daily", step: "integrity", type: "test_finding", finding: "issueKey round-trip fixture" },
    ];

    await alertManager.evaluate(findings, healthTracker, "daily");

    const expectedKey = generateIssueKey("daily", "integrity", "issueKey round-trip fixture");
    const reduced = alertManager.readAlerts();
    const written = reduced.find((a) => a.finding === "issueKey round-trip fixture");
    expect(written?.issueKey).toBe(expectedKey);
  });
});

describe("writeAlert() issueKey stamping (A3)", () => {
  it("stamps issueKey when threaded explicitly", () => {
    const finding = { workflow: "daily", step: "integrity", type: "test_finding", finding: "explicit key fixture" };
    const key = generateIssueKey(finding.workflow, finding.step, finding.finding);

    alertManager.writeAlert(finding, "WARNING", key);

    const reduced = alertManager.readAlerts();
    const written = reduced.find((a) => a.finding === "explicit key fixture");
    expect(written?.issueKey).toBe(key);
  });

  it("rows written without a key (legacy call shape) still parse fine — issueKey is undefined, not a parse error", () => {
    const finding = { workflow: "daily", step: "integrity", type: "test_finding", finding: "no key fixture" };

    // Two-arg call — mirrors this file's pre-existing direct writeAlert()
    // calls (e.g. the "alert persistence" describe above), which never
    // threaded an issueKey and must keep working unchanged.
    alertManager.writeAlert(finding, "INFO");

    const rawLine = readFileSync(alertsLogPath, "utf-8").trim().split("\n").pop()!;
    // JSON.stringify drops the undefined-valued issueKey key entirely —
    // legacy rows and no-key rows are byte-identical in shape.
    expect(rawLine).not.toContain("issueKey");

    const reduced = alertManager.readAlerts();
    const written = reduced.find((a) => a.finding === "no key fixture");
    expect(written).toBeDefined();
    expect(written?.issueKey).toBeUndefined();
  });

  it("a pre-A3 legacy line with no issueKey field at all parses fine via readAlerts()", () => {
    const legacyLine = JSON.stringify({
      id: "legacy-no-issuekey-1",
      timestamp: new Date().toISOString(),
      severity: "WARNING",
      workflow: "weekly-security",
      step: "secret-scan",
      finding: "pre-normalization legacy row",
      status: "open",
    });
    appendFileSync(alertsLogPath, legacyLine + "\n");

    const reduced = alertManager.readAlerts();
    const found = reduced.find((a) => a.id === "legacy-no-issuekey-1");
    expect(found).toBeDefined();
    expect(found?.issueKey).toBeUndefined();
  });
});

// ============================================================================
// A4 — N1 alert-closure program: supersede-on-write, the resolveAbsent
// bridge, id-threading (evaluate() <-> disk), and refireOpenCriticalAlerts's
// stored-issueKey preference. All hermetic via this file's existing
// beforeEach (scratch alertsLogPath, injected AlertGate, pinned KAYA_HOME).
// ============================================================================

describe("supersede-on-write (A4)", () => {
  it("two consecutive evaluate() runs of the same recurring issue leave exactly ONE open row (the latest); the raw file shows the full audit trail: open, dismissed(system), open", async () => {
    const finding = { workflow: "daily", step: "integrity", type: "broken_symlink", finding: "broken_symlink: bin/old-tool" };

    const first = await alertManager.evaluate([finding], healthTracker, "daily");
    const second = await alertManager.evaluate([finding], healthTracker, "daily");

    expect(first.alerts[0]!.id).not.toBe(second.alerts[0]!.id);

    const reduced = alertManager.readAlerts();
    const openRows = reduced.filter((a) => a.finding === finding.finding && a.status === "open");
    expect(openRows.length).toBe(1);
    expect(openRows[0]!.id).toBe(second.alerts[0]!.id);

    const raw = readFileSync(alertsLogPath, "utf-8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Alert)
      .filter((a) => a.finding === finding.finding);

    expect(raw.length).toBe(3);
    expect(raw[0]!.status).toBe("open");
    expect(raw[0]!.id).toBe(first.alerts[0]!.id);
    expect(raw[1]!.status).toBe("dismissed");
    expect(raw[1]!.id).toBe(first.alerts[0]!.id);
    expect(raw[1]!.dismissedBy).toBe("system");
    expect(raw[2]!.status).toBe("open");
    expect(raw[2]!.id).toBe(second.alerts[0]!.id);
  });

  it("supersedes WARNING/INFO recurring issues too, not just CRITICAL (ALL severities)", async () => {
    const finding = { workflow: "weekly-security", step: "secret-scan", type: "potential_secret", finding: "200 potential secrets detected", verified: false, count: 200 };

    const first = await alertManager.evaluate([finding], healthTracker, "weekly-security");
    expect(first.alerts[0]!.severity).toBe("WARNING");

    const second = await alertManager.evaluate([finding], healthTracker, "weekly-security");
    expect(second.alerts[0]!.severity).toBe("WARNING");

    const reduced = alertManager.readAlerts();
    const openRows = reduced.filter((a) => a.finding === finding.finding && a.status === "open");
    const dismissedRows = reduced.filter((a) => a.finding === finding.finding && a.status === "dismissed");
    expect(openRows.length).toBe(1);
    expect(openRows[0]!.id).toBe(second.alerts[0]!.id);
    expect(dismissedRows.length).toBe(1);
    expect(dismissedRows[0]!.id).toBe(first.alerts[0]!.id);
    expect(dismissedRows[0]!.dismissedBy).toBe("system");
  });

  it("legacy rows (no stored issueKey) are NEVER auto-dismissed, even with byte-identical content written twice", () => {
    const finding = { workflow: "daily", step: "integrity", type: "test_finding", finding: "legacy duplicate content fixture" };

    // Two-arg writeAlert() calls — legacy call shape, no issueKey threaded.
    alertManager.writeAlert(finding, "WARNING");
    alertManager.writeAlert(finding, "WARNING");

    const reduced = alertManager.readAlerts();
    const rows = reduced.filter((a) => a.finding === "legacy duplicate content fixture");
    expect(rows.length).toBe(2);
    expect(rows.every((a) => a.status === "open")).toBe(true);
    expect(rows.every((a) => a.issueKey === undefined)).toBe(true);
  });
});

describe("resolveAbsent bridge (A4)", () => {
  it("an issue that stops reproducing has its open alert row dismissed (system) after resolveAbsent resolves it; an unrelated still-reproducing issue's CURRENT open row is untouched", async () => {
    const staleFinding = { workflow: "daily", step: "integrity", type: "broken_symlink", finding: "broken_symlink: bin/old-tool" };
    const unrelatedFinding = { workflow: "daily", step: "integrity", type: "git_dirty", finding: "3600 modified files" };

    const first = await alertManager.evaluate([staleFinding, unrelatedFinding], healthTracker, "daily");
    const staleAlert = first.alerts.find((a) => a.finding === staleFinding.finding)!;
    const unrelatedAlertFirst = first.alerts.find((a) => a.finding === unrelatedFinding.finding)!;

    // Second scan: staleFinding no longer reproduces; unrelatedFinding still does.
    const second = await alertManager.evaluate([unrelatedFinding], healthTracker, "daily");
    const unrelatedAlertSecond = second.alerts[0]!;

    expect(second.resolvedKeys).toEqual([staleAlert.issueKey]);

    const reduced = alertManager.readAlerts();

    const staleRow = reduced.find((a) => a.id === staleAlert.id);
    expect(staleRow?.status).toBe("dismissed");
    expect(staleRow?.dismissedBy).toBe("system");

    // unrelatedFinding's FIRST row was superseded by the second scan's own
    // supersede-on-write (a different mechanism) — its SECOND (latest) row
    // must remain open, untouched by the resolveAbsent bridge.
    const unrelatedFirstRow = reduced.find((a) => a.id === unrelatedAlertFirst.id);
    expect(unrelatedFirstRow?.status).toBe("dismissed");
    expect(unrelatedFirstRow?.dismissedBy).toBe("system");
    const unrelatedSecondRow = reduced.find((a) => a.id === unrelatedAlertSecond.id);
    expect(unrelatedSecondRow?.status).toBe("open");
  });

  it("a legacy row (no stored issueKey) is NEVER auto-dismissed by the bridge, even though its content matches a resolved issue", async () => {
    const staleFinding = { workflow: "daily", step: "integrity", type: "broken_symlink", finding: "broken_symlink: bin/legacy-tool" };

    // A legacy row for this exact finding — written with the 2-arg call shape (no issueKey threaded).
    alertManager.writeAlert(staleFinding, "INFO");

    // Seed HealthTracker as if this issue had been tracked (simulating a
    // legacy scan that predates issueKey stamping but still recorded occurrences).
    const staleKey = generateIssueKey(staleFinding.workflow, staleFinding.step, staleFinding.finding);
    healthTracker.record(staleKey, {
      lastSeen: new Date().toISOString(),
      type: staleFinding.type,
      finding: staleFinding.finding,
      status: "monitoring",
    });

    // Next scan: the finding no longer reproduces.
    const result = await alertManager.evaluate([], healthTracker, "daily");

    expect(result.resolvedKeys).toEqual([staleKey]);

    const reduced = alertManager.readAlerts();
    const legacyRow = reduced.find((a) => a.finding === staleFinding.finding);
    expect(legacyRow?.status).toBe("open");
    expect(legacyRow?.issueKey).toBeUndefined();
  });
});

describe("id-threading (A4): evaluate()'s returned Alert.id matches the persisted row's id", () => {
  it("every id in evaluate()'s returned alerts exists in the raw alerts.jsonl file", async () => {
    const findings = [
      { workflow: "daily", step: "integrity", type: "verified_secret", finding: "id-threading fixture A", verified: true },
      { workflow: "daily", step: "integrity", type: "git_dirty", finding: "id-threading fixture B" },
    ];

    const result = await alertManager.evaluate(findings, healthTracker, "daily");

    const rawIds = readFileSync(alertsLogPath, "utf-8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => (JSON.parse(l) as Alert).id);

    expect(result.alerts.length).toBe(2);
    for (const alert of result.alerts) {
      expect(rawIds).toContain(alert.id);
    }
  });
});

describe("refireOpenCriticalAlerts uses the STORED issueKey, not a recompute (A4)", () => {
  it("a row whose stored issueKey deliberately differs from generateIssueKey()'s recompute stamps AlertGate's cooldown under the STORED key, not the recomputed one (the legacy-drift scenario)", async () => {
    const alert: Alert = {
      id: "legacy-drift-1",
      // Deliberately NOT what generateIssueKey(workflow, step, finding) would
      // compute today — simulates the exact pre-normalization legacy-drift
      // scenario this fallback preference exists to avoid regressing on.
      issueKey: "daily:integrity:deadbeef",
      timestamp: new Date().toISOString(),
      severity: "CRITICAL",
      workflow: "daily",
      step: "integrity",
      finding: "3600 modified files",
      status: "open",
    };
    const recomputedKey = generateIssueKey(alert.workflow, alert.step, alert.finding);
    expect(recomputedKey).not.toBe(alert.issueKey); // sanity: proves the drift is real

    const result = await alertManager.refireOpenCriticalAlerts([alert]);

    expect(result.refiredCount).toBe(1);
    // Digest tier (2026-07-31) does not stamp a cooldown in alert-gate.json,
    // so the AlertGate key now shows up on the spool row instead. The
    // property under test is unchanged: the STORED issueKey is what gets
    // used, never generateIssueKey()'s recompute.
    const keys = readSpool(scratchDir).map((e) => e.key);
    expect(keys).toContain(`automaintenance-alert-${alert.issueKey}`);
    expect(keys).not.toContain(`automaintenance-alert-${recomputedKey}`);
  });

  it("a row with no stored issueKey (legacy) falls back to the recompute", async () => {
    const alert: Alert = {
      id: "legacy-no-key-1",
      timestamp: new Date().toISOString(),
      severity: "CRITICAL",
      workflow: "daily",
      step: "integrity",
      finding: "legacy fallback fixture",
      status: "open",
    };
    const recomputedKey = generateIssueKey(alert.workflow, alert.step, alert.finding);

    const result = await alertManager.refireOpenCriticalAlerts([alert]);

    expect(result.refiredCount).toBe(1);
    // See the sibling test: digest tier moves the key from alert-gate.json's
    // cooldown map onto the spool row.
    expect(readSpool(scratchDir).map((e) => e.key)).toContain(`automaintenance-alert-${recomputedKey}`);
  });
});

// ============================================================================
// Hermetic guard subprocess regressions (Gap A / Gap B, 2026-07-20 incident)
//
// These reproduce the historical failure mode directly: AlertManager
// constructed WITHOUT an alertsLogPath override (the exact shape of the
// ad-hoc verify scripts that wrote 20 synthetic rows into the live
// alerts.jsonl on 2026-07-20), run in a REAL subprocess (not this test
// process) via __fixtures__/GapGuardRepro.ts, asserting the guard throws
// before any fs write happens.
//
// DESIGN / WHY A SUBPROCESS (and why this can't be made fully side-effect-
// proof against a genuine regression): AlertManager's ledger path
// (defaultKayaHome()) is a hardcoded real-home path by design — it ignores
// KAYA_HOME/KAYA_DIR entirely, which is the whole point of the Gap-B bug
// being fixed. That means there is no sandboxable "wrong" path for a
// regressed guard to write to instead of the live one — if
// assertNotLiveDefaultUnderTest() itself regressed (e.g. someone re-added a
// getKayaHome()===defaultKayaHome() comparison, reintroducing Gap B), the
// fixture's writeAlert() call WOULD append a real row to the live
// alerts.jsonl in the child process, exactly like the incident. Given that,
// this suite:
//   1. Isolates the risk to a subprocess so the fixture's own module-level
//      side effects can never contaminate this test's process/state.
//   2. Relies on the guard call being the literal FIRST statement in
//      appendAlertEntry() (see AlertManager.ts) — before any dirname/
//      mkdirSync/createAppendLog — so a CORRECT implementation throws
//      before touching the filesystem at all, meaning these tests have zero
//      live side effects on the happy (guard-fires) path, which is the
//      path they exercise every time the guard is actually correct.
//   3. Re-checks the live alerts.jsonl's sha256+mtime signature immediately
//      before/after each spawnSync call (belt) in addition to this whole
//      file's suite-wide beforeAll/afterAll canary (suspenders, A1) — so a
//      genuine regression that DOES write live fails LOUDLY on two
//      independent assertions instead of being silently absorbed.
// There is no design that lets a real regression here be caught without any
// possibility of a live write — testing "does the guard block the real
// path" inherently requires exercising the real path when the guard is
// broken. This is the same tradeoff assertNotLiveHomeUnderTest's own
// KayaHome.test.ts accepts (it never runs against the live path either,
// but AlertManager's is hardcoded rather than env-driven, which is exactly
// why Gap B existed).
// ============================================================================

describe("hermetic guard subprocess regressions (Gap A / Gap B, 2026-07-20 incident)", () => {
  const FIXTURE_PATH = join(import.meta.dir, "__fixtures__", "GapGuardRepro.ts");

  it("Gap-B regression (exact 07-20 repro): NODE_ENV=test + KAYA_HOME pinned to a scratch dir + no alertsLogPath override still THROWS", () => {
    // Before this fix, the OLD guard's `getKayaHome() === defaultKayaHome()`
    // condition was made FALSE by this exact KAYA_HOME pin, silently
    // disabling the guard while appendAlertEntry() still wrote to the real
    // defaultKayaHome() ledger path underneath it.
    const beforeSig = liveAlertsLogSignature();
    const scratchHome = mkdtempSync(join(tmpdir(), "gap-b-repro-home-"));

    const env = { ...process.env, NODE_ENV: "test", KAYA_HOME: scratchHome };
    delete env.KAYA_VERIFY_SESSION;

    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync("bun", [FIXTURE_PATH], { env, encoding: "utf-8" });
    } finally {
      rmSync(scratchHome, { recursive: true, force: true });
    }

    expect(result.status).not.toBe(0);
    expect(result.stderr ?? "").toContain("[hermetic-guard] AlertManager.writeAlert");
    expect(result.stdout ?? "").not.toContain("GAP_GUARD_DID_NOT_THROW");
    expect(liveAlertsLogSignature()).toEqual(beforeSig);
  });

  it("Gap-A tripwire: NODE_ENV unset + KAYA_VERIFY_SESSION=1 (no bun test at all, mirrors an ad-hoc verify script) still THROWS", () => {
    // Before this fix, an ad-hoc script that never set NODE_ENV=test (Gap A)
    // sailed straight past assertNotLiveHomeUnderTest's NODE_ENV check —
    // this proves the sanctioned KAYA_VERIFY_SESSION marker alone is
    // sufficient to trip the new guard even with NODE_ENV completely unset.
    const beforeSig = liveAlertsLogSignature();

    const env = { ...process.env, KAYA_VERIFY_SESSION: "1" };
    delete env.NODE_ENV;
    delete env.KAYA_HOME;

    const result = spawnSync("bun", [FIXTURE_PATH], { env, encoding: "utf-8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr ?? "").toContain("[hermetic-guard] AlertManager.writeAlert");
    expect(result.stdout ?? "").not.toContain("GAP_GUARD_DID_NOT_THROW");
    expect(liveAlertsLogSignature()).toEqual(beforeSig);
  });
});
