#!/usr/bin/env bun
/**
 * STTPolishPipeline.test.ts - Unit tests for STTPolishPipeline
 *
 * Tests source code patterns and pure functions.
 * Integration tests (Ollama, Claude) require live services.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { calculateWordOverlap, cleanPolishOutput, countAddedWords } from "./STTPolishPipeline.ts";

const PIPELINE_PATH = join(import.meta.dir, "STTPolishPipeline.ts");
const sourceCode = readFileSync(PIPELINE_PATH, "utf-8");

describe("STTPolishPipeline", () => {
  describe("Source Code Patterns", () => {
    it("should use CachedHTTPClient for HTTP calls", () => {
      expect(sourceCode).toContain("httpClient.fetch");
      expect(sourceCode).not.toContain("await fetch(");
    });

    it("should use StateManager for config persistence", () => {
      expect(sourceCode).toContain("createStateManager");
    });

    it("should define fallback chain (finetuned -> base -> claude -> raw)", () => {
      expect(sourceCode).toContain("finetunedModel");
      expect(sourceCode).toContain("baseModel");
      expect(sourceCode).toContain("polishViaClaude");
      expect(sourceCode).toContain("totalRaw");
    });

    it("should gate the paid Claude fallback behind allowCloudFallback (default false)", () => {
      // The paid cloud call must be conditional on config, and the schema
      // default must be false so a down Ollama can't silently burn credits.
      expect(sourceCode).toContain("config.allowCloudFallback");
      expect(sourceCode).toContain("allowCloudFallback: z.boolean().default(false)");
      expect(sourceCode).toContain("allowCloudFallback: false");
    });

    it("should implement word overlap validation", () => {
      expect(sourceCode).toContain("calculateWordOverlap");
      expect(sourceCode).toContain("wordOverlapThreshold");
    });

    it("should save training pairs to pairs.jsonl", () => {
      expect(sourceCode).toContain("pairs.jsonl");
      expect(sourceCode).toContain("saveTrainingPair");
    });

    it("should track statistics per category", () => {
      expect(sourceCode).toContain("totalPolished");
      expect(sourceCode).toContain("totalFallbackToBase");
      expect(sourceCode).toContain("totalFallbackToClaude");
      expect(sourceCode).toContain("totalRejected");
      expect(sourceCode).toContain("totalRaw");
    });
  });

  describe("calculateWordOverlap", () => {
    it("should return 100 for identical text", () => {
      const overlap = calculateWordOverlap("hello world", "hello world");
      expect(overlap).toBe(100);
    });

    it("should return 100 for punctuation-only differences", () => {
      const overlap = calculateWordOverlap("hello world", "hello, world!");
      expect(overlap).toBe(100);
    });

    it("should return 0 for completely different text", () => {
      const overlap = calculateWordOverlap("hello world", "foo bar baz");
      expect(overlap).toBe(0);
    });

    it("should be case-insensitive", () => {
      const overlap = calculateWordOverlap("Hello World", "hello world");
      expect(overlap).toBe(100);
    });

    it("should return partial overlap for partial matches", () => {
      const overlap = calculateWordOverlap("hello world foo", "hello world bar");
      // "hello" and "world" match out of 3 raw words = 66%
      expect(overlap).toBeGreaterThan(60);
      expect(overlap).toBeLessThan(100);
    });

    it("should return 0 for empty raw text", () => {
      const overlap = calculateWordOverlap("", "some text");
      expect(overlap).toBe(0);
    });

    it("should handle single word", () => {
      const overlap = calculateWordOverlap("hello", "hello");
      expect(overlap).toBe(100);
    });
  });

  describe("countAddedWords", () => {
    it("returns 0 for identical text", () => {
      expect(countAddedWords("hello world", "hello world")).toBe(0);
    });

    it("returns 0 for punctuation and casing changes", () => {
      expect(countAddedWords("hello world", "Hello, world!")).toBe(0);
    });

    it("counts content words injected by the model", () => {
      expect(
        countAddedWords(
          "review the daily briefing",
          "Review the daily briefing tomorrow morning."
        )
      ).toBe(2);
    });

    it("allows a single vocabulary respelling", () => {
      expect(countAddedWords("restart coco ro", "Restart Kokoro.")).toBe(1);
    });
  });

  describe("cold-start handling (source patterns)", () => {
    it("keeps the polish model resident between voice notes via keep_alive", () => {
      expect(sourceCode).toContain('const OLLAMA_KEEP_ALIVE = "30m"');
      expect(sourceCode).toContain("keep_alive: OLLAMA_KEEP_ALIVE");
    });
    it("extends the timeout when /api/ps says the model is not loaded", () => {
      expect(sourceCode).toContain("/api/ps");
      expect(sourceCode).toContain("const COLD_START_ALLOWANCE_MS = 20000");
      expect(sourceCode).toContain("loaded ? config.timeoutMs : config.timeoutMs + COLD_START_ALLOWANCE_MS");
    });
  });

  describe("addition guard (source patterns)", () => {
    it("rejects polish that injects more than one new word", () => {
      expect(sourceCode).toContain("countAddedWords");
      expect(sourceCode).toContain("addedWords > MAX_ADDED_WORDS");
    });
  });

  describe("cleanPolishOutput", () => {
    it("should strip 'Sure, ' prefix", () => {
      const result = cleanPolishOutput("Sure, hello world.");
      expect(result).toBe("hello world.");
    });

    it("should strip 'Here is the corrected text:' prefix", () => {
      const result = cleanPolishOutput("Here is the corrected version: hello world.");
      expect(result).toBe("hello world.");
    });

    it("should strip 'The corrected text:' prefix", () => {
      const result = cleanPolishOutput("The corrected text: hello world.");
      expect(result).toBe("hello world.");
    });

    it("should strip wrapping double quotes", () => {
      const result = cleanPolishOutput('"hello world"');
      expect(result).toBe("hello world");
    });

    it("should not modify clean text", () => {
      const result = cleanPolishOutput("Hello world, how are you?");
      expect(result).toBe("Hello world, how are you?");
    });

    it("should trim whitespace", () => {
      const result = cleanPolishOutput("  hello world  ");
      expect(result).toBe("hello world");
    });
  });

  describe("polishTranscription (source patterns)", () => {
    it("should skip short text (< 10 chars)", () => {
      expect(sourceCode).toContain("rawText.length < 10");
    });

    it("should respect enabled flag", () => {
      expect(sourceCode).toContain("!config.enabled");
    });

    it("should export polishTranscription function", () => {
      expect(sourceCode).toContain("export async function polishTranscription");
    });

    it("should export getPolishStats function", () => {
      expect(sourceCode).toContain("export async function getPolishStats");
    });
  });
});
