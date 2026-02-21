/**
 * AuditLogger Tests - Verifies append-only audit logging
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { AuditLogger, createAuditLogger, type AuditEntry } from "../AuditLogger";

const TEST_DIR = join(import.meta.dir, ".test-audit");
const TEST_LOG_PATH = join(TEST_DIR, "audit.jsonl");

describe("AuditLogger", () => {
  let logger: AuditLogger;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    logger = createAuditLogger(TEST_LOG_PATH);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it("should create log file and append entry", () => {
    logger.log({
      action: "ARCHIVE",
      affectedPaths: ["/some/orphan/file.md"],
      outcome: "success",
      tier: "monthly",
      step: "OrphanRecovery",
    });

    expect(existsSync(TEST_LOG_PATH)).toBe(true);

    const content = readFileSync(TEST_LOG_PATH, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);

    const entry = JSON.parse(lines[0]) as AuditEntry;
    expect(entry.action).toBe("ARCHIVE");
    expect(entry.affectedPaths).toEqual(["/some/orphan/file.md"]);
    expect(entry.outcome).toBe("success");
    expect(entry.tier).toBe("monthly");
    expect(entry.step).toBe("OrphanRecovery");
    expect(entry.timestamp).toBeDefined();
  });

  it("should append multiple entries (not overwrite)", () => {
    logger.log({
      action: "DELETE",
      affectedPaths: ["/file1.md"],
      outcome: "success",
    });

    logger.log({
      action: "ARCHIVE",
      affectedPaths: ["/file2.md", "/file3.md"],
      outcome: "success",
    });

    const content = readFileSync(TEST_LOG_PATH, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    const entry1 = JSON.parse(lines[0]);
    const entry2 = JSON.parse(lines[1]);
    expect(entry1.action).toBe("DELETE");
    expect(entry2.action).toBe("ARCHIVE");
  });

  it("should include ISO-8601 timestamp", () => {
    logger.log({
      action: "MODIFY_STATE",
      affectedPaths: ["/state/config.json"],
      outcome: "success",
    });

    const content = readFileSync(TEST_LOG_PATH, "utf-8");
    const entry = JSON.parse(content.trim());

    // Verify ISO-8601 format
    const date = new Date(entry.timestamp);
    expect(date.toISOString()).toBe(entry.timestamp);
  });

  it("should support dry-run outcome", () => {
    logger.log({
      action: "ARCHIVE",
      affectedPaths: ["/file.md"],
      outcome: "dry-run",
      tier: "monthly",
    });

    const content = readFileSync(TEST_LOG_PATH, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.outcome).toBe("dry-run");
  });

  it("should support failure outcome", () => {
    logger.log({
      action: "DELETE",
      affectedPaths: ["/locked-file.md"],
      outcome: "failure",
      details: "Permission denied",
    });

    const content = readFileSync(TEST_LOG_PATH, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.outcome).toBe("failure");
    expect(entry.details).toBe("Permission denied");
  });

  it("should handle creating directories if they do not exist", () => {
    const deepPath = join(TEST_DIR, "deep", "nested", "audit.jsonl");
    const deepLogger = createAuditLogger(deepPath);

    deepLogger.log({
      action: "ARCHIVE",
      affectedPaths: ["/file.md"],
      outcome: "success",
    });

    expect(existsSync(deepPath)).toBe(true);
  });

  describe("getEntries", () => {
    it("should return all entries", () => {
      logger.log({ action: "DELETE", affectedPaths: ["/a.md"], outcome: "success" });
      logger.log({ action: "ARCHIVE", affectedPaths: ["/b.md"], outcome: "success" });

      const entries = logger.getEntries();
      expect(entries.length).toBe(2);
    });

    it("should return empty array for missing log file", () => {
      const emptyLogger = createAuditLogger(join(TEST_DIR, "nonexistent.jsonl"));
      const entries = emptyLogger.getEntries();
      expect(entries.length).toBe(0);
    });
  });
});
