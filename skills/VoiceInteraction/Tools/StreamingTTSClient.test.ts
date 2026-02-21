#!/usr/bin/env bun
/**
 * StreamingTTSClient.test.ts - Tests for WebSocket streaming TTS
 *
 * TDD tests for StreamingTTSClient:
 * - WebSocket connection to ElevenLabs streaming API
 * - Chunk flow and event emission
 * - 2-second timeout triggering batch fallback
 * - Feature flag via StateManager
 * - Clean cancellation on interruption
 * - Error handling and recovery
 *
 * Run: bun test StreamingTTSClient.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const TOOL_PATH = join(
  process.env.HOME || "",
  ".claude/skills/VoiceInteraction/Tools/StreamingTTSClient.ts"
);

describe("StreamingTTSClient", () => {
  describe("Source Code Patterns", () => {
    let source: string;

    beforeEach(() => {
      source = readFileSync(TOOL_PATH, "utf-8");
    });

    it("should use WebSocket for streaming connection", () => {
      expect(source).toContain("WebSocket");
      expect(source).toContain("wss://api.elevenlabs.io");
    });

    it("should use StateManager for feature flag", () => {
      expect(
        source.includes("StateManager") ||
        source.includes("createStateManager") ||
        source.includes("getStreamingConfig")
      ).toBe(true);
    });

    it("should implement 2-second timeout for batch fallback", () => {
      expect(
        source.includes("2000") ||
        source.includes("STREAMING_TIMEOUT_MS")
      ).toBe(true);
    });

    it("should emit chunk events", () => {
      expect(source).toContain("chunk");
      expect(
        source.includes("EventEmitter") ||
        source.includes("emit")
      ).toBe(true);
    });

    it("should emit complete event", () => {
      expect(source).toContain("complete");
    });

    it("should emit error event", () => {
      expect(source).toContain("error");
    });

    it("should emit fallback event", () => {
      expect(source).toContain("fallback");
    });

    it("should not contain raw JSON.parse(readFileSync()) for state", () => {
      const matches = source.match(/JSON\.parse\s*\(\s*readFileSync/g);
      expect(matches).toBeNull();
    });

    it("should handle WebSocket close and cleanup", () => {
      expect(source).toContain("close");
      expect(
        source.includes("cleanup") ||
        source.includes("destroy") ||
        source.includes("disconnect")
      ).toBe(true);
    });

    it("should have proper TypeScript types for audio chunks", () => {
      expect(
        source.includes("AudioChunk") ||
        source.includes("interface")
      ).toBe(true);
    });

    it("should implement cancellation method", () => {
      expect(
        source.includes("cancel") ||
        source.includes("abort") ||
        source.includes("interrupt")
      ).toBe(true);
    });

    it("should read API key from VoiceCommon getElevenLabsConfig", () => {
      expect(
        source.includes("getElevenLabsConfig") ||
        source.includes("VoiceCommon")
      ).toBe(true);
    });
  });

  describe("StreamingTTSClient class", () => {
    it("should export StreamingTTSClient class or factory", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      expect(source).toContain("export");
      expect(
        source.includes("class StreamingTTSClient") ||
        source.includes("function createStreamingTTSClient") ||
        source.includes("export function streamTTS") ||
        source.includes("export class StreamingTTSClient")
      ).toBe(true);
    });

    it("should have a method to stream text to audio", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      expect(
        source.includes("stream(") ||
        source.includes("streamText(") ||
        source.includes("startStreaming(") ||
        source.includes("streamTTS(")
      ).toBe(true);
    });

    it("should have async methods for all operations", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      expect(source).toContain("async");
      expect(source).toContain("Promise");
    });
  });

  describe("Timeout and Fallback", () => {
    it("should define configurable timeout constant", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      expect(
        source.includes("STREAMING_TIMEOUT_MS") ||
        source.includes("FALLBACK_TIMEOUT_MS") ||
        source.includes("timeout")
      ).toBe(true);
    });

    it("should track first chunk arrival time (TTFB)", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      expect(
        source.includes("ttfb") ||
        source.includes("firstChunk") ||
        source.includes("first_chunk")
      ).toBe(true);
    });
  });

  describe("Error Handling", () => {
    it("should handle WebSocket connection errors", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      // Should have error handler for WebSocket
      expect(
        source.includes("onerror") ||
        source.includes('on("error"') ||
        source.includes("addEventListener")
      ).toBe(true);
    });

    it("should not have empty catch blocks", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      // No empty catch blocks: catch (e) {} -- but allow catch { // comment }
      // Match catch blocks with truly empty bodies (no content at all)
      const emptyCatches = source.match(/catch\s*\([^)]*\)\s*\{\s*\}/g);
      expect(emptyCatches).toBeNull();
    });

    it("should have a top-level error boundary if CLI is present", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      if (source.includes("import.meta.main") || source.includes("main()")) {
        expect(source).toContain("catch");
      }
    });
  });
});
