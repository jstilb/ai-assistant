/**
 * TrialRunner Enhancement Tests
 * TDD RED phase: Tests for pass_rate, pass_at_k, pass_all_k metrics
 */

import { describe, test, expect } from "bun:test";
import {
  computePassRate,
  computePassAtK,
  computePassAllK,
  type TrialOutcome,
} from "../TrialRunnerMetrics.ts";

describe("TrialRunner Enhanced Metrics", () => {
  describe("computePassRate", () => {
    test("returns 1.0 when all trials pass", () => {
      const outcomes: TrialOutcome[] = [
        { passed: true, score: 1.0 },
        { passed: true, score: 0.9 },
        { passed: true, score: 0.85 },
      ];
      expect(computePassRate(outcomes)).toBe(1.0);
    });

    test("returns 0.0 when no trials pass", () => {
      const outcomes: TrialOutcome[] = [
        { passed: false, score: 0.2 },
        { passed: false, score: 0.1 },
        { passed: false, score: 0.3 },
      ];
      expect(computePassRate(outcomes)).toBe(0.0);
    });

    test("returns correct fraction for mixed results", () => {
      const outcomes: TrialOutcome[] = [
        { passed: true, score: 0.8 },
        { passed: false, score: 0.3 },
        { passed: true, score: 0.9 },
        { passed: false, score: 0.4 },
        { passed: true, score: 0.7 },
      ];
      expect(computePassRate(outcomes)).toBeCloseTo(0.6, 2);
    });

    test("handles single trial", () => {
      expect(computePassRate([{ passed: true, score: 1.0 }])).toBe(1.0);
      expect(computePassRate([{ passed: false, score: 0.0 }])).toBe(0.0);
    });
  });

  describe("computePassAtK", () => {
    test("returns 1.0 when at least one trial passes (k=default trials)", () => {
      const outcomes: TrialOutcome[] = [
        { passed: false, score: 0.2 },
        { passed: true, score: 0.8 },
        { passed: false, score: 0.3 },
      ];
      expect(computePassAtK(outcomes)).toBe(1.0);
    });

    test("returns 0.0 when no trials pass", () => {
      const outcomes: TrialOutcome[] = [
        { passed: false, score: 0.2 },
        { passed: false, score: 0.1 },
        { passed: false, score: 0.3 },
      ];
      expect(computePassAtK(outcomes)).toBe(0.0);
    });

    test("computes correct probability for k=1 with 1 pass out of 3", () => {
      const outcomes: TrialOutcome[] = [
        { passed: false, score: 0.2 },
        { passed: false, score: 0.1 },
        { passed: true, score: 0.8 },
      ];
      // 1 pass out of 3, k=1: pass@1 = 1 - C(2,1)/C(3,1) = 1 - 2/3 = 1/3
      expect(computePassAtK(outcomes, 1)).toBeCloseTo(1 / 3, 2);
    });

    test("computes probability for k < n with combinatorial formula", () => {
      // 5 trials, 3 pass. For k=2: 1 - C(2,2)/C(5,2) = 1 - 1/10 = 0.9
      const outcomes: TrialOutcome[] = [
        { passed: true, score: 0.8 },
        { passed: true, score: 0.9 },
        { passed: true, score: 0.7 },
        { passed: false, score: 0.3 },
        { passed: false, score: 0.2 },
      ];
      const result = computePassAtK(outcomes, 2);
      expect(result).toBeCloseTo(0.9, 2);
    });
  });

  describe("computePassAllK", () => {
    test("returns 1.0 when all trials pass", () => {
      const outcomes: TrialOutcome[] = [
        { passed: true, score: 0.8 },
        { passed: true, score: 0.9 },
        { passed: true, score: 0.7 },
      ];
      expect(computePassAllK(outcomes)).toBe(1.0);
    });

    test("returns 0.0 when any trial fails", () => {
      const outcomes: TrialOutcome[] = [
        { passed: true, score: 0.8 },
        { passed: false, score: 0.3 },
        { passed: true, score: 0.7 },
      ];
      expect(computePassAllK(outcomes)).toBe(0.0);
    });

    test("returns 1.0 for single passing trial", () => {
      expect(computePassAllK([{ passed: true, score: 1.0 }])).toBe(1.0);
    });

    test("returns 0.0 for single failing trial", () => {
      expect(computePassAllK([{ passed: false, score: 0.0 }])).toBe(0.0);
    });
  });
});
