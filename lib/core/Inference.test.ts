/**
 * Inference.test.ts — Tests for extractJson and TOON encoding helpers
 */

import { describe, it, expect } from "bun:test";
import { extractJson } from "./Inference.ts";

describe("extractJson", () => {
  it("parses bare JSON object", () => {
    const result = extractJson('{"key": "value"}');
    expect(result).toEqual({ key: "value" });
  });

  it("parses bare JSON array", () => {
    const result = extractJson('[{"a": 1}, {"a": 2}]');
    expect(result).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("parses markdown-fenced JSON", () => {
    const input = 'Here is the result:\n```json\n{"verdict": "PASS", "confidence": 0.95}\n```\n';
    const result = extractJson(input);
    expect(result).toEqual({ verdict: "PASS", confidence: 0.95 });
  });

  it("parses fenced JSON without language tag", () => {
    const input = '```\n{"key": "val"}\n```';
    const result = extractJson(input);
    expect(result).toEqual({ key: "val" });
  });

  it("parses JSON with preamble text (greedy regex)", () => {
    const input = 'Based on my analysis, the result is:\n\n{"tier": 2, "concerns": ["low coverage"]}';
    const result = extractJson(input);
    expect(result).toEqual({ tier: 2, concerns: ["low coverage"] });
  });

  it("parses JSON array with preamble", () => {
    const input = 'The items are:\n[{"id": 1}, {"id": 2}]\nDone.';
    const result = extractJson(input);
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("returns undefined for non-JSON", () => {
    const result = extractJson("This is just text with no JSON");
    expect(result).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    const result = extractJson('{"key": value}');
    expect(result).toBeUndefined();
  });

  it("handles whitespace-padded input", () => {
    const result = extractJson('  \n  {"ok": true}  \n  ');
    expect(result).toEqual({ ok: true });
  });
});
