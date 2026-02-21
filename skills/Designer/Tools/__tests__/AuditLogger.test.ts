/**
 * AuditLogger.test.ts - Tests for audit logging
 *
 * Tests:
 * - Per-call logging with required fields
 * - PII scrubbing (no file paths, emails, user prefs)
 * - Timestamp and hash formatting
 * - Error message logging
 * - Cache hit tracking
 */

import { describe, it, expect } from "bun:test";
import {
  createAuditLogger,
  scrubPII,
  type AuditEntry,
  type AuditLogger,
} from "../AuditLogger.ts";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuditLogger", () => {
  describe("createAuditLogger", () => {
    it("creates a logger instance", () => {
      const logger = createAuditLogger();
      expect(logger).toBeDefined();
      expect(typeof logger.log).toBe("function");
      expect(typeof logger.getEntries).toBe("function");
    });
  });

  describe("log", () => {
    it("records an audit entry with all required fields", () => {
      const logger = createAuditLogger();
      logger.log({
        image_hash: "abc123def456",
        api_name: "claude_vision",
        latency_ms: 1250,
        cost: 0.025,
        success: true,
        cache_hit: false,
      });

      const entries = logger.getEntries();
      expect(entries.length).toBe(1);
      expect(entries[0].image_hash).toBe("abc123def456");
      expect(entries[0].api_name).toBe("claude_vision");
      expect(entries[0].latency_ms).toBe(1250);
      expect(entries[0].cost).toBe(0.025);
      expect(entries[0].success).toBe(true);
      expect(entries[0].cache_hit).toBe(false);
    });

    it("automatically adds timestamp", () => {
      const logger = createAuditLogger();
      const before = new Date().toISOString();
      logger.log({
        image_hash: "hash1",
        api_name: "gemini_vision",
        latency_ms: 800,
        cost: 0.01,
        success: true,
        cache_hit: true,
      });
      const after = new Date().toISOString();

      const entry = logger.getEntries()[0];
      expect(entry.timestamp).toBeDefined();
      expect(entry.timestamp >= before).toBe(true);
      expect(entry.timestamp <= after).toBe(true);
    });

    it("records error messages for failed calls", () => {
      const logger = createAuditLogger();
      logger.log({
        image_hash: "hash2",
        api_name: "claude_vision",
        latency_ms: 5000,
        cost: 0,
        success: false,
        cache_hit: false,
        error_message: "API timeout after 5s",
      });

      const entry = logger.getEntries()[0];
      expect(entry.success).toBe(false);
      expect(entry.error_message).toBe("API timeout after 5s");
    });

    it("logs multiple entries in order", () => {
      const logger = createAuditLogger();
      logger.log({
        image_hash: "h1",
        api_name: "gemini_vision",
        latency_ms: 500,
        cost: 0.01,
        success: true,
        cache_hit: false,
      });
      logger.log({
        image_hash: "h2",
        api_name: "claude_vision",
        latency_ms: 1200,
        cost: 0.025,
        success: true,
        cache_hit: false,
      });
      logger.log({
        image_hash: "h3",
        api_name: "shopping",
        latency_ms: 300,
        cost: 0,
        success: true,
        cache_hit: true,
      });

      const entries = logger.getEntries();
      expect(entries.length).toBe(3);
      expect(entries[0].api_name).toBe("gemini_vision");
      expect(entries[2].api_name).toBe("shopping");
    });
  });

  describe("scrubPII", () => {
    it("removes file paths from error messages", () => {
      const scrubbed = scrubPII("Error reading /Users/john/Documents/photo.jpg");
      expect(scrubbed).not.toContain("/Users/john");
      expect(scrubbed).not.toContain("Documents");
    });

    it("removes email addresses", () => {
      const scrubbed = scrubPII("User john@example.com requested analysis");
      expect(scrubbed).not.toContain("john@example.com");
    });

    it("removes home directory paths", () => {
      const scrubbed = scrubPII("Loading config from /home/user/.claude/settings.json");
      expect(scrubbed).not.toContain("/home/user");
    });

    it("preserves non-PII content", () => {
      const scrubbed = scrubPII("API timeout after 5 seconds");
      expect(scrubbed).toBe("API timeout after 5 seconds");
    });

    it("handles empty string", () => {
      const scrubbed = scrubPII("");
      expect(scrubbed).toBe("");
    });

    it("scrubs PII from error_message when logging", () => {
      const logger = createAuditLogger();
      logger.log({
        image_hash: "hash",
        api_name: "claude_vision",
        latency_ms: 100,
        cost: 0,
        success: false,
        cache_hit: false,
        error_message: "Failed to read /Users/jane/photos/room.jpg",
      });

      const entry = logger.getEntries()[0];
      expect(entry.error_message).not.toContain("/Users/jane");
    });
  });

  describe("getEntries", () => {
    it("returns a copy, not a reference", () => {
      const logger = createAuditLogger();
      logger.log({
        image_hash: "h1",
        api_name: "test",
        latency_ms: 100,
        cost: 0,
        success: true,
        cache_hit: false,
      });

      const entries1 = logger.getEntries();
      const entries2 = logger.getEntries();
      expect(entries1).not.toBe(entries2);
      expect(entries1).toEqual(entries2);
    });
  });

  describe("clear", () => {
    it("removes all entries", () => {
      const logger = createAuditLogger();
      logger.log({
        image_hash: "h1",
        api_name: "test",
        latency_ms: 100,
        cost: 0,
        success: true,
        cache_hit: false,
      });
      expect(logger.getEntries().length).toBe(1);

      logger.clear();
      expect(logger.getEntries().length).toBe(0);
    });
  });
});
