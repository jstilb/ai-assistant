#!/usr/bin/env bun
/**
 * Remediator - Auto-remediation actions
 *
 * PURPOSE:
 * Execute safe, auto-remediable actions: remove broken symlinks, rotate logs,
 * cleanup temp files. Supports dry-run mode for preview. Logs all actions to
 * remediation.jsonl for audit trail.
 *
 * SAFETY MODEL:
 * - Only removes symlink where lstat succeeds but stat fails (target doesn't exist)
 * - Never removes symlink whose target exists
 * - All destructive actions logged to remediation.jsonl
 * - Failures escalate to AlertManager
 */

import { existsSync, lstatSync, statSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createAppendLog } from '../../../../lib/core/AppendLog';
import { defaultKayaHome, assertNotLiveHomeUnderTest } from '../../../../lib/core/KayaHome.ts';

// homedir-only original (ignored KAYA_HOME env); defaultKayaHome() preserves real-home
const KAYA_HOME = defaultKayaHome();
const REMEDIATION_LOG = join(KAYA_HOME, 'MEMORY', 'AutoMaintenance', 'remediation.jsonl');

export interface Finding {
  type: string;
  target: string;
  workflow?: string;
  ageInDays?: number;
  threshold?: number;
}

export interface RemediationOptions {
  dryRun?: boolean;
  /**
   * Override for the remediation.jsonl write path (tests only). When
   * omitted, resolves to the module-level REMEDIATION_LOG — a frozen
   * real-home path that deliberately ignores KAYA_HOME (see the
   * module-level comment above; inline-KAYA_HOME burn-down exemption for
   * this file, NOT a bug) — with a hermetic-guard tripwire on every write.
   */
  remediationLogPath?: string;
}

export interface RemediationResult {
  success: string[];
  failures: Array<{ target: string; error: string; shouldEscalate: boolean }>;
}

export class Remediator {
  /**
   * Run remediation on findings
   */
  static async run(findings: Finding[], options: RemediationOptions = {}): Promise<RemediationResult> {
    const result: RemediationResult = {
      success: [],
      failures: [],
    };

    const dryRun = options.dryRun || false;
    const remediationLogPath = options.remediationLogPath ?? REMEDIATION_LOG;

    for (const finding of findings) {
      if (finding.type === 'broken_symlink') {
        try {
          // Verify symlink is actually broken
          const isBroken = this.isSymlinkBroken(finding.target);

          if (!isBroken) {
            // Target exists or not a symlink - escalate as failure
            result.failures.push({
              target: finding.target,
              error: 'Not a broken symlink (target exists or not a symlink)',
              shouldEscalate: true,
            });
            continue;
          }

          if (!dryRun) {
            unlinkSync(finding.target);
          }

          // Log remediation
          this.logRemediation(remediationLogPath, !options.remediationLogPath, {
            timestamp: new Date().toISOString(),
            workflow: finding.workflow || 'unknown',
            action: 'removed_symlink',
            target: finding.target,
            dryRun,
          });

          result.success.push(finding.target);
        } catch (error: any) {
          result.failures.push({
            target: finding.target,
            error: error.message,
            shouldEscalate: true,
          });
        }
      } else if (finding.type === 'rotate_log') {
        try {
          // Check age threshold
          if (finding.ageInDays !== undefined && finding.threshold !== undefined) {
            if (finding.ageInDays >= finding.threshold) {
              if (!dryRun && existsSync(finding.target)) {
                unlinkSync(finding.target);
              }

              this.logRemediation(remediationLogPath, !options.remediationLogPath, {
                timestamp: new Date().toISOString(),
                workflow: finding.workflow || 'unknown',
                action: 'deleted_file',
                target: finding.target,
                dryRun,
              });

              result.success.push(finding.target);
            }
          }
        } catch (error: any) {
          result.failures.push({
            target: finding.target,
            error: error.message,
            shouldEscalate: true,
          });
        }
      }
    }

    return result;
  }

  /**
   * Check if symlink is broken (lstat succeeds but stat fails)
   */
  private static isSymlinkBroken(path: string): boolean {
    try {
      // Check if symlink exists
      const stats = lstatSync(path);
      if (!stats.isSymbolicLink()) {
        return false;
      }

      // Try to stat the target
      try {
        statSync(path);
        return false; // Target exists
      } catch {
        return true; // Target doesn't exist - symlink is broken
      }
    } catch {
      return false; // Path doesn't exist at all
    }
  }

  /**
   * Log remediation action to remediation.jsonl.
   *
   * `isDefaultPath` is true only when the caller did NOT inject a
   * remediationLogPath override — mirrors AlertGate's spool()/saveState()
   * pattern (AlertGate.ts:372,427): an override (the norm across this
   * file's hermetic tests) already targets a caller-controlled sandbox
   * regardless of KAYA_HOME/NODE_ENV, so guarding it too would only produce
   * false-positive throws in otherwise-correct hermetic tests.
   */
  private static logRemediation(
    logPath: string,
    isDefaultPath: boolean,
    entry: {
      timestamp: string;
      workflow: string;
      action: string;
      target: string;
      dryRun: boolean;
    }
  ): void {
    if (isDefaultPath) assertNotLiveHomeUnderTest('Remediator.logRemediation');
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    try {
      createAppendLog(logPath).append(entry);
    } catch (error) {
      console.error('Failed to log remediation:', error);
    }
  }
}
