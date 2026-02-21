/**
 * StepDispatcher Tests - Verifies config-driven step type dispatching
 *
 * Tests all 6 step types defined in tiers.json:
 * - notification: sends voice notification
 * - skill: invokes a skill workflow via SkillInvoker
 * - internal: calls named internal function from registry
 * - parallel: spawns parallel agents via AgentOrchestrator
 * - conditional: evaluates condition, executes if true
 * - orchestrator: uses AgentOrchestrator for synthesis
 * - unknown: logs warning, returns skip result
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  StepDispatcher,
  createStepDispatcher,
  type TierStepConfig,
  type InternalFunctionRegistry,
  type ConditionRegistry,
} from "../StepDispatcher";

describe("StepDispatcher", () => {
  let dispatcher: StepDispatcher;
  let internalRegistry: InternalFunctionRegistry;
  let conditionRegistry: ConditionRegistry;
  let mockNotify: ReturnType<typeof mock>;
  let mockInvokeSkill: ReturnType<typeof mock>;
  let mockOrchestrator: { spawnWithAggregation: ReturnType<typeof mock> };

  beforeEach(() => {
    mockNotify = mock(() => {});
    mockInvokeSkill = mock(() =>
      Promise.resolve({ success: true, output: "skill output", durationMs: 100 })
    );
    mockOrchestrator = {
      spawnWithAggregation: mock(() =>
        Promise.resolve({
          results: [{ success: true, agentName: "test-agent" }],
          aggregated: "synthesized result",
        })
      ),
    };

    internalRegistry = new Map();
    internalRegistry.set("LightDriftCheck", async () => ({
      success: true,
      message: "3 stale files found",
      metrics: { staleFiles: 3 },
    }));
    internalRegistry.set("DailySynthesize", async () => ({
      success: true,
      message: "Daily synthesis complete",
      data: { insights: [], trends: [] },
    }));

    conditionRegistry = new Map();
    conditionRegistry.set("architectureChanged", async () => true);

    dispatcher = createStepDispatcher({
      notifyFn: mockNotify,
      invokeSkillFn: mockInvokeSkill,
      orchestrator: mockOrchestrator as any,
      internalRegistry,
      conditionRegistry,
    });
  });

  describe("notification step type", () => {
    it("should send notification and return success", async () => {
      const step: TierStepConfig = {
        name: "NotifyStart",
        type: "notification",
        message: "Starting daily autoinfo workflow",
      };

      const workflowStep = dispatcher.dispatch(step);
      expect(workflowStep.name).toBe("NotifyStart");

      const result = await workflowStep.execute();
      expect(result.success).toBe(true);
      expect(mockNotify).toHaveBeenCalledWith("Starting daily autoinfo workflow");
    });
  });

  describe("skill step type", () => {
    it("should invoke skill via SkillInvoker and return result", async () => {
      const step: TierStepConfig = {
        name: "ProcessScratchPad",
        type: "skill",
        skill: "InformationManager",
        workflow: "ProcessScratchPad",
        timeout: 120000,
      };

      const workflowStep = dispatcher.dispatch(step);
      const result = await workflowStep.execute();

      expect(result.success).toBe(true);
      expect(mockInvokeSkill).toHaveBeenCalledWith({
        skill: "InformationManager",
        args: "ProcessScratchPad",
        timeout: 120000,
      });
    });

    it("should handle skill failure", async () => {
      mockInvokeSkill.mockImplementation(() =>
        Promise.resolve({ success: false, error: "Skill not found", durationMs: 50 })
      );

      const step: TierStepConfig = {
        name: "BadSkill",
        type: "skill",
        skill: "NonExistent",
        workflow: "Missing",
      };

      const workflowStep = dispatcher.dispatch(step);
      const result = await workflowStep.execute();

      expect(result.success).toBe(false);
      expect(result.message).toContain("failed");
    });
  });

  describe("internal step type", () => {
    it("should call registered internal function", async () => {
      const step: TierStepConfig = {
        name: "LightDriftCheck",
        type: "internal",
        description: "Check for stale context files",
      };

      const workflowStep = dispatcher.dispatch(step);
      const result = await workflowStep.execute();

      expect(result.success).toBe(true);
      expect(result.metrics?.staleFiles).toBe(3);
    });

    it("should handle unregistered internal function gracefully", async () => {
      const step: TierStepConfig = {
        name: "UnknownInternal",
        type: "internal",
        description: "Not registered",
      };

      const workflowStep = dispatcher.dispatch(step);
      const result = await workflowStep.execute();

      expect(result.success).toBe(false);
      expect(result.message).toContain("not registered");
    });
  });

  describe("parallel step type", () => {
    it("should spawn parallel agents via orchestrator", async () => {
      const step: TierStepConfig = {
        name: "RefreshContext",
        type: "parallel",
        agents: [
          { type: "Intern", skill: "InformationManager", workflow: "RefreshAll" },
          { type: "Intern", skill: "InformationManager", workflow: "GatherGoogleDrive" },
        ],
      };

      const workflowStep = dispatcher.dispatch(step);
      expect(workflowStep.parallel).toBe(true);

      const result = await workflowStep.execute();
      expect(result.success).toBe(true);
      expect(mockOrchestrator.spawnWithAggregation).toHaveBeenCalled();
    });
  });

  describe("conditional step type", () => {
    it("should execute inner step when condition is true", async () => {
      conditionRegistry.set("architectureChanged", async () => true);

      const step: TierStepConfig = {
        name: "ArchitectureUpdate",
        type: "conditional",
        condition: "architectureChanged",
        skill: "SystemFlowchart",
        workflow: "Generate",
      };

      const workflowStep = dispatcher.dispatch(step);
      const result = await workflowStep.execute();

      expect(result.success).toBe(true);
      expect(mockInvokeSkill).toHaveBeenCalled();
    });

    it("should skip when condition is false", async () => {
      conditionRegistry.set("architectureChanged", async () => false);

      const step: TierStepConfig = {
        name: "ArchitectureUpdate",
        type: "conditional",
        condition: "architectureChanged",
        skill: "SystemFlowchart",
        workflow: "Generate",
      };

      const workflowStep = dispatcher.dispatch(step);
      const result = await workflowStep.execute();

      expect(result.success).toBe(true);
      expect(result.message).toContain("skipped");
      expect(mockInvokeSkill).not.toHaveBeenCalled();
    });

    it("should skip with warning for unknown condition", async () => {
      const step: TierStepConfig = {
        name: "ConditionalStep",
        type: "conditional",
        condition: "unknownCondition",
        skill: "SomeSkill",
        workflow: "SomeWorkflow",
      };

      const workflowStep = dispatcher.dispatch(step);
      const result = await workflowStep.execute();

      expect(result.success).toBe(true);
      expect(result.message).toContain("skipped");
    });
  });

  describe("orchestrator step type", () => {
    it("should use orchestrator for synthesis", async () => {
      const step: TierStepConfig = {
        name: "WeeklySynthesize",
        type: "orchestrator",
        strategy: "synthesis",
        description: "Generate weekly synthesis",
      };

      // For orchestrator steps referencing an internal function, register it
      internalRegistry.set("WeeklySynthesize", async () => ({
        success: true,
        message: "Weekly synthesis complete",
        data: { weeklyData: true },
      }));

      const workflowStep = dispatcher.dispatch(step);
      const result = await workflowStep.execute();

      expect(result.success).toBe(true);
    });
  });

  describe("unknown step type", () => {
    it("should warn and return skip result for unknown types", async () => {
      const step: TierStepConfig = {
        name: "WeirdStep",
        type: "unknown_type" as any,
      };

      const workflowStep = dispatcher.dispatch(step);
      const result = await workflowStep.execute();

      expect(result.success).toBe(true);
      expect(result.message).toContain("Unknown step type");
    });
  });

  describe("dispatchTier", () => {
    it("should convert all tier steps into WorkflowStep array", () => {
      const tierConfig: TierStepConfig[] = [
        { name: "NotifyStart", type: "notification", message: "Starting" },
        { name: "LightDriftCheck", type: "internal", description: "Drift check" },
        { name: "DailySynthesize", type: "internal", description: "Synthesis" },
      ];

      const steps = dispatcher.dispatchTier(tierConfig);
      expect(steps).toHaveLength(3);
      expect(steps[0].name).toBe("NotifyStart");
      expect(steps[1].name).toBe("LightDriftCheck");
      expect(steps[2].name).toBe("DailySynthesize");
    });

    it("should handle empty tier config", () => {
      const steps = dispatcher.dispatchTier([]);
      expect(steps).toHaveLength(0);
    });
  });
});
