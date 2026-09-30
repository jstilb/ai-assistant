/**
 * VerifyHarness - Test Suite
 *
 * Smoke tests for the sanctioned manual/agent verification harness (see
 * VerifyHarness.ts's docblock for why it exists — the 2026-07-20 incident).
 * Proves makeVerifyHarness() actually writes to its scratch dir and never
 * touches the live alerts.jsonl, mirroring the live-file canary convention
 * used across this directory's other test files (AlertManager.testwriter.
 * test.ts, HealthTracker.testwriter.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { makeVerifyHarness, teardownVerifyHarness } from "./VerifyHarness";
import { defaultKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================================================
// Regression guard: the real, unpinned alerts.jsonl must be byte- and
// mtime-identical before and after this whole suite runs.
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
  // Leave no pin behind for whatever test file bun runs next in this process.
  teardownVerifyHarness();
});

describe("VerifyHarness", () => {
  it("writes an alert through the harness to the scratch alerts.jsonl, never the live one", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "verify-harness-smoke-"));
    try {
      const harness = await makeVerifyHarness(scratchDir);

      harness.alertManager.writeAlert(
        {
          workflow: "verify-harness-smoke",
          step: "smoke-test",
          type: "test_finding",
          finding: "VerifyHarness smoke-test canary",
        },
        "INFO",
      );

      expect(existsSync(harness.alertsLogPath)).toBe(true);
      expect(harness.alertsLogPath.startsWith(scratchDir)).toBe(true);
      const content = readFileSync(harness.alertsLogPath, "utf-8");
      expect(content).toContain("VerifyHarness smoke-test canary");
    } finally {
      teardownVerifyHarness();
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("evaluate() classifies severity via the scratch HealthTracker and routes through the injected (recording) gate, not real Telegram", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "verify-harness-smoke-eval-"));
    try {
      const harness = await makeVerifyHarness(scratchDir);

      const result = await harness.alertManager.evaluate(
        [
          {
            workflow: "daily",
            step: "integrity",
            type: "verified_secret",
            finding: "VerifyHarness eval canary",
            verified: true,
          },
        ],
        harness.healthTracker,
        "daily",
      );

      expect(result.alerts.length).toBe(1);
      expect(result.alerts[0]!.severity).toBe("CRITICAL");
      expect(harness.sent.length).toBeGreaterThan(0);
      expect(harness.sent[0]!.message).toContain("VerifyHarness eval canary");

      const content = readFileSync(harness.alertsLogPath, "utf-8");
      expect(content).toContain("VerifyHarness eval canary");
    } finally {
      teardownVerifyHarness();
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// A2 follow-up (2026-07-22): teardownVerifyHarness() used to unconditionally
// `delete process.env.KAYA_HOME` — clobbering a caller's own pre-existing
// KAYA_HOME pin instead of restoring it. It now snapshots the prior value
// (set-to-X, or genuinely unset) at makeVerifyHarness() time and restores
// exactly that at teardown. These tests exercise both branches directly,
// saving/restoring the real process.env.KAYA_HOME around each so no state
// bleeds into any other test file bun may run in this same process.
// ============================================================================

describe("teardownVerifyHarness KAYA_HOME restoration (A2 follow-up)", () => {
  it("restores KAYA_HOME to its exact prior value when it was already set before the harness pinned it", async () => {
    const originalKayaHome = process.env.KAYA_HOME;
    const priorSentinel = "/some/prior/kaya-home-sentinel";
    process.env.KAYA_HOME = priorSentinel;
    const scratchDir = mkdtempSync(join(tmpdir(), "verify-harness-restore-set-"));
    try {
      await makeVerifyHarness(scratchDir);
      // While the harness is live, KAYA_HOME is pinned to the scratch home, not the prior sentinel.
      expect(process.env.KAYA_HOME).not.toBe(priorSentinel);

      teardownVerifyHarness();

      expect(process.env.KAYA_HOME).toBe(priorSentinel);
    } finally {
      if (originalKayaHome === undefined) delete process.env.KAYA_HOME;
      else process.env.KAYA_HOME = originalKayaHome;
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("leaves KAYA_HOME unset after teardown when it was genuinely unset before the harness pinned it", async () => {
    const originalKayaHome = process.env.KAYA_HOME;
    delete process.env.KAYA_HOME;
    const scratchDir = mkdtempSync(join(tmpdir(), "verify-harness-restore-unset-"));
    try {
      await makeVerifyHarness(scratchDir);
      expect(process.env.KAYA_HOME).toBeDefined();

      teardownVerifyHarness();

      expect(process.env.KAYA_HOME).toBeUndefined();
    } finally {
      if (originalKayaHome === undefined) delete process.env.KAYA_HOME;
      else process.env.KAYA_HOME = originalKayaHome;
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
