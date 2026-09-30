#!/usr/bin/env bun
/**
 * VerifyHarness — sanctioned scratch-dir harness for manual/agent ISC
 * verification of AutoMaintenance alerting (AlertManager + HealthTracker),
 * end-to-end, without ever touching live Kaya home state.
 *
 * WHY THIS EXISTS (2026-07-20 incident): ad-hoc verify scripts drove
 * AlertManager.evaluate() directly, outside `bun test`, and wrote 20
 * synthetic rows into the LIVE alerts.jsonl. Two gaps let that happen:
 *   - Gap A: the scripts never set NODE_ENV=test, so the hermetic guard
 *     (assertNotLiveHomeUnderTest, at the time) never even evaluated.
 *   - Gap B: AlertManager's ledger path hardcodes defaultKayaHome()
 *     regardless of KAYA_HOME/KAYA_DIR (a documented exemption — see
 *     AlertManager.ts's module-level comment), so pinning KAYA_HOME to a
 *     scratch dir would have silently DISABLED the old guard's
 *     getKayaHome()===defaultKayaHome() condition while the write still
 *     landed on the live default home.
 *
 * assertNotLiveDefaultUnderTest() (lib/core/KayaHome.ts) closes both gaps
 * for any code path that reaches AlertManager.appendAlertEntry() without a
 * DI override — but the actually-sanctioned fix for a human/agent who wants
 * to exercise alerting manually is to never reach that branch at all. This
 * file is that path: it builds every component with its existing scratch-dir
 * DI override wired up front, so there is no live-write branch to
 * accidentally hit in the first place.
 *
 * USAGE (manual or agent-driven ISC verification):
 *   import { mkdtempSync, rmSync } from "fs";
 *   import { tmpdir } from "os";
 *   import { join } from "path";
 *   import { makeVerifyHarness, teardownVerifyHarness } from "./VerifyHarness.ts";
 *
 *   const scratchDir = mkdtempSync(join(tmpdir(), "alerting-verify-"));
 *   const harness = await makeVerifyHarness(scratchDir);
 *   try {
 *     const result = await harness.alertManager.evaluate(
 *       [{ workflow: "daily", step: "integrity", type: "verified_secret", finding: "example", verified: true }],
 *       harness.healthTracker,
 *       "daily",
 *     );
 *     console.log(result, harness.sent, harness.alertsLogPath);
 *   } finally {
 *     teardownVerifyHarness();
 *     rmSync(scratchDir, { recursive: true, force: true });
 *   }
 *
 * This is NOT a test file (no bun:test import) — it's meant to be imported
 * from a one-off script, a REPL, or an agent's ad-hoc verify session. It IS,
 * however, exactly what this repo's hermetic test suites already do by hand
 * in every AutoMaintenance test file (see AlertManager.testwriter.test.ts /
 * HealthTracker.testwriter.test.ts) — this factory exists so a future
 * ad-hoc/manual verification doesn't have to reinvent (or forget) that
 * pin+reset dance the way the 2026-07-20 scripts did.
 */

import { mkdirSync } from "fs";
import { join } from "path";
import { AlertManager } from "./AlertManager";
import { HealthTracker } from "./HealthTracker";
import { _resetHealthManagerForTest } from "./HealthManager";
import { AlertGate } from "../../../../lib/core/AlertGate.ts";

export interface RecordedSend {
  message: string;
  channel: string;
}

/**
 * Snapshot of process.env.KAYA_HOME taken by makeVerifyHarness() just before
 * it pins the env var, so teardownVerifyHarness() can restore the exact
 * prior state (set-to-value vs genuinely-unset) instead of unconditionally
 * deleting the var — an unconditional delete would clobber a caller's own
 * pre-existing KAYA_HOME override. `null` means no harness has been made
 * (or teardown already ran) since the last pin.
 */
let priorKayaHomeSnapshot: { wasSet: boolean; value: string | undefined } | null = null;

export interface VerifyHarness {
  alertManager: AlertManager;
  healthTracker: HealthTracker;
  gate: AlertGate;
  /** Scratch-rooted alerts.jsonl path — never the live ledger. */
  alertsLogPath: string;
  /** Every message the gate would have sent — recorded, never delivered. */
  sent: RecordedSend[];
}

/**
 * Builds an AlertManager + HealthTracker + AlertGate wired entirely to files
 * under `scratchDir`, via each component's existing DI override params —
 * mirrors the pin+reset+DI pattern already used by this directory's hermetic
 * test suites (AlertManager.testwriter.test.ts's makeGate()/beforeEach,
 * HealthTracker.testwriter.test.ts's beforeEach).
 *
 * HealthTracker has no path-override constructor param (unlike
 * AlertManager/AlertGate) — its persistence goes through HealthManager's
 * module-level StateManager singleton, itself resolved from getKayaHome().
 * The only working DI mechanism for it is env + a singleton reset, so this
 * function pins `process.env.KAYA_HOME` to `<scratchDir>/home` and calls
 * `_resetHealthManagerForTest()` as a side effect — deliberately, rather than
 * documenting that the caller must remember to do it. Forgetting exactly
 * that discipline is the root-cause shape of the incident this harness
 * exists to prevent. Call `teardownVerifyHarness()` when done to undo the
 * env pin and reset the singleton again for whatever runs next in this
 * process.
 *
 * `scratchDir` is caller-supplied and caller-owned (mkdtemp it yourself) —
 * this function creates subdirectories under it but never deletes
 * `scratchDir` itself; that cleanup is the caller's job.
 */
export async function makeVerifyHarness(scratchDir: string): Promise<VerifyHarness> {
  const testHome = join(scratchDir, "home");
  mkdirSync(join(testHome, "MEMORY", "AutoMaintenance"), { recursive: true });
  // Snapshot whatever KAYA_HOME was (set-to-a-value, or genuinely unset)
  // BEFORE pinning it, so teardownVerifyHarness() can restore exactly that
  // instead of unconditionally deleting — see teardownVerifyHarness()'s
  // docblock for why an unconditional delete is wrong when a caller already
  // had KAYA_HOME pinned (e.g. a nested/second harness, or a caller running
  // under its own KAYA_HOME override) before calling this function.
  priorKayaHomeSnapshot = { wasSet: "KAYA_HOME" in process.env, value: process.env.KAYA_HOME };
  process.env.KAYA_HOME = testHome;
  _resetHealthManagerForTest();

  const alertsLogPath = join(scratchDir, "alerts.jsonl");
  const sent: RecordedSend[] = [];
  const gate = new AlertGate({
    statePath: join(scratchDir, "alert-gate.json"),
    spoolPath: join(scratchDir, "digest-spool.jsonl"),
    archivePath: join(scratchDir, "digest-spool-archive.jsonl"),
    send: async (message, channel) => {
      sent.push({ message, channel });
      return true;
    },
  });

  const healthTracker = new HealthTracker();
  await healthTracker.load();

  const alertManager = new AlertManager(healthTracker, { alertsLogPath, gate });

  return { alertManager, healthTracker, gate, alertsLogPath, sent };
}

/**
 * Undoes makeVerifyHarness()'s process.env pin and resets the HealthManager
 * singleton — call after you're done with a harness (and before rmSync'ing
 * its scratchDir) so a later makeVerifyHarness() call, or any other code
 * sharing this process, doesn't inherit a KAYA_HOME pointing at a directory
 * you're about to delete.
 *
 * Restores the EXACT prior KAYA_HOME captured by makeVerifyHarness() —
 * setting it back to its prior value if it was set, deleting it if it was
 * genuinely unset — rather than unconditionally deleting the var. An
 * unconditional delete is wrong whenever the caller (or an enclosing test
 * file's own setup) already had KAYA_HOME pinned to something before this
 * harness ran: deleting it would silently strip that caller's pin instead of
 * restoring it, which is exactly the kind of state-bleed this harness exists
 * to prevent (see this file's header comment).
 */
export function teardownVerifyHarness(): void {
  if (priorKayaHomeSnapshot) {
    if (priorKayaHomeSnapshot.wasSet) {
      process.env.KAYA_HOME = priorKayaHomeSnapshot.value;
    } else {
      delete process.env.KAYA_HOME;
    }
    priorKayaHomeSnapshot = null;
  } else {
    // No pin recorded (teardown called without a matching makeVerifyHarness,
    // or already torn down) — nothing to restore. Do NOT delete KAYA_HOME
    // here: with no snapshot we can't know whether the current value is
    // this harness's pin or a caller's own, so deleting would risk
    // clobbering the latter.
  }
  _resetHealthManagerForTest();
}
