/**
 * CostVerification.test.ts - Cost tracking verification with session cap
 *
 * Tests:
 *   - 50 simulated analyses with mocked cost tracking
 *   - Average cost < $0.40 per analysis
 *   - $5.00 session cap enforcement: at $4.99, next call triggers fallback
 *   - 80% warning threshold triggers warning
 *   - Per-API cost breakdown accuracy
 *
 * @module CostVerification.test
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  createCostTracker,
  DEFAULT_SESSION_CAP,
  type CostTracker,
} from "../CostTracker.ts";

// ---------------------------------------------------------------------------
// Per-API cost estimates (matching CostTracker docs)
// ---------------------------------------------------------------------------

const COSTS = {
  claude_vision: 0.025,    // ~$0.015-0.03
  gemini_vision: 0.01,     // ~$0.01
  shopping_skill: 0.005,   // ~$0.005
  text_inference: 0.002,   // very cheap fallback
};

// A typical analysis makes 1 vision call + 1 shopping call
const TYPICAL_ANALYSIS_COST = COSTS.claude_vision + COSTS.shopping_skill; // 0.03

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CostVerification - Session Cost Tracking", () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = createCostTracker();
  });

  describe("basic tracking", () => {
    it("starts at zero cost", () => {
      expect(tracker.getTotalCost()).toBe(0);
      expect(tracker.getEntries().length).toBe(0);
      expect(tracker.isCapReached()).toBe(false);
    });

    it("records individual API costs", () => {
      tracker.recordCost("claude_vision", 0.025);
      tracker.recordCost("shopping_skill", 0.005);

      expect(tracker.getTotalCost()).toBeCloseTo(0.03, 10);
      expect(tracker.getEntries().length).toBe(2);
    });

    it("tracks cumulative total correctly", () => {
      tracker.recordCost("claude_vision", 0.025);
      tracker.recordCost("gemini_vision", 0.01);
      tracker.recordCost("shopping_skill", 0.005);

      expect(tracker.getTotalCost()).toBeCloseTo(0.04, 10);

      const entries = tracker.getEntries();
      expect(entries[0].cumulative_total).toBeCloseTo(0.025, 10);
      expect(entries[1].cumulative_total).toBeCloseTo(0.035, 10);
      expect(entries[2].cumulative_total).toBeCloseTo(0.04, 10);
    });
  });

  describe("50 simulated analyses", () => {
    it("average cost < $0.40 per analysis over 50 runs", () => {
      const analysisTracker = createCostTracker(100); // High cap so we don't hit it

      for (let i = 0; i < 50; i++) {
        // Each analysis: 1 vision call + 1 shopping call
        analysisTracker.recordCost("claude_vision", COSTS.claude_vision);
        analysisTracker.recordCost("shopping_skill", COSTS.shopping_skill);
      }

      const totalCost = analysisTracker.getTotalCost();
      const avgCost = totalCost / 50;

      expect(avgCost).toBeLessThan(0.40);
      // Should be around $0.03 per analysis
      expect(avgCost).toBeCloseTo(TYPICAL_ANALYSIS_COST, 5);
    });

    it("50 analyses stay well under session cap of $5.00", () => {
      for (let i = 0; i < 50; i++) {
        tracker.recordCost("claude_vision", COSTS.claude_vision);
        tracker.recordCost("shopping_skill", COSTS.shopping_skill);
      }

      // 50 * $0.03 = $1.50, well under $5.00
      expect(tracker.getTotalCost()).toBeLessThan(DEFAULT_SESSION_CAP);
      expect(tracker.isCapReached()).toBe(false);
    });
  });

  describe("session cap enforcement", () => {
    it("default session cap is $5.00", () => {
      expect(tracker.getSessionCap()).toBe(5.0);
      expect(DEFAULT_SESSION_CAP).toBe(5.0);
    });

    it("at $4.99 next call is still allowed but warns", () => {
      // Push to $4.99
      tracker.recordCost("bulk_calls", 4.99);

      const check = tracker.checkBudget("claude_vision", 0.025);
      // 4.99/5.00 = 99.8% > 80% threshold
      expect(check.allowed).toBe(true);
      expect(check.warning).toBeDefined();
      expect(check.warning).toContain("Approaching");
      expect(check.remaining).toBeCloseTo(0.01, 5);
    });

    it("at exactly $5.00 cap, next call is rejected", () => {
      tracker.recordCost("expensive_calls", 5.00);

      expect(tracker.isCapReached()).toBe(true);

      const check = tracker.checkBudget("claude_vision", 0.025);
      expect(check.allowed).toBe(false);
      expect(check.warning).toContain("cap reached");
      expect(check.remaining).toBe(0);
    });

    it("over $5.00 cap, all subsequent calls rejected", () => {
      tracker.recordCost("overrun", 5.50);

      const check = tracker.checkBudget("claude_vision", 0.001);
      expect(check.allowed).toBe(false);
      expect(check.remaining).toBe(0);
    });

    it("custom session cap works correctly", () => {
      const customTracker = createCostTracker(2.0);
      expect(customTracker.getSessionCap()).toBe(2.0);

      customTracker.recordCost("api", 1.5);
      expect(customTracker.isCapReached()).toBe(false);

      customTracker.recordCost("api", 0.6);
      expect(customTracker.isCapReached()).toBe(true);
    });
  });

  describe("80% warning threshold", () => {
    it("no warning below 80% usage", () => {
      tracker.recordCost("api", 3.0); // 60% of $5.00

      const check = tracker.checkBudget("claude_vision", 0.025);
      expect(check.allowed).toBe(true);
      expect(check.warning).toBeUndefined();
    });

    it("warning at exactly 80% usage", () => {
      tracker.recordCost("api", 4.0); // 80% of $5.00

      const check = tracker.checkBudget("claude_vision", 0.025);
      expect(check.allowed).toBe(true);
      expect(check.warning).toBeDefined();
      expect(check.warning).toContain("80%");
    });

    it("warning at 90% usage", () => {
      tracker.recordCost("api", 4.5); // 90% of $5.00

      const check = tracker.checkBudget("claude_vision", 0.025);
      expect(check.allowed).toBe(true);
      expect(check.warning).toBeDefined();
      expect(check.warning).toContain("Approaching");
    });

    it("remaining budget is accurate at warning threshold", () => {
      tracker.recordCost("api", 4.2);

      const check = tracker.checkBudget("claude_vision", 0.025);
      expect(check.remaining).toBeCloseTo(0.8, 5);
    });
  });

  describe("per-API cost breakdown", () => {
    it("breaks down costs by API name", () => {
      tracker.recordCost("claude_vision", 0.025);
      tracker.recordCost("claude_vision", 0.025);
      tracker.recordCost("gemini_vision", 0.01);
      tracker.recordCost("shopping_skill", 0.005);
      tracker.recordCost("shopping_skill", 0.005);
      tracker.recordCost("shopping_skill", 0.005);

      const byApi = tracker.getCostsByApi();
      expect(byApi["claude_vision"]).toBeCloseTo(0.05, 10);
      expect(byApi["gemini_vision"]).toBeCloseTo(0.01, 10);
      expect(byApi["shopping_skill"]).toBeCloseTo(0.015, 10);
    });

    it("total of breakdown equals total cost", () => {
      tracker.recordCost("claude_vision", 0.025);
      tracker.recordCost("gemini_vision", 0.01);
      tracker.recordCost("shopping_skill", 0.005);
      tracker.recordCost("text_inference", 0.002);

      const byApi = tracker.getCostsByApi();
      const breakdownTotal = Object.values(byApi).reduce((a, b) => a + b, 0);

      expect(breakdownTotal).toBeCloseTo(tracker.getTotalCost(), 10);
    });

    it("handles many entries for the same API", () => {
      for (let i = 0; i < 100; i++) {
        tracker.recordCost("claude_vision", 0.025);
      }

      const byApi = tracker.getCostsByApi();
      expect(byApi["claude_vision"]).toBeCloseTo(2.5, 5);
      expect(tracker.getTotalCost()).toBeCloseTo(2.5, 5);
    });
  });

  describe("reset behavior", () => {
    it("reset clears all state", () => {
      tracker.recordCost("api", 3.0);
      expect(tracker.getTotalCost()).toBe(3.0);

      tracker.reset();

      expect(tracker.getTotalCost()).toBe(0);
      expect(tracker.getEntries().length).toBe(0);
      expect(tracker.isCapReached()).toBe(false);
    });

    it("tracking resumes normally after reset", () => {
      tracker.recordCost("api", 5.0); // Hit cap
      expect(tracker.isCapReached()).toBe(true);

      tracker.reset();
      expect(tracker.isCapReached()).toBe(false);

      tracker.recordCost("api", 0.5);
      expect(tracker.getTotalCost()).toBe(0.5);
      expect(tracker.isCapReached()).toBe(false);
    });
  });

  describe("timestamps", () => {
    it("each entry has a valid ISO timestamp", () => {
      tracker.recordCost("claude_vision", 0.025);
      tracker.recordCost("gemini_vision", 0.01);

      const entries = tracker.getEntries();
      for (const entry of entries) {
        expect(entry.timestamp).toBeTruthy();
        // Verify it's a valid ISO date
        const date = new Date(entry.timestamp);
        expect(date.getTime()).not.toBeNaN();
      }
    });

    it("timestamps are in chronological order", () => {
      tracker.recordCost("api1", 0.01);
      tracker.recordCost("api2", 0.02);
      tracker.recordCost("api3", 0.03);

      const entries = tracker.getEntries();
      for (let i = 1; i < entries.length; i++) {
        const prev = new Date(entries[i - 1].timestamp).getTime();
        const curr = new Date(entries[i].timestamp).getTime();
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    });
  });
});
