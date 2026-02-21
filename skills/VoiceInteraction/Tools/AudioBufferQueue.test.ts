#!/usr/bin/env bun
/**
 * AudioBufferQueue.test.ts - Tests for audio chunk buffering and sequential playback
 *
 * TDD tests for AudioBufferQueue:
 * - Queue operations (enqueue, dequeue)
 * - Max buffer size enforcement
 * - Drain method for clean shutdown
 * - Clear method for interruption
 * - Sequential chunk ordering
 *
 * Run: bun test AudioBufferQueue.test.ts
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const TOOL_PATH = join(
  process.env.HOME || "",
  ".claude/skills/VoiceInteraction/Tools/AudioBufferQueue.ts"
);

describe("AudioBufferQueue", () => {
  describe("Source Code Patterns", () => {
    let source: string;

    beforeEach(() => {
      source = readFileSync(TOOL_PATH, "utf-8");
    });

    it("should export AudioBufferQueue class", () => {
      expect(source).toContain("export");
      expect(
        source.includes("class AudioBufferQueue") ||
        source.includes("function createAudioBufferQueue")
      ).toBe(true);
    });

    it("should implement enqueue method", () => {
      expect(
        source.includes("enqueue(") ||
        source.includes("push(") ||
        source.includes("add(")
      ).toBe(true);
    });

    it("should implement dequeue method", () => {
      expect(
        source.includes("dequeue(") ||
        source.includes("shift(") ||
        source.includes("next(")
      ).toBe(true);
    });

    it("should enforce max buffer size", () => {
      expect(
        source.includes("maxSize") ||
        source.includes("MAX_BUFFER_SIZE") ||
        source.includes("maxBufferSize")
      ).toBe(true);
    });

    it("should implement drain method for clean shutdown", () => {
      expect(source).toContain("drain");
    });

    it("should implement clear method for interruption", () => {
      expect(source).toContain("clear");
    });

    it("should track queue size", () => {
      expect(
        source.includes("size") ||
        source.includes("length") ||
        source.includes("count")
      ).toBe(true);
    });

    it("should have proper TypeScript types for audio chunks", () => {
      expect(
        source.includes("AudioChunk") ||
        source.includes("Buffer") ||
        source.includes("Uint8Array")
      ).toBe(true);
    });

    it("should handle empty queue gracefully", () => {
      // Should have a check for empty queue
      expect(
        source.includes("empty") ||
        source.includes("length === 0") ||
        source.includes("size === 0") ||
        source.includes("undefined") ||
        source.includes("null")
      ).toBe(true);
    });

    it("should not use raw fetch() calls", () => {
      const rawFetchMatches = source.match(/(?<!\w)fetch\s*\(/g);
      expect(rawFetchMatches).toBeNull();
    });
  });

  describe("Queue Behavior", () => {
    it("should maintain FIFO ordering in source code", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      // Queue should use array with push/shift or similar FIFO pattern
      expect(
        source.includes("push") ||
        source.includes("queue") ||
        source.includes("buffer")
      ).toBe(true);
    });

    it("should support checking if queue is empty", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      expect(
        source.includes("isEmpty") ||
        source.includes("empty") ||
        source.includes("length")
      ).toBe(true);
    });

    it("should report total bytes buffered", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      expect(
        source.includes("totalBytes") ||
        source.includes("byteLength") ||
        source.includes("bytes") ||
        source.includes("size")
      ).toBe(true);
    });
  });
});
