import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

/**
 * M2Integration.test.ts - Full M2 Pipeline Integration Tests
 *
 * Tests the complete M2 pipeline:
 * - Multi-agent config -> orchestration -> transcript -> replay -> diff
 * - Cascading faults within multi-agent scenarios
 * - Schema validation for multi-agent scenarios
 */

import {
  createMultiAgentConfig,
  validateMultiAgentConfig,
  MultiAgentOrchestrator,
} from "../MultiAgentRunner.ts";

import {
  createCascadePattern,
  validateCascadePattern,
  CascadingFaultEngine,
} from "../CascadingFaultEngine.ts";

import {
  loadJsonlTranscript,
  createReplaySession,
  diffTranscripts,
  filterTranscriptEvents,
  type JsonlTranscriptEvent,
} from "../ReplayEngine.ts";

import {
  validateMultiAgentScenario,
  extractMultiAgentConfig,
} from "../ScenarioEngineM2.ts";

const TEST_DIR = "/tmp/simulation-m2-integration-test";

describe("M2 Integration Tests", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("full pipeline: scenario -> multi-agent config -> dry run -> transcript -> replay", async () => {
    // Step 1: Define multi-agent scenario
    const scenarioConfig = {
      scenario: {
        id: "pipeline-001",
        name: "Pipeline Integration Test",
        description: "Full M2 pipeline test",
        type: "multi_agent" as const,
        target: { type: "agent" as const },
        environment: { sandbox: true },
        agents: [
          {
            agent_id: "reader",
            name: "Reader Agent",
            workload: "Read and validate files",
            fault_config: {
              tool: "Read",
              mode: "network_timeout" as const,
              trigger: "call_count" as const,
              call_count_threshold: 2,
            },
          },
          {
            agent_id: "processor",
            name: "Processor Agent",
            workload: "Process validated data",
            fault_config: {
              tool: "Bash",
              mode: "rate_limit" as const,
              trigger: "random_probability" as const,
              probability: 0.3,
            },
            depends_on: ["reader"],
          },
        ],
        coordination: {
          max_parallel: 1,
          start_order: "sequential" as const,
        },
        execution: { runs: 1, timeout_ms: 60000 },
      },
    };

    // Step 2: Validate scenario
    const scenarioValidation = validateMultiAgentScenario(scenarioConfig);
    expect(scenarioValidation.valid).toBe(true);

    // Step 3: Extract multi-agent config
    const multiConfig = extractMultiAgentConfig(scenarioConfig);
    expect(multiConfig.simulation_id).toBe("pipeline-001");
    expect(multiConfig.agents).toHaveLength(2);

    // Step 4: Create orchestrator and dry run
    const fullConfig = createMultiAgentConfig(multiConfig);
    const orchestrator = new MultiAgentOrchestrator(fullConfig, TEST_DIR);
    const dryResult = await orchestrator.runDryMode();

    expect(dryResult.simulation_id).toBe("pipeline-001");
    expect(dryResult.agents).toHaveLength(2);
    expect(dryResult.status).toBe("completed");

    // Step 5: Write mock transcript for replay testing
    const transcriptPath = join(TEST_DIR, "pipeline-001.jsonl");
    const transcriptEvents: JsonlTranscriptEvent[] = [
      {
        timestamp: "2026-02-09T12:00:00Z",
        agent_id: "reader",
        tool_name: "Read",
        trigger_condition: "call_count",
        fault_type: "none",
        fault_params: {},
        outcome: "pass_through",
      },
      {
        timestamp: "2026-02-09T12:00:05Z",
        agent_id: "reader",
        tool_name: "Read",
        trigger_condition: "call_count",
        fault_type: "network_timeout",
        fault_params: { call_count_threshold: 2 },
        outcome: "fault_injected",
      },
      {
        timestamp: "2026-02-09T12:00:10Z",
        agent_id: "processor",
        tool_name: "Bash",
        trigger_condition: "random_probability",
        fault_type: "rate_limit",
        fault_params: { probability: 0.3 },
        outcome: "fault_injected",
      },
    ];

    writeFileSync(transcriptPath, transcriptEvents.map(e => JSON.stringify(e)).join("\n") + "\n");

    // Step 6: Load transcript and create replay session
    const loaded = loadJsonlTranscript(transcriptPath);
    expect(loaded).toHaveLength(3);

    const session = createReplaySession(loaded);
    expect(session.totalEvents).toBe(3);

    // Step through events
    const step1 = session.step()!;
    expect(step1.agent_id).toBe("reader");
    expect(step1.outcome).toBe("pass_through");

    const step2 = session.step()!;
    expect(step2.fault_type).toBe("network_timeout");

    // Step 7: Filter by agent
    const readerEvents = filterTranscriptEvents(loaded, { agent_id: "reader" });
    expect(readerEvents).toHaveLength(2);

    const faultEvents = filterTranscriptEvents(loaded, { fault_type: "network_timeout" });
    expect(faultEvents).toHaveLength(1);
  });

  test("cascading faults with multi-agent scenario", async () => {
    // Create a cascade pattern
    const cascade = createCascadePattern({
      name: "timeout-then-unavailable",
      steps: [
        { fault_type: "network_timeout", trigger_after: "immediate", parameters: { delay_ms: 50 } },
        { fault_type: "tool_unavailable", trigger_after: "on_retry", parameters: {} },
      ],
      recovery_check: true,
    });

    expect(validateCascadePattern(cascade).valid).toBe(true);

    // Execute cascade
    const engine = new CascadingFaultEngine();
    const cascadeResult = await engine.execute(cascade);

    expect(cascadeResult.completed).toBe(true);
    expect(cascadeResult.steps_executed).toBeGreaterThanOrEqual(1);

    // Verify the cascade can work alongside a multi-agent config
    const config = createMultiAgentConfig({
      simulation_id: "cascade-multi-001",
      agents: [
        {
          agent_id: "target",
          name: "Target Agent",
          workload: "Handle cascading faults",
          fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count", call_count_threshold: 1 },
        },
      ],
    });

    const validation = validateMultiAgentConfig(config);
    expect(validation.valid).toBe(true);
  });

  test("transcript diff between two multi-agent runs", () => {
    // Simulate two different runs
    const runA: JsonlTranscriptEvent[] = [
      { timestamp: "2026-02-09T12:00:00Z", agent_id: "a", tool_name: "Read", trigger_condition: "call_count", fault_type: "none", fault_params: {}, outcome: "pass_through" },
      { timestamp: "2026-02-09T12:00:05Z", agent_id: "b", tool_name: "Bash", trigger_condition: "random", fault_type: "rate_limit", fault_params: {}, outcome: "fault_injected" },
    ];

    const runB: JsonlTranscriptEvent[] = [
      { timestamp: "2026-02-09T12:00:00Z", agent_id: "a", tool_name: "Read", trigger_condition: "call_count", fault_type: "none", fault_params: {}, outcome: "pass_through" },
      { timestamp: "2026-02-09T12:00:05Z", agent_id: "b", tool_name: "Bash", trigger_condition: "random", fault_type: "none", fault_params: {}, outcome: "pass_through" },
      { timestamp: "2026-02-09T12:00:10Z", agent_id: "c", tool_name: "Edit", trigger_condition: "time", fault_type: "none", fault_params: {}, outcome: "pass_through" },
    ];

    const diff = diffTranscripts(runA, runB);
    expect(diff.identical).toBe(false);
    // runB has different outcome for event 2 + one extra event
    expect(diff.summary.changed + diff.summary.added).toBeGreaterThan(0);
  });

  test("multi-agent schema validation rejects non-multi-agent type with agents", () => {
    const config = {
      scenario: {
        id: "type-mismatch",
        name: "Type Mismatch",
        description: "chaos type with agents",
        type: "chaos",
        target: { type: "workflow" },
        environment: { sandbox: true },
        agents: [
          { agent_id: "a", name: "A", workload: "test", fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" } },
        ],
        execution: { runs: 1, timeout_ms: 60000 },
      },
    };

    // Non-multi_agent type scenarios should still validate if they don't need the multi-agent fields
    const result = validateMultiAgentScenario(config as any);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("type") || e.includes("multi_agent"))).toBe(true);
  });
});
