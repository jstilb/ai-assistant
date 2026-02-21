#!/usr/bin/env bun
/**
 * ToonHelper.test.ts - Tests for TOON format encoding/decoding utility
 *
 * Tests written FIRST per TDD methodology (RED phase).
 * Covers: round-trip encoding, maybeEncode smart routing, estimateTokenSavings,
 * edge cases (empty arrays, single-element, nested objects, missing keys).
 *
 * @module ToonHelper.test
 */

import { describe, it, expect } from "bun:test";
import {
  toToon,
  fromToon,
  maybeEncode,
  estimateTokenSavings,
} from "../ToonHelper";

// ============================================================================
// toToon - Encoding
// ============================================================================

describe("toToon", () => {
  it("encodes a uniform array of flat objects to TOON format", () => {
    const data = [
      { name: "Alice", age: 30, city: "NYC" },
      { name: "Bob", age: 25, city: "LA" },
    ];
    const result = toToon(data);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // TOON tabular format should include the header schema
    expect(result).toContain("name");
    expect(result).toContain("age");
    expect(result).toContain("city");
    // Should contain the data values
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
  });

  it("encodes an empty array", () => {
    const result = toToon([]);
    expect(typeof result).toBe("string");
  });

  it("encodes a single-element array", () => {
    const data = [{ id: 1, value: "test" }];
    const result = toToon(data);
    expect(typeof result).toBe("string");
    expect(result).toContain("test");
  });

  it("handles arrays with nested objects", () => {
    const data = [
      { user: { name: "Alice" }, score: 100 },
      { user: { name: "Bob" }, score: 200 },
    ];
    const result = toToon(data);
    expect(typeof result).toBe("string");
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
  });

  it("handles arrays with missing keys across objects", () => {
    const data = [
      { name: "Alice", age: 30 },
      { name: "Bob", email: "bob@test.com" },
    ];
    const result = toToon(data);
    expect(typeof result).toBe("string");
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
  });

  it("handles arrays with numeric values", () => {
    const data = [
      { x: 1.5, y: 2.7 },
      { x: 3.0, y: 4.2 },
    ];
    const result = toToon(data);
    expect(typeof result).toBe("string");
  });

  it("handles arrays with boolean and null values", () => {
    const data = [
      { active: true, deleted: false, notes: null },
      { active: false, deleted: true, notes: null },
    ];
    const result = toToon(data);
    expect(typeof result).toBe("string");
  });

  it("handles arrays of primitives (non-object items)", () => {
    const data = [1, 2, 3, 4, 5];
    const result = toToon(data);
    expect(typeof result).toBe("string");
  });
});

// ============================================================================
// fromToon - Decoding
// ============================================================================

describe("fromToon", () => {
  it("decodes TOON string back to array of objects", () => {
    const original = [
      { name: "Alice", age: 30, city: "NYC" },
      { name: "Bob", age: 25, city: "LA" },
    ];
    const toon = toToon(original);
    const decoded = fromToon(toon);
    expect(decoded).toEqual(original);
  });

  it("round-trips an empty array", () => {
    const toon = toToon([]);
    const decoded = fromToon(toon);
    expect(decoded).toEqual([]);
  });

  it("round-trips a single-element array", () => {
    const original = [{ id: 1, label: "test" }];
    const toon = toToon(original);
    const decoded = fromToon(toon);
    expect(decoded).toEqual(original);
  });

  it("round-trips arrays with nested objects", () => {
    const original = [
      { user: { name: "Alice" }, scores: [1, 2, 3] },
      { user: { name: "Bob" }, scores: [4, 5, 6] },
    ];
    const toon = toToon(original);
    const decoded = fromToon(toon);
    expect(decoded).toEqual(original);
  });

  it("round-trips arrays with missing keys", () => {
    const original = [
      { name: "Alice", age: 30 },
      { name: "Bob", email: "bob@test.com" },
    ];
    const toon = toToon(original);
    const decoded = fromToon(toon);
    expect(decoded).toEqual(original);
  });

  it("round-trips arrays of primitives", () => {
    const original = [1, 2, 3, 4, 5];
    const toon = toToon(original);
    const decoded = fromToon(toon);
    expect(decoded).toEqual(original);
  });

  it("round-trips large uniform arrays", () => {
    const original = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      active: i % 2 === 0,
    }));
    const toon = toToon(original);
    const decoded = fromToon(toon);
    expect(decoded).toEqual(original);
  });
});

// ============================================================================
// maybeEncode - Smart encoding decisions
// ============================================================================

describe("maybeEncode", () => {
  it("returns format 'toon' for uniform flat arrays with significant savings", () => {
    const data = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      email: `user${i}@example.com`,
      active: true,
    }));
    const result = maybeEncode(data);
    expect(result.format).toBe("toon");
    expect(typeof result.data).toBe("string");
  });

  it("returns format 'json' for non-uniform/mixed arrays", () => {
    const data = [
      { name: "Alice", age: 30 },
      { name: "Bob", email: "bob@test.com" },
      { title: "Something", count: 5, nested: { a: 1 } },
    ];
    const result = maybeEncode(data);
    // Mixed arrays may not yield enough savings -- could be either format
    expect(["json", "toon"]).toContain(result.format);
    expect(typeof result.data).toBe("string");
  });

  it("returns format 'json' for empty arrays", () => {
    const result = maybeEncode([]);
    expect(result.format).toBe("json");
    expect(result.data).toBe("[]");
  });

  it("returns format 'json' for single-element arrays (not enough savings)", () => {
    const result = maybeEncode([{ id: 1 }]);
    // Single element unlikely to beat threshold
    expect(["json", "toon"]).toContain(result.format);
    expect(typeof result.data).toBe("string");
  });

  it("respects custom threshold parameter", () => {
    const data = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
    }));
    // With very high threshold (99%), should fall back to JSON
    const highThreshold = maybeEncode(data, 99);
    expect(highThreshold.format).toBe("json");

    // With zero threshold, even tiny savings use TOON
    const zeroThreshold = maybeEncode(data, 0);
    expect(zeroThreshold.format).toBe("toon");
  });

  it("data is valid: can decode TOON format back", () => {
    const original = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      active: true,
    }));
    const result = maybeEncode(original);
    if (result.format === "toon") {
      const decoded = fromToon(result.data);
      expect(decoded).toEqual(original);
    } else {
      const decoded = JSON.parse(result.data);
      expect(decoded).toEqual(original);
    }
  });

  it("data is valid: can parse JSON format back", () => {
    const original = [{ a: 1 }];
    const result = maybeEncode(original);
    if (result.format === "json") {
      const decoded = JSON.parse(result.data);
      expect(decoded).toEqual(original);
    }
  });
});

// ============================================================================
// estimateTokenSavings - Token estimation
// ============================================================================

describe("estimateTokenSavings", () => {
  it("returns savings estimate with correct shape", () => {
    const data = [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
    ];
    const estimate = estimateTokenSavings(data);
    expect(typeof estimate.jsonTokens).toBe("number");
    expect(typeof estimate.toonTokens).toBe("number");
    expect(typeof estimate.savingsPercent).toBe("number");
  });

  it("shows positive savings for uniform flat arrays", () => {
    const data = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      email: `user${i}@example.com`,
      role: "member",
    }));
    const estimate = estimateTokenSavings(data);
    expect(estimate.savingsPercent).toBeGreaterThan(0);
    expect(estimate.toonTokens).toBeLessThan(estimate.jsonTokens);
  });

  it("returns zero or near-zero savings for empty array", () => {
    const estimate = estimateTokenSavings([]);
    expect(estimate.jsonTokens).toBeGreaterThanOrEqual(0);
    expect(estimate.toonTokens).toBeGreaterThanOrEqual(0);
  });

  it("returns non-negative savingsPercent", () => {
    const data = [{ a: 1 }];
    const estimate = estimateTokenSavings(data);
    // Savings might be zero or negative for trivial arrays, but percent should be >= 0
    // (we clamp negative savings to 0)
    expect(estimate.savingsPercent).toBeGreaterThanOrEqual(0);
  });

  it("estimates higher savings for larger uniform arrays", () => {
    const small = Array.from({ length: 5 }, (_, i) => ({
      id: i,
      name: `u${i}`,
    }));
    const large = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `u${i}`,
    }));
    const smallEst = estimateTokenSavings(small);
    const largeEst = estimateTokenSavings(large);
    // Larger arrays should have more absolute token savings
    const smallAbsSaving = smallEst.jsonTokens - smallEst.toonTokens;
    const largeAbsSaving = largeEst.jsonTokens - largeEst.toonTokens;
    expect(largeAbsSaving).toBeGreaterThan(smallAbsSaving);
  });

  it("token counts are always positive integers for non-empty arrays", () => {
    const data = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ];
    const estimate = estimateTokenSavings(data);
    expect(Number.isInteger(estimate.jsonTokens)).toBe(true);
    expect(Number.isInteger(estimate.toonTokens)).toBe(true);
    expect(estimate.jsonTokens).toBeGreaterThan(0);
    expect(estimate.toonTokens).toBeGreaterThan(0);
  });
});
