#!/usr/bin/env bun
/**
 * ============================================================================
 * AuditLogger.ts - Append-only JSONL audit logging for destructive actions
 * ============================================================================
 *
 * PURPOSE:
 * Provides an append-only audit trail for destructive actions such as orphan
 * deletion/archival, state file modification, and report archival. Each entry
 * is a JSON line with ISO-8601 timestamp, action type, affected paths, and
 * outcome.
 *
 * USAGE:
 *   import { createAuditLogger } from './AuditLogger';
 *
 *   const logger = createAuditLogger('/path/to/audit.jsonl');
 *   logger.log({
 *     action: 'ARCHIVE',
 *     affectedPaths: ['/some/orphan.md'],
 *     outcome: 'success',
 *     tier: 'monthly',
 *     step: 'OrphanRecovery',
 *   });
 *
 * ============================================================================
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

// ============================================================================
// Types
// ============================================================================

export interface AuditEntry {
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Action type: ARCHIVE, DELETE, MODIFY_STATE, ROTATE, QUARANTINE */
  action: string;
  /** Affected file paths */
  affectedPaths: string[];
  /** Outcome: success, failure, dry-run */
  outcome: "success" | "failure" | "dry-run";
  /** Which tier triggered this action */
  tier?: string;
  /** Which step triggered this action */
  step?: string;
  /** Additional details */
  details?: string;
}

export interface AuditLogOptions {
  action: string;
  affectedPaths: string[];
  outcome: "success" | "failure" | "dry-run";
  tier?: string;
  step?: string;
  details?: string;
}

export interface AuditLogger {
  /** Append an audit entry to the log */
  log(options: AuditLogOptions): void;
  /** Read all entries from the log */
  getEntries(): AuditEntry[];
}

// ============================================================================
// Implementation
// ============================================================================

export function createAuditLogger(logPath?: string): AuditLogger {
  const KAYA_DIR = process.env.KAYA_DIR || join(homedir(), ".claude");
  const auditPath = logPath || join(KAYA_DIR, "MEMORY/AUTOINFO/audit.jsonl");

  function ensureDir(): void {
    const dir = dirname(auditPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  return {
    log(options: AuditLogOptions): void {
      ensureDir();

      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        action: options.action,
        affectedPaths: options.affectedPaths,
        outcome: options.outcome,
        tier: options.tier,
        step: options.step,
        details: options.details,
      };

      const line = JSON.stringify(entry) + "\n";
      appendFileSync(auditPath, line);
    },

    getEntries(): AuditEntry[] {
      if (!existsSync(auditPath)) {
        return [];
      }

      const content = readFileSync(auditPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      return lines
        .map((line) => {
          try {
            return JSON.parse(line) as AuditEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is AuditEntry => e !== null);
    },
  };
}

// Default instance
const KAYA_DIR = process.env.KAYA_DIR || join(homedir(), ".claude");
export const auditLogger = createAuditLogger(join(KAYA_DIR, "MEMORY/AUTOINFO/audit.jsonl"));
