/**
 * AuditLogger Test Suite - Phase 4
 *
 * Tests append-only JSONL audit logging, PII filtering via SHA-256,
 * log rotation, date range queries, and action type filtering.
 *
 * @module audit-logger.test
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from "fs";
import { createHash } from "crypto";

const TEST_DIR = "/tmp/calendar-phase4-audit-test";
const TEST_AUDIT_PATH = `${TEST_DIR}/audit.jsonl`;

import {
  createAuditLogger,
} from "../AuditLogger";

import type { IntentType } from "../types";

describe("AuditLogger", () => {
  let logger: ReturnType<typeof createAuditLogger>;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    logger = createAuditLogger({
      logPath: TEST_AUDIT_PATH,
      maxFileSizeMB: 1, // Small for rotation testing
      retentionCount: 3,
    });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  // ============================================================================
  // 1. Append-Only Logging
  // ============================================================================
  describe("append-only logging", () => {
    it("should create audit log file on first write", () => {
      logger.logAction({
        timestamp: new Date().toISOString(),
        actionType: "create" as IntentType,
        eventId: "evt-001",
        confidence: 0.95,
        rationalePreview: "Scheduled per user request",
        outcome: "success",
      });
      expect(existsSync(TEST_AUDIT_PATH)).toBe(true);
    });

    it("should append entries as JSONL (one per line)", () => {
      logger.logAction({
        timestamp: "2026-02-06T10:00:00Z",
        actionType: "create" as IntentType,
        eventId: "evt-001",
        confidence: 0.9,
        rationalePreview: "Test entry 1",
        outcome: "success",
      });
      logger.logAction({
        timestamp: "2026-02-06T11:00:00Z",
        actionType: "modify" as IntentType,
        eventId: "evt-002",
        confidence: 0.85,
        rationalePreview: "Test entry 2",
        outcome: "success",
      });

      const content = readFileSync(TEST_AUDIT_PATH, "utf-8").trim();
      const lines = content.split("\n");
      expect(lines).toHaveLength(2);

      // Each line is valid JSON
      const entry1 = JSON.parse(lines[0]);
      const entry2 = JSON.parse(lines[1]);
      expect(entry1.eventId).toBe("evt-001");
      expect(entry2.eventId).toBe("evt-002");
    });

    it("should never expose delete or update operations", () => {
      // The logger interface should only have logAction, readLog, queryLog
      // No deleteEntry, updateEntry, or similar methods
      expect(typeof (logger as any).deleteEntry).toBe("undefined");
      expect(typeof (logger as any).updateEntry).toBe("undefined");
      expect(typeof (logger as any).clearLog).toBe("undefined");
    });

    it("should include all required fields in each entry", () => {
      logger.logAction({
        timestamp: "2026-02-06T10:00:00Z",
        actionType: "create" as IntentType,
        eventId: "evt-001",
        confidence: 0.9,
        rationalePreview: "Test",
        outcome: "success",
      });

      const entries = logger.readLog();
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.timestamp).toBeDefined();
      expect(entry.actionType).toBeDefined();
      expect(entry.eventId).toBeDefined();
      expect(entry.confidence).toBeDefined();
      expect(entry.rationalePreview).toBeDefined();
      expect(entry.outcome).toBeDefined();
    });

    it("should auto-set timestamp if not provided", () => {
      const before = new Date().toISOString();
      logger.logAction({
        actionType: "query" as IntentType,
        confidence: 1.0,
        rationalePreview: "Auto-timestamp test",
        outcome: "success",
      });
      const after = new Date().toISOString();

      const entries = logger.readLog();
      expect(entries).toHaveLength(1);
      expect(entries[0].timestamp).toBeDefined();
      expect(entries[0].timestamp >= before).toBe(true);
      expect(entries[0].timestamp <= after).toBe(true);
    });
  });

  // ============================================================================
  // 2. PII Filtering
  // ============================================================================
  describe("PII filtering", () => {
    it("should hash event titles in log entries", () => {
      logger.logAction({
        timestamp: "2026-02-06T10:00:00Z",
        actionType: "create" as IntentType,
        eventId: "evt-001",
        confidence: 0.9,
        rationalePreview: "Scheduled meeting",
        outcome: "success",
        details: {
          title: "Dr. Smith Appointment",
        },
      });

      const raw = readFileSync(TEST_AUDIT_PATH, "utf-8");
      // Raw file should NOT contain the PII
      expect(raw).not.toContain("Dr. Smith Appointment");
      // Should contain a REDACTED hash
      expect(raw).toContain("[REDACTED:");
    });

    it("should hash attendee information", () => {
      logger.logAction({
        timestamp: "2026-02-06T10:00:00Z",
        actionType: "create" as IntentType,
        eventId: "evt-001",
        confidence: 0.9,
        rationalePreview: "Scheduled meeting",
        outcome: "success",
        details: {
          attendees: ["alice@company.com", "bob@company.com"],
        },
      });

      const raw = readFileSync(TEST_AUDIT_PATH, "utf-8");
      expect(raw).not.toContain("alice@company.com");
      expect(raw).not.toContain("bob@company.com");
    });

    it("should hash event descriptions", () => {
      logger.logAction({
        timestamp: "2026-02-06T10:00:00Z",
        actionType: "create" as IntentType,
        eventId: "evt-001",
        confidence: 0.9,
        rationalePreview: "Scheduled meeting",
        outcome: "success",
        details: {
          description: "Discuss salary negotiation with HR",
        },
      });

      const raw = readFileSync(TEST_AUDIT_PATH, "utf-8");
      expect(raw).not.toContain("salary negotiation");
    });

    it("should use SHA-256 for hashing (consistent output)", () => {
      const testValue = "Dr. Smith Appointment";
      const expectedPrefix = createHash("sha256")
        .update(testValue)
        .digest("hex")
        .slice(0, 8);

      logger.logAction({
        timestamp: "2026-02-06T10:00:00Z",
        actionType: "create" as IntentType,
        eventId: "evt-001",
        confidence: 0.9,
        rationalePreview: "Test",
        outcome: "success",
        details: { title: testValue },
      });

      const raw = readFileSync(TEST_AUDIT_PATH, "utf-8");
      expect(raw).toContain(expectedPrefix);
    });

    it("should NOT hash non-PII fields like eventId or actionType", () => {
      logger.logAction({
        timestamp: "2026-02-06T10:00:00Z",
        actionType: "create" as IntentType,
        eventId: "evt-special-001",
        confidence: 0.9,
        rationalePreview: "Test rationale",
        outcome: "success",
      });

      const raw = readFileSync(TEST_AUDIT_PATH, "utf-8");
      expect(raw).toContain("evt-special-001");
      expect(raw).toContain("create");
      expect(raw).toContain("Test rationale");
    });
  });

  // ============================================================================
  // 3. Log Rotation
  // ============================================================================
  describe("log rotation", () => {
    it("should rotate when file exceeds max size", () => {
      // Write enough data to exceed 1MB limit
      const largeEntry = {
        timestamp: "2026-02-06T10:00:00Z",
        actionType: "create" as IntentType,
        confidence: 0.9,
        rationalePreview: "x".repeat(10000),
        outcome: "success" as const,
      };

      for (let i = 0; i < 120; i++) {
        logger.logAction(largeEntry);
      }

      // Check that a rotated file exists
      expect(existsSync(`${TEST_AUDIT_PATH}.1`)).toBe(true);
    });

    it("should continue writing to fresh file after rotation", () => {
      // Fill up the file to trigger rotation
      const largeEntry = {
        timestamp: "2026-02-06T10:00:00Z",
        actionType: "create" as IntentType,
        confidence: 0.9,
        rationalePreview: "x".repeat(10000),
        outcome: "success" as const,
      };

      for (let i = 0; i < 120; i++) {
        logger.logAction(largeEntry);
      }

      // Write one more entry after rotation
      logger.logAction({
        timestamp: "2026-02-06T12:00:00Z",
        actionType: "query" as IntentType,
        confidence: 1.0,
        rationalePreview: "Post-rotation entry",
        outcome: "success",
      });

      // The current log should contain the new entry
      const entries = logger.readLog();
      const lastEntry = entries[entries.length - 1];
      expect(lastEntry.rationalePreview).toBe("Post-rotation entry");
    });
  });

  // ============================================================================
  // 4. Query Interface
  // ============================================================================
  describe("query interface", () => {
    beforeEach(() => {
      // Seed test data
      const entries = [
        { timestamp: "2026-02-01T10:00:00Z", actionType: "create", confidence: 0.9, rationalePreview: "Created event A", outcome: "success", eventId: "evt-001" },
        { timestamp: "2026-02-02T10:00:00Z", actionType: "modify", confidence: 0.85, rationalePreview: "Modified event B", outcome: "success", eventId: "evt-002" },
        { timestamp: "2026-02-03T10:00:00Z", actionType: "delete", confidence: 0.95, rationalePreview: "Deleted event C", outcome: "success", eventId: "evt-003" },
        { timestamp: "2026-02-04T10:00:00Z", actionType: "create", confidence: 0.7, rationalePreview: "Created event D", outcome: "success", eventId: "evt-004" },
        { timestamp: "2026-02-05T10:00:00Z", actionType: "query", confidence: 1.0, rationalePreview: "Queried events", outcome: "success" },
        { timestamp: "2026-02-06T10:00:00Z", actionType: "optimize", confidence: 0.8, rationalePreview: "Optimized schedule", outcome: "success" },
      ];
      for (const entry of entries) {
        logger.logAction(entry as any);
      }
    });

    it("should filter by date range", () => {
      const results = logger.queryLog({
        startDate: "2026-02-02T00:00:00Z",
        endDate: "2026-02-04T23:59:59Z",
      });
      expect(results).toHaveLength(3); // Feb 2, 3, 4
    });

    it("should filter by action type", () => {
      const results = logger.queryLog({
        actionType: "create",
      });
      expect(results).toHaveLength(2); // Two create entries
    });

    it("should filter by both date range and action type", () => {
      const results = logger.queryLog({
        startDate: "2026-02-01T00:00:00Z",
        endDate: "2026-02-03T23:59:59Z",
        actionType: "create",
      });
      expect(results).toHaveLength(1); // Only the Feb 1 create
    });

    it("should return all entries with no filters", () => {
      const results = logger.queryLog({});
      expect(results).toHaveLength(6);
    });

    it("should support limit parameter", () => {
      const results = logger.queryLog({ limit: 3 });
      expect(results).toHaveLength(3);
    });

    it("should return entries in chronological order", () => {
      const results = logger.queryLog({});
      for (let i = 1; i < results.length; i++) {
        expect(results[i].timestamp >= results[i - 1].timestamp).toBe(true);
      }
    });

    it("should get audit trail for specific event", () => {
      const trail = logger.getEventAuditTrail("evt-001");
      expect(trail).toHaveLength(1);
      expect(trail[0].actionType).toBe("create");
    });

    it("should get audit statistics", () => {
      const stats = logger.getAuditStats();
      expect(stats.totalActions).toBe(6);
      expect(stats.byType["create"]).toBe(2);
      expect(stats.byType["modify"]).toBe(1);
      expect(stats.byType["delete"]).toBe(1);
      expect(stats.avgConfidence).toBeGreaterThan(0);
    });

    it("should get audit stats for a date range", () => {
      const stats = logger.getAuditStats("2026-02-04T00:00:00Z");
      expect(stats.totalActions).toBe(3); // Feb 4, 5, 6
    });
  });

  // ============================================================================
  // 5. Resilience
  // ============================================================================
  describe("resilience", () => {
    it("should handle malformed lines gracefully", () => {
      // Write some valid entries, then a malformed one
      writeFileSync(
        TEST_AUDIT_PATH,
        '{"timestamp":"2026-02-06T10:00:00Z","actionType":"create","confidence":0.9,"rationalePreview":"Good","outcome":"success"}\n' +
        'THIS IS NOT JSON\n' +
        '{"timestamp":"2026-02-06T11:00:00Z","actionType":"query","confidence":1.0,"rationalePreview":"Also good","outcome":"success"}\n'
      );

      const entries = logger.readLog();
      expect(entries).toHaveLength(2); // Should skip the malformed line
    });

    it("should handle empty log file", () => {
      writeFileSync(TEST_AUDIT_PATH, "");
      const entries = logger.readLog();
      expect(entries).toHaveLength(0);
    });

    it("should handle missing log file", () => {
      const entries = logger.readLog();
      expect(entries).toHaveLength(0);
    });
  });
});
