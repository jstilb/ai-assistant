import { describe, test, expect } from "bun:test";
import {
  createTriggerEngine,
  type TriggerCondition,
  type TriggerDecision,
} from "../TriggerEngine.ts";

// ============================================
// ISC #4, #13: Trigger Engine Tests
// Determinism, all 3 trigger conditions
// ============================================

describe("TriggerEngine", () => {
  // --- call_count trigger ---

  test("call_count triggers after N calls", () => {
    const engine = createTriggerEngine({ seed: 42 });
    const condition: TriggerCondition = {
      type: "call_count",
      call_count_threshold: 3,
    };

    expect(engine.shouldTrigger("Read", condition).triggered).toBe(false); // call 1
    expect(engine.shouldTrigger("Read", condition).triggered).toBe(false); // call 2
    expect(engine.shouldTrigger("Read", condition).triggered).toBe(true);  // call 3
  });

  test("call_count tracks tools independently", () => {
    const engine = createTriggerEngine({ seed: 42 });
    const condition: TriggerCondition = {
      type: "call_count",
      call_count_threshold: 2,
    };

    engine.shouldTrigger("Read", condition);  // Read: 1
    engine.shouldTrigger("Bash", condition);  // Bash: 1
    engine.shouldTrigger("Read", condition);  // Read: 2 -> trigger
    const result = engine.shouldTrigger("Read", condition);
    expect(result.triggered).toBe(true);

    // Bash still at 1, should not trigger
    const bashResult = engine.shouldTrigger("Bash", condition);
    expect(bashResult.triggered).toBe(true); // Bash: 2 -> trigger
  });

  test("call_count threshold of 1 triggers on first call", () => {
    const engine = createTriggerEngine({ seed: 42 });
    const condition: TriggerCondition = {
      type: "call_count",
      call_count_threshold: 1,
    };

    const result = engine.shouldTrigger("Read", condition);
    expect(result.triggered).toBe(true);
  });

  // --- random_probability trigger ---

  test("random_probability is deterministic with same seed", () => {
    const engine1 = createTriggerEngine({ seed: 42 });
    const engine2 = createTriggerEngine({ seed: 42 });
    const condition: TriggerCondition = {
      type: "random_probability",
      probability: 0.5,
    };

    const results1: boolean[] = [];
    const results2: boolean[] = [];

    for (let i = 0; i < 20; i++) {
      results1.push(engine1.shouldTrigger("Read", condition).triggered);
      results2.push(engine2.shouldTrigger("Read", condition).triggered);
    }

    expect(results1).toEqual(results2);
  });

  test("random_probability differs with different seeds", () => {
    const engine1 = createTriggerEngine({ seed: 42 });
    const engine2 = createTriggerEngine({ seed: 99 });
    const condition: TriggerCondition = {
      type: "random_probability",
      probability: 0.5,
    };

    const results1: boolean[] = [];
    const results2: boolean[] = [];

    for (let i = 0; i < 50; i++) {
      results1.push(engine1.shouldTrigger("Read", condition).triggered);
      results2.push(engine2.shouldTrigger("Read", condition).triggered);
    }

    // With 50 samples at p=0.5, the chance they're all identical is astronomically low
    const allSame = results1.every((v, i) => v === results2[i]);
    expect(allSame).toBe(false);
  });

  test("probability 0 never triggers", () => {
    const engine = createTriggerEngine({ seed: 42 });
    const condition: TriggerCondition = {
      type: "random_probability",
      probability: 0,
    };

    for (let i = 0; i < 100; i++) {
      expect(engine.shouldTrigger("Read", condition).triggered).toBe(false);
    }
  });

  test("probability 1 always triggers", () => {
    const engine = createTriggerEngine({ seed: 42 });
    const condition: TriggerCondition = {
      type: "random_probability",
      probability: 1,
    };

    for (let i = 0; i < 100; i++) {
      expect(engine.shouldTrigger("Read", condition).triggered).toBe(true);
    }
  });

  // --- time_window trigger ---

  test("time_window triggers within window", () => {
    const engine = createTriggerEngine({ seed: 42, startTime: Date.now() - 5000 });
    const condition: TriggerCondition = {
      type: "time_window",
      time_window_start: 0,
      time_window_end: 30,
    };

    // 5 seconds elapsed, within 0-30 window
    const result = engine.shouldTrigger("Read", condition);
    expect(result.triggered).toBe(true);
  });

  test("time_window does not trigger outside window", () => {
    const engine = createTriggerEngine({ seed: 42, startTime: Date.now() - 60000 });
    const condition: TriggerCondition = {
      type: "time_window",
      time_window_start: 0,
      time_window_end: 30,
    };

    // 60 seconds elapsed, outside 0-30 window
    const result = engine.shouldTrigger("Read", condition);
    expect(result.triggered).toBe(false);
  });

  test("time_window with start > 0 waits before triggering", () => {
    const engine = createTriggerEngine({ seed: 42, startTime: Date.now() - 3000 });
    const condition: TriggerCondition = {
      type: "time_window",
      time_window_start: 10,
      time_window_end: 30,
    };

    // 3 seconds elapsed, before 10-30 window
    const result = engine.shouldTrigger("Read", condition);
    expect(result.triggered).toBe(false);
  });

  // --- State and stats ---

  test("getCallCount returns correct count per tool", () => {
    const engine = createTriggerEngine({ seed: 42 });
    const condition: TriggerCondition = {
      type: "call_count",
      call_count_threshold: 100, // High threshold so we just count
    };

    engine.shouldTrigger("Read", condition);
    engine.shouldTrigger("Read", condition);
    engine.shouldTrigger("Read", condition);
    engine.shouldTrigger("Bash", condition);

    expect(engine.getCallCount("Read")).toBe(3);
    expect(engine.getCallCount("Bash")).toBe(1);
    expect(engine.getCallCount("Write")).toBe(0);
  });

  test("getStats returns summary", () => {
    const engine = createTriggerEngine({ seed: 42 });
    const condition: TriggerCondition = {
      type: "call_count",
      call_count_threshold: 2,
    };

    engine.shouldTrigger("Read", condition);
    engine.shouldTrigger("Read", condition); // triggers

    const stats = engine.getStats();
    expect(stats.totalChecks).toBe(2);
    expect(stats.totalTriggered).toBe(1);
    expect(stats.callCounts["Read"]).toBe(2);
  });

  test("reset clears all state", () => {
    const engine = createTriggerEngine({ seed: 42 });
    const condition: TriggerCondition = {
      type: "call_count",
      call_count_threshold: 2,
    };

    engine.shouldTrigger("Read", condition);
    engine.shouldTrigger("Read", condition);
    engine.reset();

    expect(engine.getCallCount("Read")).toBe(0);
    expect(engine.getStats().totalChecks).toBe(0);
  });

  // --- Decision metadata ---

  test("decision includes trigger type and tool name", () => {
    const engine = createTriggerEngine({ seed: 42 });
    const condition: TriggerCondition = {
      type: "call_count",
      call_count_threshold: 1,
    };

    const decision = engine.shouldTrigger("Read", condition);
    expect(decision.toolName).toBe("Read");
    expect(decision.triggerType).toBe("call_count");
    expect(decision.triggered).toBe(true);
  });
});
