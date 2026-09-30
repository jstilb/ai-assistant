/**
 * SentenceChunker.test.ts - Tests for streaming sentence boundary detection
 *
 * Tests the SentenceChunker which buffers streaming tokens and emits
 * complete sentences for TTS processing.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SentenceChunker } from "../SentenceChunker.ts";

describe("SentenceChunker", () => {
  let chunker: SentenceChunker;

  beforeEach(() => {
    // Use minChunkSize: 0 for basic boundary detection tests
    // minChunkSize behavior tested separately
    chunker = new SentenceChunker({ minChunkSize: 0 });
  });

  describe("basic sentence detection", () => {
    it("should detect sentence ending with period and space", () => {
      const tokens = ["Hello", " world", ".", " Next"];
      const results: string[] = [];
      for (const token of tokens) {
        const result = chunker.addToken(token);
        if (result) results.push(result);
      }
      expect(results).toEqual(["Hello world."]);
    });

    it("should detect sentence ending with exclamation and space", () => {
      const tokens = ["Wow", "!", " That"];
      const results: string[] = [];
      for (const token of tokens) {
        const result = chunker.addToken(token);
        if (result) results.push(result);
      }
      expect(results).toEqual(["Wow!"]);
    });

    it("should detect sentence ending with question mark and space", () => {
      const tokens = ["How", " are", " you", "?", " I"];
      const results: string[] = [];
      for (const token of tokens) {
        const result = chunker.addToken(token);
        if (result) results.push(result);
      }
      expect(results).toEqual(["How are you?"]);
    });

    it("should detect multiple sentences", () => {
      const tokens = ["First", ".", " Second", ".", " Third"];
      const results: string[] = [];
      for (const token of tokens) {
        const result = chunker.addToken(token);
        if (result) results.push(result);
      }
      expect(results).toEqual(["First.", "Second."]);
    });
  });

  describe("newline boundaries", () => {
    it("should detect sentence ending with period and newline", () => {
      const tokens = ["Hello", ".", "\n", "Next"];
      const results: string[] = [];
      for (const token of tokens) {
        const result = chunker.addToken(token);
        if (result) results.push(result);
      }
      expect(results).toEqual(["Hello."]);
    });

    it("should detect sentence ending with exclamation and newline", () => {
      const tokens = ["Wow", "!", "\n", "More"];
      const results: string[] = [];
      for (const token of tokens) {
        const result = chunker.addToken(token);
        if (result) results.push(result);
      }
      expect(results).toEqual(["Wow!"]);
    });

    it("should detect sentence ending with question and newline", () => {
      const tokens = ["Really", "?", "\n", "Yes"];
      const results: string[] = [];
      for (const token of tokens) {
        const result = chunker.addToken(token);
        if (result) results.push(result);
      }
      expect(results).toEqual(["Really?"]);
    });
  });

  describe("min chunk merging", () => {
    it("should not emit sentences shorter than minChunkSize", () => {
      // Default minChunkSize is 30 chars
      const c = new SentenceChunker(); // uses default minChunkSize=30
      const tokens = ["Hi", ".", " What's up", ".", " How are you doing today my friend", "?", " Good"];
      const results: string[] = [];
      for (const token of tokens) {
        const result = c.addToken(token);
        if (result) results.push(result);
      }
      // "Hi." is 3 chars (< 30), so it merges with next
      // "Hi. What's up." is 14 chars (< 30), so it merges with next
      // "Hi. What's up. How are you doing today my friend?" is > 30, so it emits
      expect(results.length).toBe(1);
      expect(results[0]).toBe("Hi. What's up. How are you doing today my friend?");
    });

    it("should respect custom minChunkSize", () => {
      const c = new SentenceChunker({ minChunkSize: 5 });
      const tokens = ["Hello", ".", " World", ".", " More"];
      const results: string[] = [];
      for (const token of tokens) {
        const result = c.addToken(token);
        if (result) results.push(result);
      }
      expect(results).toEqual(["Hello.", "World."]);
    });

    it("should merge very short sentences with default settings", () => {
      const c = new SentenceChunker(); // default minChunkSize=30
      const tokens = ["No", ".", " Ok", ".", " Sure thing buddy I appreciate that very much", ".", " Thanks"];
      const results: string[] = [];
      for (const token of tokens) {
        const result = c.addToken(token);
        if (result) results.push(result);
      }
      // "No. Ok." is only 7 chars, keeps merging
      // "No. Ok. Sure thing buddy I appreciate that very much." is > 30, emits
      expect(results.length).toBe(1);
      expect(results[0]).toContain("No. Ok.");
      expect(results[0]).toContain("Sure thing buddy");
    });
  });

  describe("max chunk forced flush", () => {
    it("should force flush at maxChunkSize when no sentence boundary found", () => {
      const c = new SentenceChunker({ minChunkSize: 0, maxChunkSize: 50 });
      // Create a long string with no sentence boundaries
      const longWord = "a".repeat(60);
      const result = c.addToken(longWord);
      // Should force flush since buffer > maxChunkSize
      expect(result).not.toBeNull();
      expect(result!.length).toBeGreaterThan(0);
      expect(result!.length).toBeLessThanOrEqual(60);
    });

    it("should force flush at word boundary when exceeding maxChunkSize", () => {
      const c = new SentenceChunker({ minChunkSize: 0, maxChunkSize: 30 });
      const tokens = ["This", " is", " a", " really", " long", " sentence", " that", " keeps", " going"];
      const results: string[] = [];
      for (const token of tokens) {
        const result = c.addToken(token);
        if (result) results.push(result);
      }
      // Should have flushed at least once due to exceeding 30 chars
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        expect(r.length).toBeLessThanOrEqual(50); // word boundary may overshoot slightly
      }
    });
  });

  describe("stream end flush", () => {
    it("should flush remaining buffer content", () => {
      chunker.addToken("Hello");
      chunker.addToken(" world");
      const result = chunker.flush();
      expect(result).toBe("Hello world");
    });

    it("should return null when buffer is empty", () => {
      const result = chunker.flush();
      expect(result).toBeNull();
    });

    it("should flush after partial sentence", () => {
      chunker.addToken("This is incomplete");
      const result = chunker.flush();
      expect(result).toBe("This is incomplete");
    });
  });

  describe("reset", () => {
    it("should clear the buffer", () => {
      chunker.addToken("Some");
      chunker.addToken(" text");
      chunker.reset();
      expect(chunker.getBuffer()).toBe("");
    });

    it("should allow fresh sentences after reset", () => {
      chunker.addToken("First sentence");
      chunker.reset();
      chunker.addToken("New");
      chunker.addToken(" start");
      const result = chunker.flush();
      expect(result).toBe("New start");
    });
  });

  describe("edge cases", () => {
    it("should handle empty string tokens", () => {
      const result = chunker.addToken("");
      expect(result).toBeNull();
    });

    it("should handle single character tokens", () => {
      chunker.addToken("a");
      expect(chunker.getBuffer()).toBe("a");
    });

    it("should merge abbreviations below minChunkSize", () => {
      // With default minChunkSize=30, "Mr." is too short so it merges
      const c = new SentenceChunker(); // default minChunkSize=30
      const tokens = ["Mr", ".", " Smith is a really fantastic person", ".", " Good"];
      const results: string[] = [];
      for (const token of tokens) {
        const result = c.addToken(token);
        if (result) results.push(result);
      }
      // "Mr." is 3 chars (< 30), merges with "Smith is a really fantastic person."
      // Combined is > 30, so it emits
      expect(results.length).toBe(1);
      expect(results[0]).toContain("Mr.");
      expect(results[0]).toContain("Smith");
    });

    it("should handle consecutive punctuation", () => {
      const tokens = ["Wait", ".", ".", ".", " What"];
      const results: string[] = [];
      for (const token of tokens) {
        const result = chunker.addToken(token);
        if (result) results.push(result);
      }
      // ". " boundary found at "Wait..." followed by " What"
      // With minChunkSize=0, "Wait..." should emit
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle tokens containing sentence boundaries", () => {
      const c = new SentenceChunker({ minChunkSize: 5 });
      const result = c.addToken("Hello. World");
      // Should detect the boundary within the token
      expect(result).toBe("Hello.");
      expect(c.getBuffer()).toBe("World");
    });

    it("should trim whitespace from emitted sentences", () => {
      const c = new SentenceChunker({ minChunkSize: 0 });
      const tokens = [" Hello", ".", "  Next"];
      const results: string[] = [];
      for (const token of tokens) {
        const result = c.addToken(token);
        if (result) results.push(result);
      }
      if (results.length > 0) {
        expect(results[0]).not.toMatch(/^\s/);
        expect(results[0]).not.toMatch(/\s$/);
      }
    });
  });
});
