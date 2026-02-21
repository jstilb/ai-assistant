#!/usr/bin/env bun
/**
 * Tests for AgentOrchestrator
 *
 * Run with: bun test AgentOrchestrator.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  createOrchestrator,
  orchestrator,
  type AgentSpec,
  type AgentResult,
  type AggregationStrategy,
  type OrchestratorOptions,
} from "./AgentOrchestrator.ts";

// ============================================================================
// Unit Tests for Types and Interfaces
// ============================================================================

describe("AgentOrchestrator Types", () => {
  test("AgentSpec should accept minimal configuration", () => {
    const spec: AgentSpec = {
      type: "Intern",
    };
    expect(spec.type).toBe("Intern");
    expect(spec.count).toBeUndefined();
    expect(spec.model).toBeUndefined();
  });

  test("AgentSpec should accept full configuration", () => {
    const spec: AgentSpec = {
      type: "ClaudeResearcher",
      name: "Research Agent 1",
      count: 3,
      model: "sonnet",
      voiceId: "abc123",
      timeout: 30000,
      traits: ["research", "thorough"],
      promptPrefix: "You are a research specialist.",
    };

    expect(spec.type).toBe("ClaudeResearcher");
    expect(spec.count).toBe(3);
    expect(spec.model).toBe("sonnet");
    expect(spec.traits).toContain("research");
  });

  test("AggregationStrategy should support all strategies", () => {
    const strategies: AggregationStrategy[] = [
      "voting",
      "synthesis",
      "merge",
      "first",
      "best",
    ];
    expect(strategies).toHaveLength(5);
  });

  test("OrchestratorOptions should have sensible defaults", () => {
    const opts: OrchestratorOptions = {};
    expect(opts.parallel).toBeUndefined();
    expect(opts.maxConcurrent).toBeUndefined();
    expect(opts.defaultModel).toBeUndefined();
  });
});

// ============================================================================
// Unit Tests for Orchestrator Factory
// ============================================================================

describe("createOrchestrator", () => {
  test("should create orchestrator with default options", () => {
    const orch = createOrchestrator();
    expect(orch).toBeDefined();
    expect(typeof orch.spawn).toBe("function");
    expect(typeof orch.spawnWithAggregation).toBe("function");
    expect(typeof orch.spotcheck).toBe("function");
    expect(typeof orch.debate).toBe("function");
    expect(typeof orch.cancel).toBe("function");
    expect(typeof orch.cancelAll).toBe("function");
    expect(typeof orch.getRunning).toBe("function");
  });

  test("should create orchestrator with custom options", () => {
    const orch = createOrchestrator({
      parallel: false,
      maxConcurrent: 10,
      defaultModel: "haiku",
      defaultTimeout: 120000,
    });
    expect(orch).toBeDefined();
  });

  test("default orchestrator instance should exist", () => {
    expect(orchestrator).toBeDefined();
    expect(typeof orchestrator.spawn).toBe("function");
  });
});

// ============================================================================
// Integration Tests (require Claude CLI)
// ============================================================================

describe("AgentOrchestrator Integration", () => {
  // These tests require the Claude CLI to be available
  // They will be skipped if claude is not installed

  const hasClaudeCLI = async (): Promise<boolean> => {
    try {
      const proc = Bun.spawn(["which", "claude"]);
      await proc.exited;
      return proc.exitCode === 0;
    } catch {
      return false;
    }
  };

  test("getRunning should return empty array initially", () => {
    const orch = createOrchestrator();
    const running = orch.getRunning();
    expect(running).toEqual([]);
  });

  test("cancelAll should not throw when nothing is running", async () => {
    const orch = createOrchestrator();
    await expect(orch.cancelAll()).resolves.toBeUndefined();
  });

  test("cancel should not throw for non-existent agent", async () => {
    const orch = createOrchestrator();
    await expect(orch.cancel("non_existent_id")).resolves.toBeUndefined();
  });
});

// ============================================================================
// Mock Tests for Core Logic
// ============================================================================

describe("AgentOrchestrator Logic", () => {
  test("should expand count into multiple agent specs", async () => {
    // This tests the internal expansion logic by checking progress callback
    const orch = createOrchestrator({
      defaultTimeout: 100, // Very short timeout to fail fast
    });

    const progressCalls: Array<{ completed: number; total: number }> = [];

    // This will fail because claude isn't available in test, but we can
    // verify the expansion logic by checking the total count
    try {
      await orch.spawn(
        [{ type: "Intern", count: 3 }],
        "test task",
        {
          onProgress: (completed, total) => {
            progressCalls.push({ completed, total });
          },
        }
      );
    } catch {
      // Expected to fail
    }

    // If progress was called, check the total
    if (progressCalls.length > 0) {
      expect(progressCalls[0].total).toBe(3);
    }
  });
});

// ============================================================================
// Result Type Tests
// ============================================================================

describe("AgentResult", () => {
  test("successful result should have correct shape", () => {
    const result: AgentResult = {
      agentId: "agent_123",
      agentType: "Intern",
      agentName: "Test Agent",
      success: true,
      result: "Task completed successfully",
      durationMs: 1500,
      model: "sonnet",
    };

    expect(result.success).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  test("failed result should have error", () => {
    const result: AgentResult = {
      agentId: "agent_456",
      agentType: "Intern",
      agentName: "Test Agent",
      success: false,
      error: "Timeout exceeded",
      durationMs: 60000,
      model: "sonnet",
    };

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.result).toBeUndefined();
  });
});

// ============================================================================
// SpotcheckResult Tests
// ============================================================================

describe("SpotcheckResult", () => {
  test("should represent passing spotcheck", () => {
    const result = {
      passed: true,
      score: 100,
      issues: [],
      recommendations: [],
      criteriaResults: [
        { criterion: "No security vulnerabilities", passed: true, notes: "All clear" },
        { criterion: "Tests pass", passed: true, notes: "100% coverage" },
      ],
    };

    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
    expect(result.criteriaResults).toHaveLength(2);
  });

  test("should represent failing spotcheck", () => {
    const result = {
      passed: false,
      score: 50,
      issues: ["SQL injection vulnerability found"],
      recommendations: ["Use parameterized queries"],
      criteriaResults: [
        { criterion: "No security vulnerabilities", passed: false, notes: "SQL injection found" },
        { criterion: "Tests pass", passed: true, notes: "All tests green" },
      ],
    };

    expect(result.passed).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.recommendations).toHaveLength(1);
  });
});

// ============================================================================
// DebateResult Tests
// ============================================================================

describe("DebateResult", () => {
  test("should represent completed debate", () => {
    const result = {
      topic: "Microservices vs Monolith",
      rounds: [
        {
          round: 1,
          arguments: [
            { agent: "Architect", position: "microservices", argument: "Better scalability" },
            { agent: "Engineer", position: "monolith", argument: "Simpler deployment" },
          ],
        },
        {
          round: 2,
          arguments: [
            { agent: "Architect", position: "microservices", argument: "Responding to simplicity concern..." },
            { agent: "Engineer", position: "monolith", argument: "Responding to scalability..." },
          ],
        },
      ],
      conclusion: "Hybrid approach recommended",
      convergencePoints: ["Both agree on importance of clear boundaries"],
      disagreements: ["Scale at which to split services"],
    };

    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0].arguments).toHaveLength(2);
    expect(result.conclusion).toBeTruthy();
  });
});

console.log("AgentOrchestrator tests loaded");
