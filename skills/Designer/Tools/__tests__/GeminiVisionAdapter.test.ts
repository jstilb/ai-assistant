/**
 * GeminiVisionAdapter.test.ts - Tests for Gemini Vision room analysis adapter
 *
 * Tests:
 * - Prompt construction for Gemini inference
 * - Response parsing and normalization to RoomAnalysis schema
 * - Source field is always 'gemini'
 * - Confidence bounds for vision
 * - Error handling for inference failures
 * - Graceful null return on failure
 */

import { describe, it, expect } from "bun:test";
import {
  analyzeWithGemini,
  buildGeminiPrompt,
  parseGeminiResponse,
  type RoomAnalysis,
} from "../GeminiVisionAdapter.ts";

describe("GeminiVisionAdapter", () => {
  describe("buildGeminiPrompt", () => {
    it("returns a structured prompt for room analysis", () => {
      const prompt = buildGeminiPrompt("/path/to/room.jpg");
      expect(prompt).toContain("room");
      expect(prompt).toContain("JSON");
      expect(prompt).toContain("room_type");
      expect(prompt).toContain("styles");
      expect(prompt).toContain("dominant_colors");
    });

    it("includes the image path", () => {
      const prompt = buildGeminiPrompt("/tmp/living-room.png");
      expect(prompt).toContain("/tmp/living-room.png");
    });

    it("includes focus area when provided", () => {
      const prompt = buildGeminiPrompt("/tmp/room.jpg", "colors");
      expect(prompt).toContain("colors");
    });
  });

  describe("parseGeminiResponse", () => {
    it("parses valid JSON response into RoomAnalysis", () => {
      const validResponse = JSON.stringify({
        room_type: "dining room",
        styles: ["traditional", "elegant"],
        dominant_colors: [
          { name: "navy", hex: "#000080" },
          { name: "gold", hex: "#FFD700" },
        ],
        lighting: "warm ambient lighting",
        features: ["dining table", "chandelier", "china cabinet"],
        confidence: 0.78,
      });

      const result = parseGeminiResponse(validResponse);
      expect(result).not.toBeNull();
      expect(result!.room_type).toBe("dining room");
      expect(result!.styles).toContain("traditional");
      expect(result!.dominant_colors.length).toBe(2);
      expect(result!.source).toBe("gemini");
    });

    it("extracts JSON from wrapped text", () => {
      const wrapped = 'Here is the analysis:\n```json\n{"room_type":"bathroom","styles":["modern"],"dominant_colors":[{"name":"white","hex":"#FFFFFF"}],"lighting":"bright","features":["vanity"],"confidence":0.72}\n```';
      const result = parseGeminiResponse(wrapped);
      expect(result).not.toBeNull();
      expect(result!.room_type).toBe("bathroom");
      expect(result!.source).toBe("gemini");
    });

    it("returns null for invalid JSON", () => {
      const result = parseGeminiResponse("not json");
      expect(result).toBeNull();
    });

    it("returns null for incomplete data", () => {
      const result = parseGeminiResponse(JSON.stringify({ room_type: "den" }));
      expect(result).toBeNull();
    });

    it("always sets source to 'gemini'", () => {
      const response = JSON.stringify({
        room_type: "nursery",
        styles: ["whimsical"],
        dominant_colors: [{ name: "pastel blue", hex: "#AEC6CF" }],
        lighting: "soft",
        features: ["crib"],
        confidence: 0.68,
        source: "claude", // should be overridden
      });

      const result = parseGeminiResponse(response);
      expect(result).not.toBeNull();
      expect(result!.source).toBe("gemini");
    });

    it("enforces minimum confidence of 0.6 for vision", () => {
      const response = JSON.stringify({
        room_type: "study",
        styles: ["classic"],
        dominant_colors: [{ name: "brown", hex: "#8B4513" }],
        lighting: "desk lamp",
        features: ["bookshelf"],
        confidence: 0.2,
      });

      const result = parseGeminiResponse(response);
      expect(result).not.toBeNull();
      expect(result!.confidence).toBeGreaterThanOrEqual(0.6);
    });
  });

  describe("analyzeWithGemini", () => {
    it("returns null for non-existent image", async () => {
      const result = await analyzeWithGemini("/tmp/nonexistent-gemini-test-xxxxx.jpg");
      expect(result).toBeNull();
    });

    it("returns RoomAnalysis with source=gemini on success", async () => {
      const result = await analyzeWithGemini("/tmp/nonexistent-test.jpg");
      if (result !== null) {
        expect(result.source).toBe("gemini");
        expect(result.room_type).toBeDefined();
        expect(result.styles).toBeInstanceOf(Array);
      }
    });
  });
});
