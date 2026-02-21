import { describe, test, expect, beforeEach } from "bun:test";

/**
 * CascadingFaultEngine.test.ts - M2 Cascading Fault Pattern Tests
 *
 * Tests for:
 * - Cascade pattern definition and validation
 * - Fault-during-recovery scenarios
 * - Chain reaction simulation
 * - Step-by-step cascade execution
 * - Recovery verification after cascaded faults
 * - Configurable cascade patterns
 */

import {
  createCascadePattern,
  validateCascadePattern,
  CascadingFaultEngine,
  type CascadePattern,
  type CascadeStep,
  type CascadeExecutionResult,
} from "../CascadingFaultEngine.ts";

describe("CascadingFaultEngine", () => {
  // -- Pattern Creation & Validation --

  describe("Pattern Creation", () => {
    test("creates a basic cascade pattern", () => {
      const pattern = createCascadePattern({
        name: "timeout-retry-ratelimit",
        steps: [
          { fault_type: "network_timeout", trigger_after: "immediate", parameters: { delay_ms: 5000 } },
          { fault_type: "network_timeout", trigger_after: "on_retry", parameters: { delay_ms: 3000 } },
          { fault_type: "rate_limit", trigger_after: "on_retry", parameters: { retry_after: 30 } },
        ],
      });

      expect(pattern.name).toBe("timeout-retry-ratelimit");
      expect(pattern.steps).toHaveLength(3);
    });

    test("validates a valid cascade pattern", () => {
      const pattern: CascadePattern = {
        name: "simple-cascade",
        steps: [
          { fault_type: "network_timeout", trigger_after: "immediate", parameters: {} },
        ],
      };

      const result = validateCascadePattern(pattern);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("rejects pattern with no steps", () => {
      const pattern: CascadePattern = {
        name: "empty",
        steps: [],
      };

      const result = validateCascadePattern(pattern);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes("step"))).toBe(true);
    });

    test("rejects pattern with missing name", () => {
      const pattern = {
        name: "",
        steps: [
          { fault_type: "network_timeout", trigger_after: "immediate", parameters: {} },
        ],
      } as CascadePattern;

      const result = validateCascadePattern(pattern);
      expect(result.valid).toBe(false);
    });

    test("rejects invalid trigger_after value", () => {
      const pattern = {
        name: "bad-trigger",
        steps: [
          { fault_type: "network_timeout", trigger_after: "invalid_trigger", parameters: {} },
        ],
      };

      const result = validateCascadePattern(pattern as any);
      expect(result.valid).toBe(false);
    });

    test("rejects invalid fault_type", () => {
      const pattern = {
        name: "bad-fault",
        steps: [
          { fault_type: "nonexistent_fault", trigger_after: "immediate", parameters: {} },
        ],
      };

      const result = validateCascadePattern(pattern as any);
      expect(result.valid).toBe(false);
    });

    test("validates pattern with recovery_check enabled", () => {
      const pattern: CascadePattern = {
        name: "with-recovery",
        steps: [
          { fault_type: "network_timeout", trigger_after: "immediate", parameters: {} },
          { fault_type: "rate_limit", trigger_after: "on_recovery", parameters: {} },
        ],
        recovery_check: true,
      };

      const result = validateCascadePattern(pattern);
      expect(result.valid).toBe(true);
    });
  });

  // -- Engine Execution --

  describe("Engine Execution", () => {
    let engine: CascadingFaultEngine;

    beforeEach(() => {
      engine = new CascadingFaultEngine();
    });

    test("executes a single-step cascade", async () => {
      const pattern: CascadePattern = {
        name: "single-timeout",
        steps: [
          { fault_type: "network_timeout", trigger_after: "immediate", parameters: { delay_ms: 100 } },
        ],
      };

      const result = await engine.execute(pattern);
      expect(result.pattern_name).toBe("single-timeout");
      expect(result.steps_executed).toBe(1);
      expect(result.total_steps).toBe(1);
      expect(result.completed).toBe(true);
    });

    test("executes multi-step cascade sequentially", async () => {
      const pattern: CascadePattern = {
        name: "timeout-then-ratelimit",
        steps: [
          { fault_type: "network_timeout", trigger_after: "immediate", parameters: { delay_ms: 50 } },
          { fault_type: "rate_limit", trigger_after: "on_retry", parameters: { retry_after: 1 } },
          { fault_type: "tool_unavailable", trigger_after: "on_retry", parameters: {} },
        ],
      };

      const result = await engine.execute(pattern);
      expect(result.pattern_name).toBe("timeout-then-ratelimit");
      expect(result.total_steps).toBe(3);
      expect(result.steps_executed).toBeGreaterThanOrEqual(1);
      expect(result.step_results).toHaveLength(result.steps_executed);
    });

    test("respects delay_ms between cascade steps", async () => {
      const pattern: CascadePattern = {
        name: "delayed-cascade",
        steps: [
          { fault_type: "network_timeout", trigger_after: "immediate", delay_ms: 50, parameters: {} },
          { fault_type: "rate_limit", trigger_after: "on_retry", delay_ms: 50, parameters: {} },
        ],
      };

      const start = Date.now();
      const result = await engine.execute(pattern);
      const elapsed = Date.now() - start;

      // Should take at least the sum of delays
      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(result.completed).toBe(true);
    });

    test("step results contain fault details", async () => {
      const pattern: CascadePattern = {
        name: "detail-check",
        steps: [
          { fault_type: "malformed_response", trigger_after: "immediate", parameters: { corruption: "truncate" } },
        ],
      };

      const result = await engine.execute(pattern);
      expect(result.step_results).toHaveLength(1);
      const step = result.step_results[0];
      expect(step.fault_type).toBe("malformed_response");
      expect(step.trigger_after).toBe("immediate");
      expect(step.injected).toBe(true);
      expect(step.timestamp).toBeDefined();
    });

    test("recovery check verifies system recovery after cascade", async () => {
      const pattern: CascadePattern = {
        name: "recovery-test",
        steps: [
          { fault_type: "network_timeout", trigger_after: "immediate", parameters: {} },
        ],
        recovery_check: true,
      };

      const result = await engine.execute(pattern);
      expect(result.recovery_verified).toBeDefined();
      expect(typeof result.recovery_verified).toBe("boolean");
    });

    test("getExecutionLog returns history of all executions", async () => {
      const pattern: CascadePattern = {
        name: "log-test",
        steps: [
          { fault_type: "network_timeout", trigger_after: "immediate", parameters: {} },
        ],
      };

      await engine.execute(pattern);
      await engine.execute(pattern);

      const log = engine.getExecutionLog();
      expect(log).toHaveLength(2);
      expect(log[0].pattern_name).toBe("log-test");
      expect(log[1].pattern_name).toBe("log-test");
    });

    test("reset clears execution log", async () => {
      const pattern: CascadePattern = {
        name: "reset-test",
        steps: [
          { fault_type: "network_timeout", trigger_after: "immediate", parameters: {} },
        ],
      };

      await engine.execute(pattern);
      expect(engine.getExecutionLog()).toHaveLength(1);

      engine.reset();
      expect(engine.getExecutionLog()).toHaveLength(0);
    });
  });

  // -- Predefined Patterns --

  describe("Predefined Patterns", () => {
    test("timeout-retry-ratelimit pattern is valid", () => {
      const pattern = createCascadePattern({
        name: "timeout-retry-ratelimit",
        steps: [
          { fault_type: "network_timeout", trigger_after: "immediate", parameters: { delay_ms: 5000 } },
          { fault_type: "network_timeout", trigger_after: "on_retry", parameters: { delay_ms: 10000 } },
          { fault_type: "rate_limit", trigger_after: "on_retry", parameters: { retry_after: 30 } },
        ],
        recovery_check: true,
      });

      expect(validateCascadePattern(pattern).valid).toBe(true);
    });

    test("unavailable-then-malformed pattern is valid", () => {
      const pattern = createCascadePattern({
        name: "unavailable-then-malformed",
        steps: [
          { fault_type: "tool_unavailable", trigger_after: "immediate", parameters: {} },
          { fault_type: "malformed_response", trigger_after: "on_recovery", parameters: {} },
        ],
      });

      expect(validateCascadePattern(pattern).valid).toBe(true);
    });
  });
});
