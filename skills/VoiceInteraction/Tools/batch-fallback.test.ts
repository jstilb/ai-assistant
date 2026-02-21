#!/usr/bin/env bun
/**
 * batch-fallback.test.ts - Tests for batch TTS fallback module
 *
 * TDD tests for batch-fallback:
 * - REST API batch TTS via CachedHTTPClient
 * - Error handling for API failures
 * - Proper use of VoiceCommon patterns
 * - No raw fetch() calls
 *
 * Run: bun test batch-fallback.test.ts
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const TOOL_PATH = join(
  process.env.HOME || "",
  ".claude/skills/VoiceInteraction/Tools/batch-fallback.ts"
);

describe("batch-fallback", () => {
  describe("Source Code Patterns", () => {
    let source: string;

    beforeEach(() => {
      source = readFileSync(TOOL_PATH, "utf-8");
    });

    it("should use CachedHTTPClient for API calls", () => {
      expect(source).toContain("httpClient") ||
        expect(source).toContain("CachedHTTPClient");
    });

    it("should import from CachedHTTPClient", () => {
      expect(source).toContain("CachedHTTPClient");
    });

    it("should use getElevenLabsConfig from VoiceCommon", () => {
      expect(source).toContain("getElevenLabsConfig") ||
        expect(source).toContain("VoiceCommon");
    });

    it("should not contain raw fetch() calls", () => {
      // Match standalone fetch( but not .fetch( or httpClient.fetch(
      const rawFetchMatches = source.match(/(?<!\w)(?<!\.)fetch\s*\(/g);
      expect(rawFetchMatches).toBeNull();
    });

    it("should not contain raw JSON.parse(readFileSync()) for state", () => {
      const matches = source.match(/JSON\.parse\s*\(\s*readFileSync/g);
      expect(matches).toBeNull();
    });

    it("should export a batch TTS function", () => {
      expect(source).toContain("export");
      expect(
        source.includes("batchTTS") ||
        source.includes("generateBatch") ||
        source.includes("batchGenerate") ||
        source.includes("generateSpeechBatch")
      ).toBe(true);
    });

    it("should call ElevenLabs text-to-speech API", () => {
      expect(source).toContain("api.elevenlabs.io");
      expect(source).toContain("text-to-speech");
    });

    it("should handle API errors with Result type or throw", () => {
      expect(
        source.includes("throw new Error") ||
        source.includes("Result") ||
        source.includes("success: false")
      ).toBe(true);
    });

    it("should validate API key presence", () => {
      expect(
        source.includes("apiKey") ||
        source.includes("api_key") ||
        source.includes("ELEVENLABS_API_KEY")
      ).toBe(true);
    });

    it("should return audio data as Buffer or Uint8Array", () => {
      expect(
        source.includes("Buffer") ||
        source.includes("Uint8Array") ||
        source.includes("arrayBuffer") ||
        source.includes("AudioChunk")
      ).toBe(true);
    });
  });

  describe("Error Handling", () => {
    it("should handle non-200 HTTP responses", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      expect(
        source.includes("response.ok") ||
        source.includes("status") ||
        source.includes("!= 200") ||
        source.includes("!== 200")
      ).toBe(true);
    });

    it("should include error context in error messages", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      expect(source).toContain("Error");
      expect(
        source.includes("ElevenLabs") ||
        source.includes("TTS") ||
        source.includes("batch")
      ).toBe(true);
    });
  });
});
