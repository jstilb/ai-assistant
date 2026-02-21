/**
 * CostTracker.test.ts - Tests for cost tracking with session cap
 *
 * Tests:
 * - Cost accumulation per API call
 * - $5.00 session hard cap enforcement
 * - Per-API cost tracking
 * - Cost cap warning generation
 * - Cumulative total accuracy
 */

import { describe, it, expect } from "bun:test";
import {
  createCostTracker,
  type CostTracker,
  type CostEntry,
  DEFAULT_SESSION_CAP,
} from "../CostTracker.ts";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CostTracker", () => {
  describe("createCostTracker", () => {
    it("creates a tracker with zero initial cost", () => {
      const tracker = createCostTracker();
      expect(tracker.getTotalCost()).toBe(0);
    });

    it("creates a tracker with default $5 session cap", () => {
      const tracker = createCostTracker();
      expect(tracker.getSessionCap()).toBe(5.0);
    });

    it("accepts custom session cap", () => {
      const tracker = createCostTracker(10.0);
      expect(tracker.getSessionCap()).toBe(10.0);
    });
  });

  describe("recordCost", () => {
    it("records a cost entry for an API call", () => {
      const tracker = createCostTracker();
      tracker.recordCost("claude_vision", 0.025);

      const entries = tracker.getEntries();
      expect(entries.length).toBe(1);
      expect(entries[0].api_name).toBe("claude_vision");
      expect(entries[0].cost).toBe(0.025);
    });

    it("calculates cumulative_total correctly", () => {
      const tracker = createCostTracker();
      tracker.recordCost("claude_vision", 0.025);
      tracker.recordCost("gemini_vision", 0.01);
      tracker.recordCost("claude_vision", 0.03);

      const entries = tracker.getEntries();
      expect(entries[0].cumulative_total).toBe(0.025);
      expect(entries[1].cumulative_total).toBeCloseTo(0.035, 5);
      expect(entries[2].cumulative_total).toBeCloseTo(0.065, 5);
    });

    it("adds timestamp to each entry", () => {
      const tracker = createCostTracker();
      tracker.recordCost("claude_vision", 0.025);

      const entry = tracker.getEntries()[0];
      expect(entry.timestamp).toBeDefined();
      expect(entry.timestamp.length).toBeGreaterThan(0);
    });
  });

  describe("getTotalCost", () => {
    it("returns sum of all recorded costs", () => {
      const tracker = createCostTracker();
      tracker.recordCost("claude_vision", 0.025);
      tracker.recordCost("gemini_vision", 0.01);
      tracker.recordCost("shopping", 0.005);

      expect(tracker.getTotalCost()).toBeCloseTo(0.04, 5);
    });

    it("returns 0 when no costs recorded", () => {
      const tracker = createCostTracker();
      expect(tracker.getTotalCost()).toBe(0);
    });
  });

  describe("isCapReached", () => {
    it("returns false when under cap", () => {
      const tracker = createCostTracker(5.0);
      tracker.recordCost("claude_vision", 0.025);
      expect(tracker.isCapReached()).toBe(false);
    });

    it("returns true when at cap", () => {
      const tracker = createCostTracker(0.05);
      tracker.recordCost("claude_vision", 0.025);
      tracker.recordCost("gemini_vision", 0.025);
      expect(tracker.isCapReached()).toBe(true);
    });

    it("returns true when over cap", () => {
      const tracker = createCostTracker(0.03);
      tracker.recordCost("claude_vision", 0.025);
      tracker.recordCost("gemini_vision", 0.01);
      expect(tracker.isCapReached()).toBe(true);
    });
  });

  describe("$5.00 session cap enforcement", () => {
    it("allows calls under the cap", () => {
      const tracker = createCostTracker(5.0);
      const result = tracker.checkBudget("claude_vision", 0.025);
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it("rejects calls when cap is reached", () => {
      const tracker = createCostTracker(0.05);
      tracker.recordCost("claude_vision", 0.025);
      tracker.recordCost("gemini_vision", 0.025);

      const result = tracker.checkBudget("claude_vision", 0.025);
      expect(result.allowed).toBe(false);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain("cost");
    });

    it("warns when approaching cap (> 80%)", () => {
      const tracker = createCostTracker(1.0);
      tracker.recordCost("claude_vision", 0.85);

      const result = tracker.checkBudget("claude_vision", 0.025);
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeDefined();
    });
  });

  describe("per-API cost tracking", () => {
    it("tracks costs grouped by API name", () => {
      const tracker = createCostTracker();
      tracker.recordCost("claude_vision", 0.025);
      tracker.recordCost("claude_vision", 0.03);
      tracker.recordCost("gemini_vision", 0.01);
      tracker.recordCost("gemini_vision", 0.01);
      tracker.recordCost("shopping", 0.005);

      const perApi = tracker.getCostsByApi();
      expect(perApi["claude_vision"]).toBeCloseTo(0.055, 5);
      expect(perApi["gemini_vision"]).toBeCloseTo(0.02, 5);
      expect(perApi["shopping"]).toBeCloseTo(0.005, 5);
    });

    it("returns empty object when no costs recorded", () => {
      const tracker = createCostTracker();
      const perApi = tracker.getCostsByApi();
      expect(Object.keys(perApi).length).toBe(0);
    });
  });

  describe("reset", () => {
    it("clears all entries and resets total", () => {
      const tracker = createCostTracker();
      tracker.recordCost("claude_vision", 0.025);
      tracker.recordCost("gemini_vision", 0.01);

      tracker.reset();
      expect(tracker.getTotalCost()).toBe(0);
      expect(tracker.getEntries().length).toBe(0);
    });
  });

  describe("DEFAULT_SESSION_CAP", () => {
    it("is $5.00", () => {
      expect(DEFAULT_SESSION_CAP).toBe(5.0);
    });
  });
});
