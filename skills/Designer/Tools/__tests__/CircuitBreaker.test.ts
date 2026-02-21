/**
 * CircuitBreaker.test.ts - Tests for circuit breaker pattern
 *
 * Tests:
 * - Initial state is CLOSED
 * - Transitions to OPEN after threshold consecutive failures
 * - Rejects calls when OPEN
 * - Transitions to HALF_OPEN after cooldown
 * - Returns to CLOSED on success in HALF_OPEN
 * - Returns to OPEN on failure in HALF_OPEN
 * - Reset clears state
 * - Configurable thresholds for different adapters
 * - State transition logging
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  CircuitBreaker,
  CircuitBreakerState,
  createCircuitBreaker,
  type CircuitBreakerConfig,
} from "../CircuitBreaker.ts";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = createCircuitBreaker({
      name: "test-breaker",
      failureThreshold: 3,
      cooldownMs: 100, // short for testing
    });
  });

  describe("initial state", () => {
    it("starts in CLOSED state", () => {
      expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);
    });

    it("allows calls when CLOSED", () => {
      expect(breaker.canAttempt()).toBe(true);
    });

    it("has zero failure count initially", () => {
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  describe("failure tracking", () => {
    it("increments failure count on recordFailure", () => {
      breaker.recordFailure();
      expect(breaker.getFailureCount()).toBe(1);
    });

    it("transitions to OPEN after reaching failure threshold", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure(); // threshold = 3
      expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);
    });

    it("rejects calls when OPEN", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.canAttempt()).toBe(false);
    });

    it("resets failure count on success", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordSuccess();
      expect(breaker.getFailureCount()).toBe(0);
      expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);
    });
  });

  describe("cooldown and HALF_OPEN", () => {
    it("transitions to HALF_OPEN after cooldown period", async () => {
      // Trip the breaker
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);

      // Wait for cooldown (100ms + buffer)
      await new Promise((r) => setTimeout(r, 150));

      // Should now be HALF_OPEN (allows one attempt)
      expect(breaker.canAttempt()).toBe(true);
      expect(breaker.getState()).toBe(CircuitBreakerState.HALF_OPEN);
    });

    it("returns to CLOSED on success in HALF_OPEN", async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      await new Promise((r) => setTimeout(r, 150));

      // Trigger HALF_OPEN
      breaker.canAttempt();
      expect(breaker.getState()).toBe(CircuitBreakerState.HALF_OPEN);

      // Success in HALF_OPEN -> CLOSED
      breaker.recordSuccess();
      expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);
      expect(breaker.getFailureCount()).toBe(0);
    });

    it("returns to OPEN on failure in HALF_OPEN", async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      await new Promise((r) => setTimeout(r, 150));

      breaker.canAttempt(); // triggers HALF_OPEN
      breaker.recordFailure(); // back to OPEN
      expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);
    });
  });

  describe("reset", () => {
    it("resets to CLOSED with zero failures", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);

      breaker.reset();
      expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);
      expect(breaker.getFailureCount()).toBe(0);
      expect(breaker.canAttempt()).toBe(true);
    });
  });

  describe("execute wrapper", () => {
    it("returns result on success", async () => {
      const result = await breaker.execute(async () => "hello");
      expect(result).toBe("hello");
    });

    it("throws and records failure when function throws", async () => {
      try {
        await breaker.execute(async () => {
          throw new Error("boom");
        });
        expect(true).toBe(false); // should not reach
      } catch (e: any) {
        expect(e.message).toBe("boom");
      }
      expect(breaker.getFailureCount()).toBe(1);
    });

    it("throws CircuitOpenError when breaker is OPEN", async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      try {
        await breaker.execute(async () => "should not run");
        expect(true).toBe(false);
      } catch (e: any) {
        expect(e.message).toContain("Circuit breaker");
        expect(e.message).toContain("OPEN");
      }
    });
  });

  describe("configurable thresholds", () => {
    it("Claude Vision: opens after 3 failures, 60s cooldown", () => {
      const claude = createCircuitBreaker({
        name: "claude-vision",
        failureThreshold: 3,
        cooldownMs: 60_000,
      });
      expect(claude.getState()).toBe(CircuitBreakerState.CLOSED);
      claude.recordFailure();
      claude.recordFailure();
      expect(claude.getState()).toBe(CircuitBreakerState.CLOSED);
      claude.recordFailure();
      expect(claude.getState()).toBe(CircuitBreakerState.OPEN);
    });

    it("Gemini MCP: opens after 2 failures, 120s cooldown", () => {
      const gemini = createCircuitBreaker({
        name: "gemini-mcp",
        failureThreshold: 2,
        cooldownMs: 120_000,
      });
      gemini.recordFailure();
      expect(gemini.getState()).toBe(CircuitBreakerState.CLOSED);
      gemini.recordFailure();
      expect(gemini.getState()).toBe(CircuitBreakerState.OPEN);
    });

    it("Shopping Skill: opens after 5 failures, 300s cooldown", () => {
      const shopping = createCircuitBreaker({
        name: "shopping-skill",
        failureThreshold: 5,
        cooldownMs: 300_000,
      });
      for (let i = 0; i < 4; i++) shopping.recordFailure();
      expect(shopping.getState()).toBe(CircuitBreakerState.CLOSED);
      shopping.recordFailure();
      expect(shopping.getState()).toBe(CircuitBreakerState.OPEN);
    });
  });

  describe("state transition log", () => {
    it("records transitions", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure(); // CLOSED -> OPEN

      const log = breaker.getTransitionLog();
      expect(log.length).toBeGreaterThan(0);
      const lastTransition = log[log.length - 1];
      expect(lastTransition.from).toBe(CircuitBreakerState.CLOSED);
      expect(lastTransition.to).toBe(CircuitBreakerState.OPEN);
      expect(lastTransition.timestamp).toBeDefined();
    });
  });
});
