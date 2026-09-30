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

// Control-char repair — ported from the deleted briefing editorial engine's 2026-05-30 raw-newline
// fix (escapeControlCharsInStrings) so every extractJson() consumer recovers
// from LLM responses that write string field values with literal newlines
// instead of `\n` escapes, which is invalid JSON and previously failed all
// 3 strategies.
describe("extractJson — control-char repair", () => {
  it("recovers a bare JSON object with a raw literal newline inside a string value", () => {
    const broken = '{"telegram": "line one\nline two", "confidence": "high"}';
    const result = extractJson(broken);
    expect(result).toEqual({ telegram: "line one\nline two", confidence: "high" });
  });

  it("recovers a raw-newline JSON object wrapped in ```json fences", () => {
    const broken = [
      "```json",
      '{"telegram": "line one',
      'line two", "confidence": "high"}',
      "```",
    ].join("\n");
    const result = extractJson(broken);
    expect(result).toEqual({ telegram: "line one\nline two", confidence: "high" });
  });

  it("recovers a raw-newline JSON object embedded in prose (greedy-regex tier)", () => {
    const broken = [
      "Here is the result:",
      "",
      '{"telegram": "line one',
      'line two", "confidence": "high"}',
      "",
      "Let me know if you need anything else.",
    ].join("\n");
    const result = extractJson(broken);
    expect(result).toEqual({ telegram: "line one\nline two", confidence: "high" });
  });

  it("regression guard: already-valid clean JSON still parses identically and is not mangled", () => {
    const clean = JSON.stringify({ telegram: "line one\nline two", confidence: "high" });
    const result = extractJson(clean);
    expect(result).toEqual({ telegram: "line one\nline two", confidence: "high" });
  });

  it("returns undefined for genuinely non-JSON input", () => {
    const result = extractJson("This is just prose, no JSON here, not even close.");
    expect(result).toBeUndefined();
  });
});

// ISC 1, 2, 3 — estimateTokens, estimateCostUSD, InferenceResult cost fields
import { estimateTokens, estimateCostUSD, resolveModelPricing } from "./Inference.ts";

describe("estimateTokens", () => {
  it("returns Math.ceil(text.length / 4) for normal input", () => {
    expect(estimateTokens("abcd")).toBe(1);     // 4 chars = exactly 1
    expect(estimateTokens("abcde")).toBe(2);    // 5 chars → ceil(1.25) = 2
    expect(estimateTokens("abc")).toBe(1);      // 3 chars → ceil(0.75) = 1
    expect(estimateTokens("abcdefgh")).toBe(2); // 8 chars = exactly 2
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("handles long text proportionally", () => {
    const text = "a".repeat(1000);
    expect(estimateTokens(text)).toBe(250); // 1000 / 4 = 250
  });
});

describe("estimateCostUSD", () => {
  it("calculates Haiku input cost correctly ($0.25/1M tokens)", () => {
    // 1M input tokens at $0.25 = $0.25
    const cost = estimateCostUSD({ inputTokens: 1_000_000, outputTokens: 0, modelName: "haiku" });
    expect(cost).toBeCloseTo(0.25, 4);
  });

  it("calculates Haiku output cost correctly ($1.25/1M tokens)", () => {
    const cost = estimateCostUSD({ inputTokens: 0, outputTokens: 1_000_000, modelName: "haiku" });
    expect(cost).toBeCloseTo(1.25, 4);
  });

  it("calculates Sonnet cost correctly", () => {
    // 1000 input at $3/M = $0.003; 500 output at $15/M = $0.0075 → total $0.0105
    const cost = estimateCostUSD({ inputTokens: 1000, outputTokens: 500, modelName: "sonnet" });
    expect(cost).toBeCloseTo(0.0105, 4);
  });

  it("calculates Opus cost correctly", () => {
    // 1000 input at $15/M = $0.015; 0 output
    const cost = estimateCostUSD({ inputTokens: 1000, outputTokens: 0, modelName: "claude-3-opus-20240229" });
    expect(cost).toBeCloseTo(0.015, 6);
  });

  it("defaults to Sonnet pricing for unknown model names", () => {
    const sonnetCost = estimateCostUSD({ inputTokens: 1000, outputTokens: 0, modelName: "sonnet" });
    const unknownCost = estimateCostUSD({ inputTokens: 1000, outputTokens: 0, modelName: "unknown-model-xyz" });
    expect(unknownCost).toBeCloseTo(sonnetCost, 6);
  });

  it("handles zero tokens returning zero cost", () => {
    const cost = estimateCostUSD({ inputTokens: 0, outputTokens: 0, modelName: "haiku" });
    expect(cost).toBe(0);
  });
});

describe("resolveModelPricing", () => {
  it("resolves haiku pricing by substring match", () => {
    const pricing = resolveModelPricing("claude-haiku-3-5");
    expect(pricing.inputPerMillion).toBe(0.25);
    expect(pricing.outputPerMillion).toBe(1.25);
  });

  it("resolves sonnet pricing by substring match", () => {
    const pricing = resolveModelPricing("claude-sonnet-4");
    expect(pricing.inputPerMillion).toBe(3.00);
    expect(pricing.outputPerMillion).toBe(15.00);
  });

  it("resolves opus pricing by substring match", () => {
    const pricing = resolveModelPricing("claude-opus-4");
    expect(pricing.inputPerMillion).toBe(15.00);
    expect(pricing.outputPerMillion).toBe(75.00);
  });
});

describe("InferenceResult cost fields shape", () => {
  it("estimatedTokens and estimatedCostUSD are defined on InferenceResult type", () => {
    // Type-level check: construct a valid InferenceResult to verify fields compile
    const result: import("./Inference.ts").InferenceResult = {
      success: true,
      output: "hello",
      latencyMs: 50,
      level: "fast",
      estimatedTokens: { input: 10, output: 5, total: 15 },
      estimatedCostUSD: 0.0001,
    };
    expect(result.estimatedTokens.input).toBe(10);
    expect(result.estimatedTokens.output).toBe(5);
    expect(result.estimatedTokens.total).toBe(15);
    expect(result.estimatedCostUSD).toBe(0.0001);
  });
});
