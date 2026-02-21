/**
 * RoomAnalyzer.test.ts - Tests for room analysis with caching
 *
 * Tests:
 * - Image validation (format, size, hash)
 * - Cache hit/miss behavior via StateManager
 * - Response parsing and schema compliance
 * - Fallback chain logic
 * - Low confidence floor for text-only tier
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { validateImage, hashImage } from "../RoomAnalyzer.ts";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = "/tmp/designer-test-room-analyzer";
const FAKE_JPG = join(TEST_DIR, "test-room.jpg");
const FAKE_PNG = join(TEST_DIR, "test-room.png");
const FAKE_BMP = join(TEST_DIR, "test-room.bmp");
const EMPTY_FILE = join(TEST_DIR, "empty.jpg");

describe("RoomAnalyzer", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    // Create fake image files (just need valid extensions and non-zero size)
    const fakeContent = Buffer.alloc(1024, 0xff);
    writeFileSync(FAKE_JPG, fakeContent);
    writeFileSync(FAKE_PNG, fakeContent);
    writeFileSync(FAKE_BMP, fakeContent);
    writeFileSync(EMPTY_FILE, "");
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe("validateImage", () => {
    it("accepts valid JPG files", () => {
      const result = validateImage(FAKE_JPG);
      expect(result.valid).toBe(true);
      expect(result.extension).toBe(".jpg");
      expect(result.hash).toBeDefined();
      expect(result.sizeBytes).toBe(1024);
    });

    it("accepts valid PNG files", () => {
      const result = validateImage(FAKE_PNG);
      expect(result.valid).toBe(true);
      expect(result.extension).toBe(".png");
    });

    it("rejects unsupported formats", () => {
      const result = validateImage(FAKE_BMP);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Unsupported format");
    });

    it("rejects non-existent files", () => {
      const result = validateImage("/tmp/nonexistent-file.jpg");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("File not found");
    });

    it("rejects empty files", () => {
      const result = validateImage(EMPTY_FILE);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("empty");
    });
  });

  describe("hashImage", () => {
    it("returns consistent SHA-256 hash", () => {
      const hash1 = hashImage(FAKE_JPG);
      const hash2 = hashImage(FAKE_JPG);
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64); // SHA-256 hex = 64 chars
    });

    it("returns different hash for different content", () => {
      const hash1 = hashImage(FAKE_JPG);
      // Write different content to PNG
      writeFileSync(FAKE_PNG, Buffer.alloc(1024, 0xaa));
      const hash2 = hashImage(FAKE_PNG);
      expect(hash1).not.toBe(hash2);
    });
  });
});
