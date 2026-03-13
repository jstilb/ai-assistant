import { describe, test, expect } from "bun:test";
import {
  routeCapability,
  routeMultiple,
  getHighestPriorityInvocation,
  CAPABILITY_MAP,
  DEFAULT_INVOCATION,
  RALPH_ITERATIONS,
  type EffortLevel,
} from "./CapabilityRouter.ts";

// ============================================================================
// routeCapability — direct capability name
// ============================================================================

describe("routeCapability — explicit capability name", () => {
  test("1. routes 'engineer' to Engineer agent, sonnet, task mode", () => {
    const result = routeCapability("Implement auth middleware", "STANDARD", "engineer");
    expect(result.invocation.subagent_type).toBe("Engineer");
    expect(result.invocation.model).toBe("sonnet");
    expect(result.invocation.executionMode).toBe("task");
  });

  test("2. routes 'architect' to Architect agent, opus model", () => {
    const result = routeCapability("System design task", "STANDARD", "architect");
    expect(result.invocation.subagent_type).toBe("Architect");
    expect(result.invocation.model).toBe("opus");
  });

  test("3. routes 'ralph_loop' to ralph_loop execution mode", () => {
    const result = routeCapability("Iterate until tests pass", "STANDARD", "ralph_loop");
    expect(result.invocation.executionMode).toBe("ralph_loop");
    expect(result.invocation.ralphConfig).toBeDefined();
    expect(result.invocation.ralphConfig!.maxIterations).toBe(RALPH_ITERATIONS["STANDARD"]);
  });

  test("4. routes 'perplexity' to ClaudeResearcher agent", () => {
    const result = routeCapability("Research best practices", "STANDARD", "perplexity");
    expect(result.invocation.subagent_type).toBe("ClaudeResearcher");
    expect(result.invocation.executionMode).toBe("task");
  });

  test("5. unknown capability name falls back to DEFAULT_INVOCATION", () => {
    const result = routeCapability("Some task", "STANDARD", "totally_unknown_cap");
    expect(result.invocation.subagent_type).toBe(DEFAULT_INVOCATION.subagent_type);
    expect(result.invocation.model).toBe(DEFAULT_INVOCATION.model);
  });

  test("6. returns correct row and effort in result", () => {
    const result = routeCapability("Build feature X", "THOROUGH", "engineer");
    expect(result.row).toBe("Build feature X");
    expect(result.effort).toBe("THOROUGH");
    expect(result.capabilityName).toBe("engineer");
  });
});

// ============================================================================
// routeCapability — TRIVIAL effort override
// ============================================================================

describe("routeCapability — TRIVIAL effort override", () => {
  test("7. TRIVIAL effort overrides executionMode to inline even for engineer", () => {
    const result = routeCapability("Simple fix", "TRIVIAL", "engineer");
    expect(result.invocation.executionMode).toBe("inline");
  });

  test("8. TRIVIAL effort overrides ralph_loop to inline", () => {
    const result = routeCapability("Tiny loop", "TRIVIAL", "ralph_loop");
    expect(result.invocation.executionMode).toBe("inline");
  });

  test("9. TRIVIAL effort appends override note to reasoning", () => {
    const result = routeCapability("Simple", "TRIVIAL", "engineer");
    expect(result.invocation.reasoning).toMatch(/TRIVIAL/);
  });
});

// ============================================================================
// routeCapability — keyword-based auto-routing
// ============================================================================

describe("routeCapability — keyword auto-routing (no explicit capability)", () => {
  test("10. 'implement' keyword routes to engineer", () => {
    const result = routeCapability("Implement the user model", "STANDARD");
    expect(result.capabilityName).toBe("engineer");
  });

  test("11. 'iterate until tests pass' routes to ralph_loop", () => {
    const result = routeCapability("iterate until tests pass", "STANDARD");
    expect(result.capabilityName).toBe("ralph_loop");
    expect(result.invocation.executionMode).toBe("ralph_loop");
  });

  test("12. 'web research' keywords routes to perplexity", () => {
    const result = routeCapability("Do web research for the best libraries", "STANDARD");
    expect(result.capabilityName).toBe("perplexity");
  });

  test("13. 'system design' routes to architect", () => {
    const result = routeCapability("Create system design for the platform", "STANDARD");
    expect(result.capabilityName).toBe("architect");
  });

  test("14. 'security' keyword routes to pentester", () => {
    const result = routeCapability("Check for security vulnerabilities", "STANDARD");
    expect(result.capabilityName).toBe("pentester");
  });

  test("15. unrecognized description falls back to DEFAULT_INVOCATION", () => {
    const result = routeCapability("do the thing with the stuff xyz-unrecognized-abc", "STANDARD");
    // No capability match — default
    expect(result.invocation.subagent_type).toBe(DEFAULT_INVOCATION.subagent_type);
  });
});

// ============================================================================
// RALPH_ITERATIONS
// ============================================================================

describe("RALPH_ITERATIONS", () => {
  test("16. TRIVIAL = 1 iteration", () => {
    expect(RALPH_ITERATIONS["TRIVIAL"]).toBe(1);
  });

  test("17. DETERMINED = 100 iterations", () => {
    expect(RALPH_ITERATIONS["DETERMINED"]).toBe(100);
  });

  test("18. ralph_loop ralphConfig.maxIterations matches effort level", () => {
    const efforts: EffortLevel[] = ["TRIVIAL", "QUICK", "STANDARD", "THOROUGH", "DETERMINED"];
    for (const effort of efforts) {
      const result = routeCapability("loop until done", effort, "ralph_loop");
      if (effort === "TRIVIAL") {
        // Overridden to inline — no ralphConfig
        expect(result.invocation.executionMode).toBe("inline");
      } else {
        expect(result.invocation.ralphConfig!.maxIterations).toBe(RALPH_ITERATIONS[effort]);
        expect(result.invocation.ralphConfig!.budgetLevel).toBe(effort);
      }
    }
  });
});

// ============================================================================
// routeMultiple
// ============================================================================

describe("routeMultiple", () => {
  test("19. routes an array of rows with correct count", () => {
    const rows = [
      { description: "Implement auth", capability: "engineer" },
      { description: "Research APIs", capability: "perplexity" },
      { description: "Design the system", capability: "architect" },
    ];
    const results = routeMultiple(rows, "STANDARD");
    expect(results.length).toBe(3);
  });

  test("20. each result matches its input description", () => {
    const rows = [
      { description: "Task A", capability: "engineer" },
      { description: "Task B", capability: "intern" },
    ];
    const results = routeMultiple(rows, "STANDARD");
    expect(results[0].row).toBe("Task A");
    expect(results[1].row).toBe("Task B");
  });

  test("21. empty array returns empty results", () => {
    const results = routeMultiple([], "STANDARD");
    expect(results).toEqual([]);
  });
});

// ============================================================================
// getHighestPriorityInvocation
// ============================================================================

describe("getHighestPriorityInvocation", () => {
  test("22. returns null for empty results array", () => {
    const result = getHighestPriorityInvocation([]);
    expect(result).toBeNull();
  });

  test("23. opus beats sonnet beats haiku", () => {
    const results = routeMultiple([
      { description: "simple task", capability: "intern" },    // haiku
      { description: "engineer task", capability: "engineer" }, // sonnet
      { description: "architect task", capability: "architect" }, // opus
    ], "STANDARD");
    const highest = getHighestPriorityInvocation(results);
    expect(highest).not.toBeNull();
    expect(highest!.model).toBe("opus");
  });

  test("24. single result returns that invocation", () => {
    const results = routeMultiple([{ description: "write code", capability: "engineer" }], "STANDARD");
    const highest = getHighestPriorityInvocation(results);
    expect(highest!.model).toBe("sonnet");
  });

  test("25. all same model returns first one found", () => {
    const results = routeMultiple([
      { description: "task a", capability: "engineer" },
      { description: "task b", capability: "qa_tester" },
    ], "STANDARD");
    // Both are sonnet
    const highest = getHighestPriorityInvocation(results);
    expect(highest!.model).toBe("sonnet");
  });
});

// ============================================================================
// CAPABILITY_MAP completeness
// ============================================================================

describe("CAPABILITY_MAP structure", () => {
  test("26. all entries have required fields", () => {
    for (const [name, spec] of Object.entries(CAPABILITY_MAP)) {
      expect(spec.subagent_type, `${name}.subagent_type`).toBeTruthy();
      expect(["sonnet", "opus", "haiku"], `${name}.model`).toContain(spec.model);
      expect(["task", "ralph_loop", "inline"], `${name}.executionMode`).toContain(spec.executionMode);
    }
  });

  test("27. ralph_loop entry uses ralph_loop executionMode", () => {
    expect(CAPABILITY_MAP["ralph_loop"].executionMode).toBe("ralph_loop");
  });
});
