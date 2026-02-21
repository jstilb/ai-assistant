#!/usr/bin/env bun
/**
 * AuditLogger.ts - Immutable Append-Only Audit Log with PII Filtering
 *
 * Phase 4: Enhanced with PII filtering (SHA-256), log rotation,
 * date range + action type query interface, and configurable paths.
 *
 * Every calendar modification is logged with timestamp, action type,
 * event ID, rationale, confidence, and outcome. Append-only design
 * ensures no entries can be retroactively modified or deleted.
 *
 * @module AuditLogger
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "fs";
import { dirname } from "path";
import { createHash } from "crypto";
import type { IntentType } from "./types";

// ============================================
// TYPES
// ============================================

export interface AuditLogEntry {
  timestamp: string;
  actionType: string;
  eventId?: string;
  confidence: number;
  rationalePreview: string;
  outcome: string;
  details?: Record<string, unknown>;
}

export interface AuditQueryParams {
  startDate?: string;
  endDate?: string;
  actionType?: string;
  eventId?: string;
  limit?: number;
}

export interface AuditStats {
  totalActions: number;
  byType: Record<string, number>;
  byOutcome: Record<string, number>;
  avgConfidence: number;
}

export interface AuditLoggerConfig {
  logPath?: string;
  maxFileSizeMB?: number;
  retentionCount?: number;
}

// ============================================
// PII FIELDS
// ============================================

const PII_KEYS = [
  "title",
  "summary",
  "attendee",
  "attendees",
  "email",
  "name",
  "description",
];

// ============================================
// PII SANITIZATION
// ============================================

function hashPII(value: string): string {
  return `[REDACTED:${createHash("sha256").update(value).digest("hex").slice(0, 8)}]`;
}

function isPIIKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return PII_KEYS.some((piiKey) => lowerKey.includes(piiKey));
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (typeof value === "string" && isPIIKey(key)) {
    return hashPII(value);
  }
  if (Array.isArray(value) && isPIIKey(key)) {
    return value.map((v) =>
      typeof v === "string" ? hashPII(v) : v
    );
  }
  return value;
}

function sanitizeDetails(
  data: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeDetails(value as Record<string, unknown>);
    } else {
      sanitized[key] = sanitizeValue(key, value);
    }
  }
  return sanitized;
}

// ============================================
// DEFAULTS
// ============================================

const KAYA_DIR = process.env.KAYA_DIR || `${process.env.HOME}/.claude`;
const DEFAULT_AUDIT_PATH = `${KAYA_DIR}/skills/CalendarAssistant/data/audit.jsonl`;
const DEFAULT_MAX_SIZE_MB = 50;
const DEFAULT_RETENTION_COUNT = 5;

// ============================================
// AUDIT LOGGER FACTORY
// ============================================

export function createAuditLogger(config?: AuditLoggerConfig) {
  const logPath = config?.logPath || DEFAULT_AUDIT_PATH;
  const maxFileSizeMB = config?.maxFileSizeMB || DEFAULT_MAX_SIZE_MB;
  const retentionCount = config?.retentionCount || DEFAULT_RETENTION_COUNT;

  /**
   * Ensure the audit log directory exists.
   */
  function ensureLogDir(): void {
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Rotate log file if it exceeds the max size.
   */
  function rotateIfNeeded(): void {
    if (!existsSync(logPath)) return;

    try {
      const stats = statSync(logPath);
      const sizeMB = stats.size / (1024 * 1024);

      if (sizeMB >= maxFileSizeMB) {
        // Shift existing rotated files
        for (let i = retentionCount - 1; i >= 1; i--) {
          const older = `${logPath}.${i}`;
          const newer = `${logPath}.${i + 1}`;
          if (existsSync(older)) {
            try {
              renameSync(older, newer);
            } catch {
              // Rotation failure is non-fatal
            }
          }
        }
        // Rotate current to .1
        renameSync(logPath, `${logPath}.1`);
      }
    } catch {
      // Rotation failure is non-fatal
    }
  }

  /**
   * Append an audit entry to the immutable log.
   * This is append-only: no update or delete operations are exposed.
   */
  function logAction(entry: Partial<AuditLogEntry> & { actionType: string; confidence: number; rationalePreview: string; outcome: string }): void {
    ensureLogDir();
    rotateIfNeeded();

    const fullEntry: AuditLogEntry = {
      timestamp: entry.timestamp || new Date().toISOString(),
      actionType: entry.actionType,
      eventId: entry.eventId,
      confidence: entry.confidence,
      rationalePreview: entry.rationalePreview,
      outcome: entry.outcome,
      // Sanitize PII in details
      details: entry.details ? sanitizeDetails(entry.details) : undefined,
    };

    const line = JSON.stringify(fullEntry);
    appendFileSync(logPath, line + "\n", "utf-8");
  }

  /**
   * Read all audit entries from the log.
   */
  function readLog(limit?: number): AuditLogEntry[] {
    if (!existsSync(logPath)) {
      return [];
    }

    const content = readFileSync(logPath, "utf-8").trim();
    if (!content) {
      return [];
    }

    const lines = content.split("\n").filter((line) => line.trim());
    const entries: AuditLogEntry[] = [];

    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as AuditLogEntry);
      } catch {
        // Skip malformed lines
      }
    }

    if (limit && limit > 0) {
      return entries.slice(-limit);
    }

    return entries;
  }

  /**
   * Query audit log entries with filters.
   */
  function queryLog(params: AuditQueryParams): AuditLogEntry[] {
    let entries = readLog();

    if (params.startDate) {
      entries = entries.filter((e) => e.timestamp >= params.startDate!);
    }

    if (params.endDate) {
      entries = entries.filter((e) => e.timestamp <= params.endDate!);
    }

    if (params.actionType) {
      entries = entries.filter((e) => e.actionType === params.actionType);
    }

    if (params.eventId) {
      entries = entries.filter((e) => e.eventId === params.eventId);
    }

    if (params.limit && params.limit > 0) {
      entries = entries.slice(-params.limit);
    }

    return entries;
  }

  /**
   * Get audit entries for a specific event.
   */
  function getEventAuditTrail(eventId: string): AuditLogEntry[] {
    return readLog().filter((entry) => entry.eventId === eventId);
  }

  /**
   * Get audit statistics.
   */
  function getAuditStats(sinceIso?: string): AuditStats {
    let entries = readLog();

    if (sinceIso) {
      entries = entries.filter((e) => e.timestamp >= sinceIso);
    }

    const byType: Record<string, number> = {};
    const byOutcome: Record<string, number> = {};
    let totalConfidence = 0;

    for (const entry of entries) {
      byType[entry.actionType] = (byType[entry.actionType] || 0) + 1;
      byOutcome[entry.outcome] = (byOutcome[entry.outcome] || 0) + 1;
      totalConfidence += entry.confidence;
    }

    return {
      totalActions: entries.length,
      byType,
      byOutcome,
      avgConfidence:
        entries.length > 0 ? totalConfidence / entries.length : 0,
    };
  }

  // Return the public interface (intentionally no delete/update/clear)
  return {
    logAction,
    readLog,
    queryLog,
    getEventAuditTrail,
    getAuditStats,
  };
}

// ============================================
// MODULE-LEVEL EXPORTS (backward compatibility)
// ============================================

const defaultLogger = createAuditLogger();

export const logAction = defaultLogger.logAction;
export const readAuditLog = defaultLogger.readLog;
export const getEventAuditTrail = defaultLogger.getEventAuditTrail;
export const getAuditStats = defaultLogger.getAuditStats;

// Also export the legacy createAuditEntry for backward compatibility
export function createAuditEntry(params: {
  actionType: string;
  eventId?: string;
  confidence: number;
  rationalePreview: string;
  approvalStatus: "auto" | "approved" | "denied" | "pending";
  dryRun: boolean;
  details?: Record<string, unknown>;
}): void {
  logAction({
    actionType: params.actionType,
    eventId: params.eventId,
    confidence: params.confidence,
    rationalePreview: params.rationalePreview,
    outcome: params.dryRun ? "dry-run" : params.approvalStatus,
    details: params.details,
  });
}

// CLI interface
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "read" || command === "tail") {
    const limit = parseInt(args[1], 10) || 20;
    const entries = readAuditLog(limit);
    console.log(JSON.stringify(entries, null, 2));
  } else if (command === "stats") {
    const since = args[1];
    const stats = getAuditStats(since);
    console.log(JSON.stringify(stats, null, 2));
  } else if (command === "event") {
    const eventId = args[1];
    if (!eventId) {
      console.error("Usage: AuditLogger.ts event <event-id>");
      process.exit(1);
    }
    const trail = getEventAuditTrail(eventId);
    console.log(JSON.stringify(trail, null, 2));
  } else if (command === "query") {
    const logger = createAuditLogger();
    const params: AuditQueryParams = {};
    for (let i = 1; i < args.length; i += 2) {
      const flag = args[i];
      const value = args[i + 1];
      if (flag === "--start") params.startDate = value;
      if (flag === "--end") params.endDate = value;
      if (flag === "--type") params.actionType = value;
      if (flag === "--event") params.eventId = value;
      if (flag === "--limit") params.limit = parseInt(value, 10);
    }
    const results = logger.queryLog(params);
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`AuditLogger - Immutable Calendar Action Log

Usage:
  bun run AuditLogger.ts read [limit]                    Read recent entries
  bun run AuditLogger.ts stats [since-iso]               Get audit statistics
  bun run AuditLogger.ts event <event-id>                Get trail for event
  bun run AuditLogger.ts query --start ISO --end ISO     Query with filters
    --type <action-type>  --event <event-id>  --limit N
`);
  }
}
