#!/usr/bin/env bun
/**
 * ============================================================================
 * StepDispatcher.ts - Config-driven step type dispatcher for AutoInfoManager
 * ============================================================================
 *
 * PURPOSE:
 * Maps tiers.json step type definitions to executable WorkflowStep objects.
 * This replaces the hardcoded buildDailySteps/buildWeeklySteps/buildMonthlySteps
 * functions in AutoInfoRunner.ts with a config-driven dispatch model.
 *
 * STEP TYPES:
 *   - notification: Send voice notification via NotificationService
 *   - skill: Invoke skill workflow via SkillInvoker
 *   - internal: Call named function from internal registry
 *   - parallel: Spawn parallel agents via AgentOrchestrator
 *   - conditional: Evaluate condition, execute if true
 *   - orchestrator: Use AgentOrchestrator for synthesis aggregation
 *
 * Unknown step types log a warning and return a skip result (no crash).
 *
 * ============================================================================
 */

import type { WorkflowStep, StepResult } from "../../../../lib/core/WorkflowExecutor";

// ============================================================================
// Types
// ============================================================================

/**
 * Step configuration from tiers.json
 */
export interface TierStepConfig {
  name: string;
  type: "notification" | "skill" | "internal" | "parallel" | "conditional" | "orchestrator";
  /** For notification steps */
  message?: string;
  /** For skill/conditional steps */
  skill?: string;
  /** For skill/conditional steps */
  workflow?: string;
  /** Step timeout in ms */
  timeout?: number;
  /** Human-readable description */
  description?: string;
  /** For parallel steps: agent specs */
  agents?: Array<{ type: string; skill: string; workflow: string }>;
  /** For conditional steps: condition function name */
  condition?: string;
  /** For orchestrator steps: aggregation strategy */
  strategy?: string;
  /** Override default retry count (default varies by step type) */
  retry?: number;
  /** When true, step failure is logged as warning and returns success (non-blocking) */
  continueOnError?: boolean;
}

/**
 * Registry of internal functions that can be called by "internal" step type.
 * Maps step name -> implementation function.
 */
export type InternalFunctionRegistry = Map<string, () => Promise<StepResult>>;

/**
 * Registry of condition functions for "conditional" step type.
 * Maps condition name -> async boolean evaluator.
 */
export type ConditionRegistry = Map<string, () => Promise<boolean>>;

/**
 * Minimal interface for SkillInvoker to avoid tight coupling
 */
interface SkillInvokeFn {
  (options: { skill: string; args: string; timeout: number }): Promise<{
    success: boolean;
    output?: string;
    error?: string;
    durationMs: number;
  }>;
}

/**
 * Minimal interface for notification function
 */
type NotifyFn = (message: string) => void;

/**
 * Minimal AgentOrchestrator interface (only what we use)
 */
export interface OrchestratorLike {
  spawnWithAggregation(
    agents: Array<{ type: string; count?: number }>,
    task: string,
    strategy: string,
    options?: Record<string, unknown>
  ): Promise<{
    results: Array<{ success: boolean; agentName: string }>;
    aggregated: string;
  }>;
}

/**
 * Options for creating a StepDispatcher
 */
export interface StepDispatcherOptions {
  notifyFn: NotifyFn;
  invokeSkillFn: SkillInvokeFn;
  orchestrator: OrchestratorLike;
  internalRegistry: InternalFunctionRegistry;
  conditionRegistry: ConditionRegistry;
}

/**
 * StepDispatcher converts tiers.json step configs into executable WorkflowSteps
 */
export interface StepDispatcher {
  /** Convert a single step config into a WorkflowStep */
  dispatch(stepConfig: TierStepConfig): WorkflowStep;
  /** Convert all steps for a tier into WorkflowStep array */
  dispatchTier(steps: TierStepConfig[]): WorkflowStep[];
}

// ============================================================================
// Implementation
// ============================================================================

export function createStepDispatcher(options: StepDispatcherOptions): StepDispatcher {
  const { notifyFn, invokeSkillFn, orchestrator, internalRegistry, conditionRegistry } = options;

  function dispatchNotification(config: TierStepConfig): WorkflowStep {
    return {
      name: config.name,
      description: config.description || config.message || "Send notification",
      retry: 0,
      timeout: 10000,
      execute: async (): Promise<StepResult> => {
        try {
          notifyFn(config.message || config.name);
          return { success: true, message: "Notification sent" };
        } catch (error) {
          return {
            success: true, // Notification failure is non-critical
            message: `Notification failed (non-critical): ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    };
  }

  function dispatchSkill(config: TierStepConfig): WorkflowStep {
    const skill = config.skill || "";
    const workflow = config.workflow || "";
    const timeout = config.timeout || 180000;
    const continueOnError = config.continueOnError === true;

    return {
      name: config.name,
      description: config.description || `${skill}/${workflow}`,
      retry: config.retry ?? 1,
      retryDelayMs: 2000,
      timeout,
      execute: async (): Promise<StepResult> => {
        const result = await invokeSkillFn({
          skill,
          args: workflow,
          timeout,
        });

        if (result.success) {
          return {
            success: true,
            message: `${skill}/${workflow} completed`,
            data: { output: result.output?.slice(0, 1000) },
          };
        }

        // When continueOnError is set, convert failure to a logged warning
        if (continueOnError) {
          console.warn(`[StepDispatcher] ${skill}/${workflow} failed (non-blocking): ${result.error}`);
          return {
            success: true,
            message: `[non-blocking] ${skill}/${workflow} failed: ${result.error}`,
          };
        }

        return {
          success: false,
          message: `${skill}/${workflow} failed: ${result.error}`,
        };
      },
    };
  }

  function dispatchInternal(config: TierStepConfig): WorkflowStep {
    return {
      name: config.name,
      description: config.description || `Internal: ${config.name}`,
      retry: 1,
      retryDelayMs: 1000,
      timeout: config.timeout || 60000,
      execute: async (): Promise<StepResult> => {
        const fn = internalRegistry.get(config.name);
        if (!fn) {
          return {
            success: false,
            message: `Internal function "${config.name}" not registered in dispatcher`,
          };
        }
        return fn();
      },
    };
  }

  function dispatchParallel(config: TierStepConfig): WorkflowStep {
    return {
      name: config.name,
      description: config.description || `Parallel: ${config.agents?.length || 0} agents`,
      parallel: true,
      retry: 0,
      timeout: config.timeout || 180000,
      execute: async (): Promise<StepResult> => {
        try {
          const agents = (config.agents || []).map((a) => ({
            type: a.type,
            count: 1,
          }));
          const combinedTask = (config.agents || [])
            .map((a) => `[${a.type}]: Execute ${a.skill}/${a.workflow}`)
            .join("\n\n");

          const { results, aggregated } = await orchestrator.spawnWithAggregation(
            agents,
            combinedTask,
            "synthesis",
            { announceResults: false, defaultTimeout: 60000 }
          );

          const successCount = results.filter((r) => r.success).length;

          return {
            success: successCount > 0,
            message: `${successCount}/${results.length} agents completed`,
            data: { aggregated, results: results.map((r) => ({ agent: r.agentName, success: r.success })) },
            metrics: { agentsSucceeded: successCount, agentsFailed: results.length - successCount },
          };
        } catch (error) {
          return {
            success: false,
            message: `Orchestrator error: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    };
  }

  function dispatchConditional(config: TierStepConfig): WorkflowStep {
    return {
      name: config.name,
      description: config.description || `Conditional: ${config.condition}`,
      retry: 0,
      timeout: config.timeout || 180000,
      execute: async (): Promise<StepResult> => {
        const conditionName = config.condition || "";
        const conditionFn = conditionRegistry.get(conditionName);

        if (!conditionFn) {
          console.warn(`[StepDispatcher] Unknown condition "${conditionName}" for step "${config.name}" - skipping`);
          return {
            success: true,
            message: `Condition "${conditionName}" not registered - skipped`,
          };
        }

        const shouldExecute = await conditionFn();

        if (!shouldExecute) {
          return {
            success: true,
            message: `Condition "${conditionName}" is false - step skipped`,
          };
        }

        // Condition is true - execute as skill step
        if (config.skill && config.workflow) {
          const result = await invokeSkillFn({
            skill: config.skill,
            args: config.workflow,
            timeout: config.timeout || 180000,
          });

          return {
            success: result.success,
            message: result.success
              ? `${config.skill}/${config.workflow} completed (condition met)`
              : `${config.skill}/${config.workflow} failed: ${result.error}`,
            data: { output: result.output?.slice(0, 1000) },
          };
        }

        return {
          success: true,
          message: `Condition "${conditionName}" met but no skill configured`,
        };
      },
    };
  }

  function dispatchOrchestrator(config: TierStepConfig): WorkflowStep {
    return {
      name: config.name,
      description: config.description || `Orchestrator: ${config.strategy || "synthesis"}`,
      retry: 0,
      timeout: config.timeout || 180000,
      execute: async (): Promise<StepResult> => {
        // Orchestrator steps with an internal function registered use that
        const fn = internalRegistry.get(config.name);
        if (fn) {
          return fn();
        }

        // Otherwise, use the orchestrator directly for synthesis
        try {
          const { results, aggregated } = await orchestrator.spawnWithAggregation(
            [{ type: "Intern", count: 1 }],
            config.description || `Execute ${config.name}`,
            config.strategy || "synthesis",
            { announceResults: false }
          );

          const successCount = results.filter((r) => r.success).length;
          return {
            success: successCount > 0,
            message: `Orchestrator ${config.name}: ${successCount}/${results.length} succeeded`,
            data: { aggregated },
          };
        } catch (error) {
          return {
            success: false,
            message: `Orchestrator error: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    };
  }

  function dispatch(stepConfig: TierStepConfig): WorkflowStep {
    switch (stepConfig.type) {
      case "notification":
        return dispatchNotification(stepConfig);
      case "skill":
        return dispatchSkill(stepConfig);
      case "internal":
        return dispatchInternal(stepConfig);
      case "parallel":
        return dispatchParallel(stepConfig);
      case "conditional":
        return dispatchConditional(stepConfig);
      case "orchestrator":
        return dispatchOrchestrator(stepConfig);
      default:
        console.warn(`[StepDispatcher] Unknown step type "${stepConfig.type}" for step "${stepConfig.name}" - skipping`);
        return {
          name: stepConfig.name,
          description: `Unknown step type: ${stepConfig.type}`,
          execute: async (): Promise<StepResult> => ({
            success: true,
            message: `Unknown step type "${stepConfig.type}" - skipped`,
          }),
        };
    }
  }

  function dispatchTier(steps: TierStepConfig[]): WorkflowStep[] {
    return steps.map((step) => dispatch(step));
  }

  return { dispatch, dispatchTier };
}
