/**
 * LearningJudgment.test.ts — parseLearningsArray defensive-parsing contract (S8).
 *
 * ISC-1: valid array of well-formed items parses through unchanged.
 * ISC-2: a malformed individual item is dropped, valid siblings survive (per-item fail-open).
 * ISC-3: non-array / missing input returns [] (the documented "no learnings" shape).
 * ISC-4: category outside the SYSTEM|ALGORITHM enum is rejected.
 */
import { describe, it, expect } from "bun:test";
import { parseLearningsArray, LearningItemSchema } from "./LearningJudgment.ts";

describe("ISC-1: valid learnings array parses through", () => {
  it("returns all items when every item is well-formed", () => {
    const raw = [
      { summary: "Cron silently stopped emitting output", category: "SYSTEM", evidence: "needed a keep-alive signal" },
      { summary: "Assumed the wrong scope and cost time", category: "ALGORITHM", evidence: "checking in first would have saved a rewrite" },
    ];
    const result = parseLearningsArray(raw);
    expect(result).toHaveLength(2);
    expect(result[0]!.category).toBe("SYSTEM");
    expect(result[1]!.category).toBe("ALGORITHM");
  });
});

describe("ISC-2: per-item fail-open — bad item dropped, good siblings survive", () => {
  it("drops an item missing required fields but keeps valid ones", () => {
    const raw = [
      { summary: "Valid item", category: "SYSTEM", evidence: "some evidence" },
      { summary: "Missing category" }, // malformed
      { summary: "Another valid item", category: "ALGORITHM", evidence: "more evidence" },
    ];
    const result = parseLearningsArray(raw);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.summary)).toEqual(["Valid item", "Another valid item"]);
  });

  it("drops an item with an empty summary string", () => {
    const raw = [{ summary: "", category: "SYSTEM", evidence: "x" }];
    expect(parseLearningsArray(raw)).toHaveLength(0);
  });
});

describe("ISC-3: non-array / missing input returns []", () => {
  it("returns [] for undefined", () => {
    expect(parseLearningsArray(undefined)).toEqual([]);
  });

  it("returns [] for null", () => {
    expect(parseLearningsArray(null)).toEqual([]);
  });

  it("returns [] for a non-array object", () => {
    expect(parseLearningsArray({ summary: "not an array" })).toEqual([]);
  });

  it("returns [] for an empty array", () => {
    expect(parseLearningsArray([])).toEqual([]);
  });
});

describe("ISC-4: category outside SYSTEM|ALGORITHM is rejected", () => {
  it("drops an item with an invalid category value", () => {
    const raw = [
      { summary: "Bad category", category: "OTHER", evidence: "x" },
      { summary: "Good category", category: "SYSTEM", evidence: "y" },
    ];
    const result = parseLearningsArray(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.summary).toBe("Good category");
  });

  it("LearningItemSchema rejects category null explicitly (documents the false-case shape from LearningCaptureFixtureRunner is NOT valid here)", () => {
    const parsed = LearningItemSchema.safeParse({ summary: "x", category: null, evidence: "y" });
    expect(parsed.success).toBe(false);
  });
});
