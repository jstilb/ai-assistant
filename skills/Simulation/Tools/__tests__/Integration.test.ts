import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, unlinkSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { validateScenarioConfig, type ScenarioConfig } from "../ConfigValidator.ts";
import { createTriggerEngine, type TriggerCondition } from "../TriggerEngine.ts";
import { createTranscriptLogger, type TranscriptEvent } from "../TranscriptLogger.ts";
import { generateMarkdownReport, type SimulationResult } from "../ReportGenerator.ts";
import { isAllowedWritePath } from "../PathWhitelist.ts";

// ============================================
// Integration Test: End-to-End Single Scenario
// Validates all components working together
// ============================================

const TEST_DIR = "/tmp/simulation-integration-test";
const TRANSCRIPT_FILE = join(TEST_DIR, "integration-transcript.jsonl");

describe("Integration: End-to-End Single Scenario", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    if (existsSync(TRANSCRIPT_FILE)) unlinkSync(TRANSCRIPT_FILE);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("full scenario lifecycle: validate -> trigger -> log -> report", () => {
    // Step 1: Validate scenario config
    const config: ScenarioConfig = {
      scenario: {
        id: "integration-001",
        name: "Integration Test Scenario",
        description: "Tests all components together",
        type: "chaos",
        target: { type: "workflow", skill: "Browser" },
        environment: { sandbox: true },
        faults: [
          {
            tool: "Read",
            mode: "network_timeout",
            trigger: "call_count",
            call_count_threshold: 2,
          },
          {
            tool: "Bash",
            mode: "tool_unavailable",
            trigger: "random_probability",
            probability: 0.3,
          },
        ],
        invariants: [
          { name: "sandbox_isolation", assert: "no_writes_outside_sandbox" },
        ],
        execution: { runs: 3, timeout_ms: 60000, seed: 42 },
      },
    };

    const validation = validateScenarioConfig(config);
    expect(validation.success).toBe(true);

    // Step 2: Create trigger engine and process faults
    const engine = createTriggerEngine({ seed: 42 });
    const logger = createTranscriptLogger(TRANSCRIPT_FILE);

    const readCondition: TriggerCondition = {
      type: "call_count",
      call_count_threshold: 2,
    };

    const bashCondition: TriggerCondition = {
      type: "random_probability",
      probability: 0.3,
    };

    // Simulate 5 tool calls
    const faultEvents: TranscriptEvent[] = [];
    let faultCount = 0;

    for (let i = 0; i < 5; i++) {
      // Check Read
      const readDecision = engine.shouldTrigger("Read", readCondition);
      logger.log({
        timestamp: new Date().toISOString(),
        agent_id: "integration-001-run0",
        tool_name: "Read",
        trigger_condition: "call_count",
        fault_type: readDecision.triggered ? "network_timeout" : "none",
        fault_params: { call_count_threshold: 2 },
        outcome: readDecision.triggered ? "fault_injected" : "pass_through",
      });
      if (readDecision.triggered) faultCount++;

      // Check Bash
      const bashDecision = engine.shouldTrigger("Bash", bashCondition);
      logger.log({
        timestamp: new Date().toISOString(),
        agent_id: "integration-001-run0",
        tool_name: "Bash",
        trigger_condition: "random_probability",
        fault_type: bashDecision.triggered ? "tool_unavailable" : "none",
        fault_params: { probability: 0.3 },
        outcome: bashDecision.triggered ? "fault_injected" : "pass_through",
      });
      if (bashDecision.triggered) faultCount++;
    }

    // Step 3: Verify transcript was written correctly
    expect(logger.getEventCount()).toBe(10); // 5 iterations * 2 tools
    const events = logger.readAll();
    expect(events.length).toBe(10);
    expect(events.every(e => e.agent_id === "integration-001-run0")).toBe(true);

    // Step 4: Verify path whitelist
    const simDir = `${process.env.HOME}/.claude/skills/Simulation`;
    expect(isAllowedWritePath(`${simDir}/Reports/integration-001.md`)).toBe(true);
    expect(isAllowedWritePath(`${simDir}/Transcripts/log.jsonl`)).toBe(true);
    expect(isAllowedWritePath(`${simDir}/Tools/evil.ts`)).toBe(false);

    // Step 5: Generate report from simulated results
    const simulationResult: SimulationResult = {
      scenarioId: "integration-001",
      scenarioName: "Integration Test Scenario",
      scenarioType: "chaos",
      totalRuns: 3,
      passed: 2,
      failed: 1,
      errors: 0,
      passRate: 0.667,
      startedAt: "2026-02-09T12:00:00Z",
      completedAt: "2026-02-09T12:03:00Z",
      totalDuration_ms: 180000,
      runs: [
        {
          runIndex: 0,
          seed: 42,
          status: "pass",
          duration_ms: 55000,
          faultsInjected: faultCount,
          invariantResults: [{ name: "sandbox_isolation", passed: true }],
        },
        {
          runIndex: 1,
          seed: 43,
          status: "pass",
          duration_ms: 60000,
          faultsInjected: 1,
          invariantResults: [{ name: "sandbox_isolation", passed: true }],
        },
        {
          runIndex: 2,
          seed: 44,
          status: "fail",
          duration_ms: 65000,
          faultsInjected: 2,
          invariantResults: [{ name: "sandbox_isolation", passed: false, details: "Write escaped sandbox" }],
          error: "Isolation violation",
        },
      ],
      transcriptPath: TRANSCRIPT_FILE,
    };

    const report = generateMarkdownReport(simulationResult);

    // Verify report correctness
    expect(report).toContain("## 1. Executive Summary");
    expect(report).toContain("## 2. Fault Injection Timeline");
    expect(report).toContain("## 3. Agent Performance");
    expect(report).toContain("## 4. Recommendations");
    expect(report).toContain("## 5. Artifacts");
    expect(report).toContain("integration-001");
    expect(report).toContain("67%"); // passRate
    expect(report).toContain("Isolation violation");
  });

  test("trigger engine determinism across full scenario", () => {
    const config: ScenarioConfig = {
      scenario: {
        id: "determinism-test",
        name: "Determinism Test",
        description: "Verifies deterministic behavior",
        type: "property",
        target: { type: "workflow" },
        environment: { sandbox: true },
        faults: [
          { tool: "Read", mode: "network_timeout", trigger: "random_probability", probability: 0.4 },
        ],
        execution: { runs: 20, timeout_ms: 30000, seed: 99 },
      },
    };

    expect(validateScenarioConfig(config).success).toBe(true);

    // Run twice with same seed
    const results1: boolean[] = [];
    const results2: boolean[] = [];

    const engine1 = createTriggerEngine({ seed: 99 });
    const engine2 = createTriggerEngine({ seed: 99 });

    const condition: TriggerCondition = {
      type: "random_probability",
      probability: 0.4,
    };

    for (let i = 0; i < 20; i++) {
      results1.push(engine1.shouldTrigger("Read", condition).triggered);
      results2.push(engine2.shouldTrigger("Read", condition).triggered);
    }

    expect(results1).toEqual(results2);
  });
});
