import { describe, test, expect } from "bun:test";
import { extractVoiceLine } from "./VoiceResponder";

describe("extractVoiceLine", () => {
  test("extracts voice line with speaking head emoji", () => {
    const text = "📋 SUMMARY: stuff\n🗣️ Kaya: Hello world";
    expect(extractVoiceLine(text)).toBe("Hello world");
  });

  test("extracts voice line with microphone emoji", () => {
    const text = "📋 SUMMARY: stuff\n🎤 Kaya: Testing microphone";
    expect(extractVoiceLine(text)).toBe("Testing microphone");
  });

  test("extracts voice line with headphones emoji", () => {
    const text = "Some content\n🎧 Kaya: Audio response here";
    expect(extractVoiceLine(text)).toBe("Audio response here");
  });

  test("extracts voice line with speech bubble emoji", () => {
    const text = "📋 SUMMARY: test\n💬 Kaya: Speech bubble line";
    expect(extractVoiceLine(text)).toBe("Speech bubble line");
  });

  test("extracts voice line with megaphone emoji", () => {
    const text = "📋 SUMMARY: test\n📢 Kaya: Megaphone announcement";
    expect(extractVoiceLine(text)).toBe("Megaphone announcement");
  });

  test("falls back to first sentence when no voice line found", () => {
    const text = "This is a plain response. It has multiple sentences.";
    expect(extractVoiceLine(text)).toBe("This is a plain response");
  });

  test("returns empty string for empty input", () => {
    expect(extractVoiceLine("")).toBe("");
  });

  test("returns empty string when first sentence fallback exceeds 200 chars", () => {
    const longSentence = "A".repeat(201) + ". Short second sentence.";
    expect(extractVoiceLine(longSentence)).toBe("");
  });

  test("handles voice line without name prefix", () => {
    // Without "Kaya:" or "Assistant:" prefix, the regex removes emoji + non-word chars
    // but if no word boundary follows, returns the trimmed line
    const text = "📋 SUMMARY: stuff\n🗣️ Just the text directly";
    const result = extractVoiceLine(text);
    // The function returns trimmed text - emoji prefix remains when no name prefix present
    expect(result).toContain("Just the text directly");
  });

  test("handles voice line with Assistant prefix", () => {
    const text = "📋 SUMMARY: stuff\n🗣️ Assistant: Alternate prefix";
    expect(extractVoiceLine(text)).toBe("Alternate prefix");
  });
});
