import { describe, test, expect } from "bun:test";
import {
  createAdvancedFaultEngine,
  validateAdvancedFault,
  generateFaultResponse,
  ADVANCED_FAULT_TYPES,
  type AdvancedFault,
  type AdvancedFaultResponse,
} from "../AdvancedFaultTypes.ts";

// ============================================
// M3: Advanced Fault Types Tests
// Each fault type, parameter validation, response generation
// ============================================

describe("AdvancedFaultTypes", () => {
  // --- Validation ---

  describe("validateAdvancedFault", () => {
    test("valid partial_response passes", () => {
      const fault: AdvancedFault = {
        type: "partial_response",
        parameters: { truncate_at: 500 },
      };
      const result = validateAdvancedFault(fault);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("valid delayed_response passes", () => {
      const fault: AdvancedFault = {
        type: "delayed_response",
        parameters: { delay_ms: 2000, jitter_ms: 500 },
      };
      const result = validateAdvancedFault(fault);
      expect(result.valid).toBe(true);
    });

    test("valid intermittent_failure passes", () => {
      const fault: AdvancedFault = {
        type: "intermittent_failure",
        parameters: { success_rate: 0.5, pattern: "random" },
      };
      const result = validateAdvancedFault(fault);
      expect(result.valid).toBe(true);
    });

    test("valid data_corruption passes", () => {
      const fault: AdvancedFault = {
        type: "data_corruption",
        parameters: { corruption_type: "missing_fields" },
      };
      const result = validateAdvancedFault(fault);
      expect(result.valid).toBe(true);
    });

    test("valid resource_exhaustion passes", () => {
      const fault: AdvancedFault = {
        type: "resource_exhaustion",
        parameters: { resource: "memory", error_message: "Out of memory" },
      };
      const result = validateAdvancedFault(fault);
      expect(result.valid).toBe(true);
    });

    test("invalid fault type fails", () => {
      const fault = {
        type: "nonexistent_fault" as any,
        parameters: {},
      };
      const result = validateAdvancedFault(fault);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("type"))).toBe(true);
    });

    test("negative truncate_at fails", () => {
      const fault: AdvancedFault = {
        type: "partial_response",
        parameters: { truncate_at: -1 },
      };
      const result = validateAdvancedFault(fault);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("truncate_at"))).toBe(true);
    });

    test("negative delay_ms fails", () => {
      const fault: AdvancedFault = {
        type: "delayed_response",
        parameters: { delay_ms: -100 },
      };
      const result = validateAdvancedFault(fault);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("delay_ms"))).toBe(true);
    });

    test("success_rate out of range fails", () => {
      const fault: AdvancedFault = {
        type: "intermittent_failure",
        parameters: { success_rate: 1.5 },
      };
      const result = validateAdvancedFault(fault);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("success_rate"))).toBe(true);
    });

    test("invalid corruption_type fails", () => {
      const fault: AdvancedFault = {
        type: "data_corruption",
        parameters: { corruption_type: "invalid_type" as any },
      };
      const result = validateAdvancedFault(fault);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("corruption_type"))).toBe(true);
    });

    test("invalid resource type fails", () => {
      const fault: AdvancedFault = {
        type: "resource_exhaustion",
        parameters: { resource: "invalid_resource" as any },
      };
      const result = validateAdvancedFault(fault);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("resource"))).toBe(true);
    });

    test("invalid pattern fails", () => {
      const fault: AdvancedFault = {
        type: "intermittent_failure",
        parameters: { pattern: "invalid_pattern" as any },
      };
      const result = validateAdvancedFault(fault);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("pattern"))).toBe(true);
    });
  });

  // --- Fault Response Generation ---

  describe("generateFaultResponse", () => {
    test("partial_response truncates data", () => {
      const fault: AdvancedFault = {
        type: "partial_response",
        parameters: { truncate_at: 10 },
      };
      const originalData = '{"name": "test", "value": 42, "description": "a long string here"}';

      const response = generateFaultResponse(fault, originalData);
      expect(response.type).toBe("partial_response");
      expect(response.data).toBeDefined();
      expect((response.data as string).length).toBeLessThanOrEqual(10);
      expect(response.truncated).toBe(true);
    });

    test("partial_response with no truncate_at uses default", () => {
      const fault: AdvancedFault = {
        type: "partial_response",
        parameters: {},
      };

      const response = generateFaultResponse(fault, '{"key": "value"}');
      expect(response.type).toBe("partial_response");
      expect(response.truncated).toBe(true);
    });

    test("delayed_response includes delay metadata", () => {
      const fault: AdvancedFault = {
        type: "delayed_response",
        parameters: { delay_ms: 5000, jitter_ms: 1000 },
      };

      const response = generateFaultResponse(fault, "test data");
      expect(response.type).toBe("delayed_response");
      expect(response.delay_ms).toBeGreaterThanOrEqual(4000);
      expect(response.delay_ms).toBeLessThanOrEqual(6000);
    });

    test("delayed_response with no jitter returns exact delay", () => {
      const fault: AdvancedFault = {
        type: "delayed_response",
        parameters: { delay_ms: 3000 },
      };

      const response = generateFaultResponse(fault, "test data");
      expect(response.delay_ms).toBe(3000);
    });

    test("intermittent_failure with random pattern is deterministic with seed", () => {
      const fault: AdvancedFault = {
        type: "intermittent_failure",
        parameters: { success_rate: 0.5, pattern: "random" },
      };

      const results1: boolean[] = [];
      const results2: boolean[] = [];

      for (let i = 0; i < 20; i++) {
        const r1 = generateFaultResponse(fault, "data", { seed: 42, callIndex: i });
        const r2 = generateFaultResponse(fault, "data", { seed: 42, callIndex: i });
        results1.push(r1.success as boolean);
        results2.push(r2.success as boolean);
      }

      expect(results1).toEqual(results2);
    });

    test("intermittent_failure with alternating pattern alternates", () => {
      const fault: AdvancedFault = {
        type: "intermittent_failure",
        parameters: { success_rate: 0.5, pattern: "alternating" },
      };

      const results: boolean[] = [];
      for (let i = 0; i < 6; i++) {
        const response = generateFaultResponse(fault, "data", { seed: 42, callIndex: i });
        results.push(response.success as boolean);
      }

      // Alternating: true, false, true, false, ...
      expect(results[0]).toBe(true);
      expect(results[1]).toBe(false);
      expect(results[2]).toBe(true);
      expect(results[3]).toBe(false);
    });

    test("intermittent_failure with burst pattern creates bursts", () => {
      const fault: AdvancedFault = {
        type: "intermittent_failure",
        parameters: { success_rate: 0.5, pattern: "burst" },
      };

      const results: boolean[] = [];
      for (let i = 0; i < 10; i++) {
        const response = generateFaultResponse(fault, "data", { seed: 42, callIndex: i });
        results.push(response.success as boolean);
      }

      // Burst pattern should have consecutive failures
      expect(results.length).toBe(10);
      // At least some should succeed and some fail
      expect(results.some(r => r === true)).toBe(true);
      expect(results.some(r => r === false)).toBe(true);
    });

    test("data_corruption with missing_fields removes fields", () => {
      const fault: AdvancedFault = {
        type: "data_corruption",
        parameters: { corruption_type: "missing_fields" },
      };
      const originalData = JSON.stringify({ name: "test", value: 42, extra: "data" });

      const response = generateFaultResponse(fault, originalData);
      expect(response.type).toBe("data_corruption");
      const corrupted = JSON.parse(response.data as string);
      const originalKeys = Object.keys(JSON.parse(originalData));
      const corruptedKeys = Object.keys(corrupted);
      expect(corruptedKeys.length).toBeLessThan(originalKeys.length);
    });

    test("data_corruption with wrong_types changes value types", () => {
      const fault: AdvancedFault = {
        type: "data_corruption",
        parameters: { corruption_type: "wrong_types" },
      };
      const originalData = JSON.stringify({ count: 42, name: "test" });

      const response = generateFaultResponse(fault, originalData);
      expect(response.type).toBe("data_corruption");
      const corrupted = JSON.parse(response.data as string);
      // At least one type should differ from original
      const original = JSON.parse(originalData);
      const hasDifferentType = Object.keys(original).some(
        key => typeof corrupted[key] !== typeof original[key]
      );
      expect(hasDifferentType).toBe(true);
    });

    test("data_corruption with null_values sets values to null", () => {
      const fault: AdvancedFault = {
        type: "data_corruption",
        parameters: { corruption_type: "null_values" },
      };
      const originalData = JSON.stringify({ name: "test", value: 42 });

      const response = generateFaultResponse(fault, originalData);
      const corrupted = JSON.parse(response.data as string);
      const hasNull = Object.values(corrupted).some(v => v === null);
      expect(hasNull).toBe(true);
    });

    test("data_corruption with extra_fields adds unexpected fields", () => {
      const fault: AdvancedFault = {
        type: "data_corruption",
        parameters: { corruption_type: "extra_fields" },
      };
      const originalData = JSON.stringify({ name: "test" });

      const response = generateFaultResponse(fault, originalData);
      const corrupted = JSON.parse(response.data as string);
      const originalKeys = Object.keys(JSON.parse(originalData));
      const corruptedKeys = Object.keys(corrupted);
      expect(corruptedKeys.length).toBeGreaterThan(originalKeys.length);
    });

    test("resource_exhaustion generates correct error for memory", () => {
      const fault: AdvancedFault = {
        type: "resource_exhaustion",
        parameters: { resource: "memory", error_message: "Heap limit reached" },
      };

      const response = generateFaultResponse(fault, "data");
      expect(response.type).toBe("resource_exhaustion");
      expect(response.error).toBe(true);
      expect(response.error_code).toContain("OOM");
      expect(response.error_message).toBe("Heap limit reached");
    });

    test("resource_exhaustion generates correct error for disk", () => {
      const fault: AdvancedFault = {
        type: "resource_exhaustion",
        parameters: { resource: "disk" },
      };

      const response = generateFaultResponse(fault, "data");
      expect(response.error_code).toContain("ENOSPC");
    });

    test("resource_exhaustion generates correct error for connections", () => {
      const fault: AdvancedFault = {
        type: "resource_exhaustion",
        parameters: { resource: "connections" },
      };

      const response = generateFaultResponse(fault, "data");
      expect(response.error_code).toContain("CONN");
    });

    test("resource_exhaustion with default error message", () => {
      const fault: AdvancedFault = {
        type: "resource_exhaustion",
        parameters: { resource: "memory" },
      };

      const response = generateFaultResponse(fault, "data");
      expect(response.error_message).toBeDefined();
      expect(typeof response.error_message).toBe("string");
      expect((response.error_message as string).length).toBeGreaterThan(0);
    });
  });

  // --- Constants ---

  describe("ADVANCED_FAULT_TYPES", () => {
    test("contains all 5 advanced fault types", () => {
      expect(ADVANCED_FAULT_TYPES).toContain("partial_response");
      expect(ADVANCED_FAULT_TYPES).toContain("delayed_response");
      expect(ADVANCED_FAULT_TYPES).toContain("intermittent_failure");
      expect(ADVANCED_FAULT_TYPES).toContain("data_corruption");
      expect(ADVANCED_FAULT_TYPES).toContain("resource_exhaustion");
      expect(ADVANCED_FAULT_TYPES).toHaveLength(5);
    });
  });

  // --- Engine Integration ---

  describe("createAdvancedFaultEngine", () => {
    test("engine processes a fault with valid config", () => {
      const engine = createAdvancedFaultEngine({ seed: 42 });

      const fault: AdvancedFault = {
        type: "partial_response",
        parameters: { truncate_at: 50 },
      };

      const result = engine.inject(fault, '{"data": "some long response data here"}');
      expect(result.type).toBe("partial_response");
      expect(result.truncated).toBe(true);
    });

    test("engine rejects invalid fault config", () => {
      const engine = createAdvancedFaultEngine({ seed: 42 });

      const fault = {
        type: "invalid" as any,
        parameters: {},
      };

      expect(() => engine.inject(fault, "data")).toThrow();
    });

    test("engine tracks injection count", () => {
      const engine = createAdvancedFaultEngine({ seed: 42 });

      engine.inject({ type: "partial_response", parameters: { truncate_at: 10 } }, "data");
      engine.inject({ type: "delayed_response", parameters: { delay_ms: 100 } }, "data");
      engine.inject({ type: "resource_exhaustion", parameters: { resource: "memory" } }, "data");

      const stats = engine.getStats();
      expect(stats.totalInjections).toBe(3);
      expect(stats.byType["partial_response"]).toBe(1);
      expect(stats.byType["delayed_response"]).toBe(1);
      expect(stats.byType["resource_exhaustion"]).toBe(1);
    });

    test("engine reset clears stats", () => {
      const engine = createAdvancedFaultEngine({ seed: 42 });
      engine.inject({ type: "partial_response", parameters: { truncate_at: 10 } }, "data");

      engine.reset();
      const stats = engine.getStats();
      expect(stats.totalInjections).toBe(0);
    });

    test("engine with different seeds produces different intermittent results", () => {
      const engine1 = createAdvancedFaultEngine({ seed: 42 });
      const engine2 = createAdvancedFaultEngine({ seed: 99 });

      const fault: AdvancedFault = {
        type: "intermittent_failure",
        parameters: { success_rate: 0.5, pattern: "random" },
      };

      const results1: boolean[] = [];
      const results2: boolean[] = [];

      for (let i = 0; i < 20; i++) {
        results1.push(engine1.inject(fault, "data").success as boolean);
        results2.push(engine2.inject(fault, "data").success as boolean);
      }

      // Different seeds should produce different sequences
      const allSame = results1.every((v, i) => v === results2[i]);
      expect(allSame).toBe(false);
    });
  });
});
