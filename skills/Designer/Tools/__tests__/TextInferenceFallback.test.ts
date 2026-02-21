/**
 * TextInferenceFallback.test.ts - Tests for filename-based text inference fallback
 *
 * Tests:
 * - Extracts room type from filename patterns
 * - Always returns confidence < 0.5
 * - Always returns valid RoomAnalysis
 * - Source is always 'text_inference'
 * - Handles edge cases (no filename, weird names)
 * - Provides reasonable defaults
 */

import { describe, it, expect } from "bun:test";
import {
  analyzeWithTextInference,
  extractRoomTypeFromFilename,
  type RoomAnalysis,
} from "../TextInferenceFallback.ts";

describe("TextInferenceFallback", () => {
  describe("extractRoomTypeFromFilename", () => {
    it("extracts 'living room' from filename", () => {
      expect(extractRoomTypeFromFilename("living-room.jpg")).toBe("living room");
      expect(extractRoomTypeFromFilename("living_room_photo.png")).toBe("living room");
    });

    it("extracts 'bedroom' from filename", () => {
      expect(extractRoomTypeFromFilename("master-bedroom.jpg")).toBe("bedroom");
      expect(extractRoomTypeFromFilename("bedroom2.png")).toBe("bedroom");
    });

    it("extracts 'kitchen' from filename", () => {
      expect(extractRoomTypeFromFilename("kitchen-remodel.jpg")).toBe("kitchen");
    });

    it("extracts 'bathroom' from filename", () => {
      expect(extractRoomTypeFromFilename("bathroom-update.png")).toBe("bathroom");
    });

    it("extracts 'dining room' from filename", () => {
      expect(extractRoomTypeFromFilename("dining-room-before.jpg")).toBe("dining room");
    });

    it("extracts 'office' from filename", () => {
      expect(extractRoomTypeFromFilename("home-office-setup.jpg")).toBe("office");
    });

    it("returns 'unknown' for unrecognizable filenames", () => {
      expect(extractRoomTypeFromFilename("IMG_2847.jpg")).toBe("unknown");
      expect(extractRoomTypeFromFilename("photo123.png")).toBe("unknown");
    });

    it("handles paths with directories", () => {
      expect(extractRoomTypeFromFilename("/home/user/photos/kitchen.jpg")).toBe("kitchen");
    });

    it("is case insensitive", () => {
      expect(extractRoomTypeFromFilename("LIVING-ROOM.JPG")).toBe("living room");
      expect(extractRoomTypeFromFilename("Kitchen.PNG")).toBe("kitchen");
    });
  });

  describe("analyzeWithTextInference", () => {
    it("always returns a valid RoomAnalysis", async () => {
      const result = await analyzeWithTextInference("/tmp/some-room.jpg");
      expect(result).not.toBeNull();
      expect(result.room_type).toBeDefined();
      expect(result.styles).toBeInstanceOf(Array);
      expect(result.dominant_colors).toBeInstanceOf(Array);
      expect(result.lighting).toBeDefined();
      expect(result.features).toBeInstanceOf(Array);
      expect(typeof result.confidence).toBe("number");
      expect(result.source).toBe("text_inference");
    });

    it("always returns confidence < 0.5", async () => {
      const result = await analyzeWithTextInference("/tmp/kitchen.jpg");
      expect(result.confidence).toBeLessThan(0.5);
    });

    it("never returns confidence below 0.1", async () => {
      const result = await analyzeWithTextInference("/tmp/IMG_0001.jpg");
      expect(result.confidence).toBeGreaterThanOrEqual(0.1);
    });

    it("returns higher confidence for recognizable filenames", async () => {
      const knownRoom = await analyzeWithTextInference("/tmp/living-room.jpg");
      const unknownRoom = await analyzeWithTextInference("/tmp/IMG_2847.jpg");
      expect(knownRoom.confidence).toBeGreaterThan(unknownRoom.confidence);
    });

    it("sets room_type based on filename", async () => {
      const result = await analyzeWithTextInference("/tmp/kitchen-remodel.jpg");
      expect(result.room_type).toBe("kitchen");
    });

    it("returns source as text_inference", async () => {
      const result = await analyzeWithTextInference("/tmp/any-file.jpg");
      expect(result.source).toBe("text_inference");
    });

    it("provides default styles based on detected room type", async () => {
      const result = await analyzeWithTextInference("/tmp/bedroom.jpg");
      expect(result.styles.length).toBeGreaterThan(0);
    });

    it("provides default colors", async () => {
      const result = await analyzeWithTextInference("/tmp/room.jpg");
      expect(result.dominant_colors.length).toBeGreaterThan(0);
      result.dominant_colors.forEach((c) => {
        expect(c.name).toBeDefined();
        expect(c.hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
      });
    });
  });
});
