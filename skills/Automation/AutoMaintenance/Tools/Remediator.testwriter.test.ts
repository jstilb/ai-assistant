/**
 * Remediator - Test Suite (TestWriter)
 * ISC Coverage: R-01, R-02, R-03, R-04, D-05, D-06
 *
 * Hermetic: every Remediator.run() call passes a remediationLogPath override
 * (a per-test mkdtemp file) so the suite never touches the real
 * ~/.claude/MEMORY/AutoMaintenance/remediation.jsonl — per Track C slice 3.2
 * of the alert-storm remediation plan. See Remediator.ts's RemediationOptions
 * for the DI shape.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, mkdtempSync, rmSync, lstatSync } from "fs";

// existsSync FOLLOWS symlinks, so it returns false for a dangling one — these
// tests create deliberately-broken symlinks, so "the link itself exists" must
// be checked with lstat (which does not follow).
function symlinkItselfExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
import { join } from "path";
import { tmpdir } from "os";
import { Remediator } from "./Remediator";

let scratchDir: string;
let TEST_DIR: string;
let REMEDIATION_LOG: string;

describe("Remediator", () => {
  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), "remediator-test-"));
    TEST_DIR = join(scratchDir, "test-remediator");
    REMEDIATION_LOG = join(scratchDir, "remediation.jsonl");
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  describe("removeBrokenSymlink", () => {
    it("should remove broken symlink on first detection", async () => {
      // ISC R-01: Broken symlink removed on first detection
      const symlinkPath = join(TEST_DIR, "broken-link");
      const nonexistentTarget = join(TEST_DIR, "does-not-exist");

      symlinkSync(nonexistentTarget, symlinkPath);
      expect(symlinkItselfExists(symlinkPath)).toBe(true);

      const findings = [
        { type: "broken_symlink", target: symlinkPath }
      ];

      await Remediator.run(findings, { remediationLogPath: REMEDIATION_LOG });

      // ISC D-05: Broken symlinks are removed, not just reported
      expect(symlinkItselfExists(symlinkPath)).toBe(false);
    });

    it("should log remediation to the scratch remediation.jsonl", async () => {
      // ISC D-06: Remediation logged for each removed symlink
      const symlinkPath = join(TEST_DIR, "broken-link-2");
      const nonexistentTarget = join(TEST_DIR, "does-not-exist-2");

      symlinkSync(nonexistentTarget, symlinkPath);

      const findings = [
        { type: "broken_symlink", target: symlinkPath }
      ];

      await Remediator.run(findings, { remediationLogPath: REMEDIATION_LOG });

      const logContent = readFileSync(REMEDIATION_LOG, "utf-8");
      const lastLine = logContent.trim().split("\n").pop();
      const logEntry = JSON.parse(lastLine!);

      expect(logEntry.action).toBe("removed_symlink");
      expect(logEntry.target).toBe(symlinkPath);
      expect(logEntry.dryRun).toBe(false);
    });

    it("should never remove symlink whose target exists", async () => {
      // ISC R-03: Remediator never removes symlink whose target exists
      const targetPath = join(TEST_DIR, "valid-target");
      const symlinkPath = join(TEST_DIR, "valid-link");

      writeFileSync(targetPath, "test content");
      symlinkSync(targetPath, symlinkPath);

      const findings = [
        { type: "broken_symlink", target: symlinkPath }
      ];

      await Remediator.run(findings, { remediationLogPath: REMEDIATION_LOG });

      // Symlink should still exist
      expect(existsSync(symlinkPath)).toBe(true);
      expect(existsSync(targetPath)).toBe(true);
    });
  });

  describe("dry-run mode", () => {
    it("should not remove symlinks when --dry-run flag passed", async () => {
      // ISC R-02: Remediation uses dry-run mode when --dry-run flag passed
      const symlinkPath = join(TEST_DIR, "dry-run-link");
      const nonexistentTarget = join(TEST_DIR, "does-not-exist-3");

      symlinkSync(nonexistentTarget, symlinkPath);
      expect(symlinkItselfExists(symlinkPath)).toBe(true);

      const findings = [
        { type: "broken_symlink", target: symlinkPath }
      ];

      await Remediator.run(findings, { dryRun: true, remediationLogPath: REMEDIATION_LOG });

      // Symlink should still exist in dry-run mode
      expect(symlinkItselfExists(symlinkPath)).toBe(true);
    });

    it("should log with dryRun: true in remediation.jsonl", async () => {
      const symlinkPath = join(TEST_DIR, "dry-run-link-2");
      const nonexistentTarget = join(TEST_DIR, "does-not-exist-4");

      symlinkSync(nonexistentTarget, symlinkPath);

      const findings = [
        { type: "broken_symlink", target: symlinkPath }
      ];

      await Remediator.run(findings, { dryRun: true, remediationLogPath: REMEDIATION_LOG });

      const logContent = readFileSync(REMEDIATION_LOG, "utf-8");
      const lastLine = logContent.trim().split("\n").pop();
      const logEntry = JSON.parse(lastLine!);

      expect(logEntry.dryRun).toBe(true);
    });
  });

  describe("remediation failure", () => {
    it("should escalate to alert when remediation fails", async () => {
      // ISC R-04: Remediation failure escalates to alert
      const protectedPath = "/protected/cannot-remove";

      const findings = [
        { type: "broken_symlink", target: protectedPath }
      ];

      const result = await Remediator.run(findings, { remediationLogPath: REMEDIATION_LOG });

      expect(result.failures.length).toBeGreaterThan(0);
      expect(result.failures[0].target).toBe(protectedPath);
      expect(result.failures[0].shouldEscalate).toBe(true);
    });
  });

  describe("log rotation", () => {
    it("should delete files older than retention threshold", async () => {
      const oldLogPath = join(TEST_DIR, "old-log.log");
      writeFileSync(oldLogPath, "old log content");

      const findings = [
        {
          type: "rotate_log",
          target: oldLogPath,
          ageInDays: 15,
          threshold: 14
        }
      ];

      await Remediator.run(findings, { remediationLogPath: REMEDIATION_LOG });

      expect(existsSync(oldLogPath)).toBe(false);
    });
  });
});
