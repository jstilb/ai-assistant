#!/usr/bin/env bun
/**
 * GapGuardRepro — subprocess fixture for the Gap-A/Gap-B hermetic-guard
 * regression tests in AlertManager.testwriter.test.ts ("hermetic guard
 * subprocess regressions" describe block).
 *
 * Deliberately calls AlertManager.writeAlert() with NO alertsLogPath
 * override — the exact shape of the 2026-07-20 incident (an ad-hoc script
 * driving AlertManager against the real, hardcoded defaultKayaHome() ledger
 * path). The test harness spawns THIS file as a child process with a
 * specific, controlled env (see the two spawnSync call sites in
 * AlertManager.testwriter.test.ts) and asserts it exits non-zero with the
 * hermetic-guard error on stderr.
 *
 * NEVER import this file directly into a `bun test` process, and never run
 * it manually without first pinning env the way the tests do — the whole
 * point is that appendAlertEntry()'s guard is the ONLY thing standing
 * between this script and a real write to the live alerts.jsonl. If the
 * guard is ever weakened, running this file wrong will prove it the hard
 * way.
 *
 * Does not touch HealthTracker's persistence at all — writeAlert() never
 * reads/writes the healthTracker argument, so an unloaded HealthTracker
 * instance is passed purely to satisfy AlertManager's constructor.
 */
import { AlertManager } from "../AlertManager";
import { HealthTracker } from "../HealthTracker";

const alertManager = new AlertManager(new HealthTracker());
alertManager.writeAlert(
  {
    workflow: "gap-guard-repro",
    step: "subprocess-fixture",
    type: "test_finding",
    finding: "GAP-GUARD-REPRO-CANARY — must never reach the live alerts.jsonl",
  },
  "INFO",
);

// Only reached if the guard failed to throw — i.e. a regression.
console.log("GAP_GUARD_DID_NOT_THROW");
