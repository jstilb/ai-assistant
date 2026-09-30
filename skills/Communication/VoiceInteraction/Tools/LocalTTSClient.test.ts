#!/usr/bin/env bun
/**
 * LocalTTSClient.test.ts - Unit tests for LocalTTSClient
 *
 * Tests source code patterns and basic functionality.
 * Integration tests require a running mlx-audio server.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const CLIENT_PATH = join(import.meta.dir, "LocalTTSClient.ts");
const sourceCode = readFileSync(CLIENT_PATH, "utf-8");

describe("LocalTTSClient", () => {
  describe("Source Code Patterns", () => {
    it("should use CachedHTTPClient (no raw fetch)", () => {
      expect(sourceCode).toContain("httpClient.fetch");
      // Ensure no raw fetch() calls (only httpClient.fetch is allowed)
      const rawFetchMatches = sourceCode.match(/(?<!httpClient\.)(?<!await )fetch\(/g);
      // Allow: import { ... } from, and dynamic imports - only check for bare fetch(
      const bareGlobalFetch = (sourceCode.match(/(?<!\w)fetch\(/g) || []).filter(
        (m) => !sourceCode.includes(`httpClient.fetch(`)
      );
      // The source should use httpClient.fetch, not raw fetch
      expect(sourceCode).not.toContain("await fetch(");
    });

    it("should use StateManager for config persistence", () => {
      expect(sourceCode).toContain("createStateManager");
      expect(sourceCode).toContain("StateManager");
    });

    it("should define OpenAI-compatible API endpoint", () => {
      expect(sourceCode).toContain("/v1/audio/speech");
    });

    it("should support model selection (kokoro, chatterbox, qwen3-tts)", () => {
      expect(sourceCode).toContain("kokoro");
      expect(sourceCode).toContain("chatterbox");
      expect(sourceCode).toContain("qwen3-tts");
    });

    it("should implement macOS say fallback", () => {
      expect(sourceCode).toContain("/usr/bin/say");
      expect(sourceCode).toContain("Samantha");
    });

    it("should have timeout configuration", () => {
      expect(sourceCode).toContain("DEFAULT_TIMEOUT_MS");
      expect(sourceCode).toContain("timeout");
    });

    it("should have a generateSpeechBatch compatibility wrapper", () => {
      expect(sourceCode).toContain("generateSpeechBatch");
    });

    it("should have feature flag support (enabled field)", () => {
      expect(sourceCode).toContain("config.enabled");
    });
  });

  describe("generateSpeech (source patterns)", () => {
    it("should call mlx-audio server with correct payload fields", () => {
      expect(sourceCode).toContain("input:");
      expect(sourceCode).toContain("voice:");
      expect(sourceCode).toContain("response_format:");
      expect(sourceCode).toContain("speed:");
      expect(sourceCode).toContain("MODEL_IDS");
    });

    it("should use prince-canuma/Kokoro-82M as default model ID", () => {
      expect(sourceCode).toContain("prince-canuma/Kokoro-82M");
    });

    it("should return TTSResult interface fields", () => {
      expect(sourceCode).toContain("usedFallback");
      expect(sourceCode).toContain("size_bytes");
      expect(sourceCode).toContain("duration_ms");
    });
  });

  describe("isServerHealthy (source patterns)", () => {
    it("should check /v1/models endpoint", () => {
      expect(sourceCode).toContain("/v1/models");
    });

    it("should use a short timeout for health checks", () => {
      expect(sourceCode).toContain("3000");
    });
  });

  describe("generateSpeechBatch (compatibility)", () => {
    it("should match the old batch-fallback.ts interface signature", () => {
      expect(sourceCode).toContain('format: "mp3"');
      expect(sourceCode).toContain("generateSpeechBatch");
    });
  });

  describe("CLI Interface", () => {
    it("should support speak command", () => {
      expect(sourceCode).toContain('case "speak"');
    });

    it("should support health command", () => {
      expect(sourceCode).toContain('case "health"');
    });

    it("should support status command", () => {
      expect(sourceCode).toContain('case "status"');
    });

    it("should support set-voice command", () => {
      expect(sourceCode).toContain('case "set-voice"');
    });

    it("should support set-model command", () => {
      expect(sourceCode).toContain('case "set-model"');
    });
  });
});
