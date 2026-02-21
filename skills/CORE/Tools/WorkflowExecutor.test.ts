#!/usr/bin/env bun
/**
 * WorkflowExecutor Tests - TDD first
 *
 * Tests for unified workflow execution with:
 * - Step sequencing with dependencies
 * - Parallel execution
 * - Retry/error handling
 * - Progress callbacks
 * - ISC integration
 * - Checkpointing
 * - Notifications
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { join } from "path";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";

// Import types and functions we'll implement
import {
  createWorkflowExecutor,
  workflowExecutor,
  createTieredWorkflow,
  type WorkflowStep,
  type StepResult,
  type WorkflowConfig,
  type WorkflowResult,
  type ISCSpec,
  type ISCCheckResult,
} from "./WorkflowExecutor";

const TEST_DIR = "/tmp/workflow-executor-tests";
const TEST_CHECKPOINT_FILE = join(TEST_DIR, "test-checkpoint.json");

// Helper to create test steps
function createTestStep(
  name: string,
  options: Partial<WorkflowStep> = {}
): WorkflowStep {
  return {
    name,
    description: options.description ?? `Test step: ${name}`,
    execute: options.execute ?? (async () => ({ success: true, message: `${name} completed` })),
    retry: options.retry,
    retryDelayMs: options.retryDelayMs,
    timeout: options.timeout,
    dependsOn: options.dependsOn,
    parallel: options.parallel,
    skip: options.skip,
    onError: options.onError,
  };
}

describe("WorkflowExecutor", () => {
  beforeEach(() => {
    // Create test directory
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("Basic Execution", () => {
    test("executes a single step workflow", async () => {
      const executor = createWorkflowExecutor();
      const config: WorkflowConfig = {
        name: "SingleStepWorkflow",
        steps: [createTestStep("step1")],
      };

      const result = await executor.execute(config);

      expect(result.success).toBe(true);
      expect(result.stepResults.has("step1")).toBe(true);
      expect(result.stepResults.get("step1")?.success).toBe(true);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.startedAt).toBeDefined();
      expect(result.completedAt).toBeDefined();
    });

    test("executes multiple steps in sequence", async () => {
      const executor = createWorkflowExecutor();
      const executionOrder: string[] = [];

      const config: WorkflowConfig = {
        name: "SequentialWorkflow",
        steps: [
          createTestStep("step1", {
            execute: async () => {
              executionOrder.push("step1");
              return { success: true };
            },
          }),
          createTestStep("step2", {
            execute: async () => {
              executionOrder.push("step2");
              return { success: true };
            },
          }),
          createTestStep("step3", {
            execute: async () => {
              executionOrder.push("step3");
              return { success: true };
            },
          }),
        ],
      };

      const result = await executor.execute(config);

      expect(result.success).toBe(true);
      expect(executionOrder).toEqual(["step1", "step2", "step3"]);
    });

    test("handles step failure", async () => {
      const executor = createWorkflowExecutor();
      const config: WorkflowConfig = {
        name: "FailingWorkflow",
        steps: [
          createTestStep("step1"),
          createTestStep("step2", {
            dependsOn: ["step1"],
            execute: async () => ({ success: false, message: "Step 2 failed" }),
          }),
          createTestStep("step3", {
            dependsOn: ["step2"],
          }),
        ],
      };

      const result = await executor.execute(config);

      expect(result.success).toBe(false);
      expect(result.failedStep).toBe("step2");
      expect(result.stepResults.get("step1")?.success).toBe(true);
      expect(result.stepResults.get("step2")?.success).toBe(false);
      // Step 3 should not have been executed because step2 failed
      expect(result.stepResults.has("step3")).toBe(false);
    });

    test("handles step throwing error", async () => {
      const executor = createWorkflowExecutor();
      const config: WorkflowConfig = {
        name: "ThrowingWorkflow",
        steps: [
          createTestStep("step1", {
            execute: async () => {
              throw new Error("Unexpected error");
            },
          }),
        ],
      };

      const result = await executor.execute(config);

      expect(result.success).toBe(false);
      expect(result.failedStep).toBe("step1");
      expect(result.error).toContain("Unexpected error");
    });
  });

  describe("Step Dependencies", () => {
    test("respects dependsOn ordering", async () => {
      const executor = createWorkflowExecutor();
      const executionOrder: string[] = [];

      const config: WorkflowConfig = {
        name: "DependencyWorkflow",
        steps: [
          createTestStep("step3", {
            dependsOn: ["step1", "step2"],
            execute: async () => {
              executionOrder.push("step3");
              return { success: true };
            },
          }),
          createTestStep("step1", {
            execute: async () => {
              executionOrder.push("step1");
              return { success: true };
            },
          }),
          createTestStep("step2", {
            dependsOn: ["step1"],
            execute: async () => {
              executionOrder.push("step2");
              return { success: true };
            },
          }),
        ],
      };

      const result = await executor.execute(config);

      expect(result.success).toBe(true);
      // step1 must come first, step2 after step1, step3 after both
      expect(executionOrder.indexOf("step1")).toBeLessThan(executionOrder.indexOf("step2"));
      expect(executionOrder.indexOf("step1")).toBeLessThan(executionOrder.indexOf("step3"));
      expect(executionOrder.indexOf("step2")).toBeLessThan(executionOrder.indexOf("step3"));
    });

    test("fails if dependency not found", async () => {
      const executor = createWorkflowExecutor();
      const config: WorkflowConfig = {
        name: "MissingDependencyWorkflow",
        steps: [
          createTestStep("step1", {
            dependsOn: ["nonexistent"],
          }),
        ],
      };

      const validation = executor.validate(config);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("Step 'step1' depends on unknown step 'nonexistent'");
    });

    test("detects circular dependencies", async () => {
      const executor = createWorkflowExecutor();
      const config: WorkflowConfig = {
        name: "CircularDependencyWorkflow",
        steps: [
          createTestStep("step1", { dependsOn: ["step2"] }),
          createTestStep("step2", { dependsOn: ["step1"] }),
        ],
      };

      const validation = executor.validate(config);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some(e => e.includes("circular"))).toBe(true);
    });
  });

  describe("Parallel Execution", () => {
    test("runs parallel steps concurrently", async () => {
      const executor = createWorkflowExecutor();
      const startTimes: Record<string, number> = {};
      const endTimes: Record<string, number> = {};

      const config: WorkflowConfig = {
        name: "ParallelWorkflow",
        maxParallel: 3,
        steps: [
          createTestStep("step1", {
            parallel: true,
            execute: async () => {
              startTimes.step1 = Date.now();
              await Bun.sleep(50);
              endTimes.step1 = Date.now();
              return { success: true };
            },
          }),
          createTestStep("step2", {
            parallel: true,
            execute: async () => {
              startTimes.step2 = Date.now();
              await Bun.sleep(50);
              endTimes.step2 = Date.now();
              return { success: true };
            },
          }),
          createTestStep("step3", {
            parallel: true,
            execute: async () => {
              startTimes.step3 = Date.now();
              await Bun.sleep(50);
              endTimes.step3 = Date.now();
              return { success: true };
            },
          }),
        ],
      };

      const result = await executor.execute(config);

      expect(result.success).toBe(true);
      // All steps should have started within ~10ms of each other (concurrent)
      const startDiffs = [
        Math.abs(startTimes.step1 - startTimes.step2),
        Math.abs(startTimes.step2 - startTimes.step3),
        Math.abs(startTimes.step1 - startTimes.step3),
      ];
      expect(Math.max(...startDiffs)).toBeLessThan(30);
    });

    test("respects maxParallel limit", async () => {
      const executor = createWorkflowExecutor();
      let concurrentCount = 0;
      let maxConcurrent = 0;

      const createCountingStep = (name: string): WorkflowStep =>
        createTestStep(name, {
          parallel: true,
          execute: async () => {
            concurrentCount++;
            maxConcurrent = Math.max(maxConcurrent, concurrentCount);
            await Bun.sleep(30);
            concurrentCount--;
            return { success: true };
          },
        });

      const config: WorkflowConfig = {
        name: "LimitedParallelWorkflow",
        maxParallel: 2,
        steps: [
          createCountingStep("step1"),
          createCountingStep("step2"),
          createCountingStep("step3"),
          createCountingStep("step4"),
        ],
      };

      await executor.execute(config);

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    test("runs non-parallel steps sequentially even without dependencies", async () => {
      const executor = createWorkflowExecutor();
      const executionOrder: string[] = [];

      const config: WorkflowConfig = {
        name: "SequentialNonParallel",
        steps: [
          createTestStep("step1", {
            parallel: false,
            execute: async () => {
              executionOrder.push("step1-start");
              await Bun.sleep(20);
              executionOrder.push("step1-end");
              return { success: true };
            },
          }),
          createTestStep("step2", {
            parallel: false,
            execute: async () => {
              executionOrder.push("step2-start");
              await Bun.sleep(20);
              executionOrder.push("step2-end");
              return { success: true };
            },
          }),
        ],
      };

      await executor.execute(config);

      // Sequential: step1-end should come before step2-start
      expect(executionOrder).toEqual(["step1-start", "step1-end", "step2-start", "step2-end"]);
    });
  });

  describe("Retry Handling", () => {
    test("retries failed steps", async () => {
      const executor = createWorkflowExecutor();
      let attempts = 0;

      const config: WorkflowConfig = {
        name: "RetryWorkflow",
        steps: [
          createTestStep("flaky", {
            retry: 3,
            retryDelayMs: 10,
            execute: async () => {
              attempts++;
              if (attempts < 3) {
                return { success: false, message: "Not yet" };
              }
              return { success: true, message: "Finally!" };
            },
          }),
        ],
      };

      const result = await executor.execute(config);

      expect(result.success).toBe(true);
      expect(attempts).toBe(3);
    });

    test("fails after exhausting retries", async () => {
      const executor = createWorkflowExecutor();
      let attempts = 0;

      const config: WorkflowConfig = {
        name: "ExhaustedRetryWorkflow",
        steps: [
          createTestStep("always-fails", {
            retry: 2,
            retryDelayMs: 10,
            execute: async () => {
              attempts++;
              return { success: false, message: "Always fails" };
            },
          }),
        ],
      };

      const result = await executor.execute(config);

      expect(result.success).toBe(false);
      expect(attempts).toBe(3); // Initial + 2 retries
    });

    test("calls onError callback on failure", async () => {
      const executor = createWorkflowExecutor();
      let errorCalled = false;
      let errorMessage = "";

      const config: WorkflowConfig = {
        name: "OnErrorWorkflow",
        steps: [
          createTestStep("fails", {
            execute: async () => {
              throw new Error("Test error");
            },
            onError: async (error) => {
              errorCalled = true;
              errorMessage = error.message;
            },
          }),
        ],
      };

      await executor.execute(config);

      expect(errorCalled).toBe(true);
      expect(errorMessage).toBe("Test error");
    });
  });

  describe("Step Timeout", () => {
    test("times out slow steps", async () => {
      const executor = createWorkflowExecutor();

      const config: WorkflowConfig = {
        name: "TimeoutWorkflow",
        steps: [
          createTestStep("slow", {
            timeout: 50,
            execute: async () => {
              await Bun.sleep(200);
              return { success: true };
            },
          }),
        ],
      };

      const result = await executor.execute(config);

      expect(result.success).toBe(false);
      expect(result.error?.toLowerCase()).toContain("timed out");
    });

    test("uses workflow-level timeout as fallback", async () => {
      const executor = createWorkflowExecutor();

      const config: WorkflowConfig = {
        name: "WorkflowTimeoutFallback",
        timeout: 50,
        steps: [
          createTestStep("slow", {
            // No step-level timeout, uses workflow timeout
            execute: async () => {
              await Bun.sleep(200);
              return { success: true };
            },
          }),
        ],
      };

      const result = await executor.execute(config);

      expect(result.success).toBe(false);
      expect(result.error?.toLowerCase()).toContain("timed out");
    });
  });

  describe("Skip Condition", () => {
    test("skips step when skip returns true", async () => {
      const executor = createWorkflowExecutor();
      let step2Executed = false;

      const config: WorkflowConfig = {
        name: "SkipWorkflow",
        steps: [
          createTestStep("step1"),
          createTestStep("step2", {
            skip: () => true,
            execute: async () => {
              step2Executed = true;
              return { success: true };
            },
          }),
          createTestStep("step3"),
        ],
      };

      const result = await executor.execute(config);

      expect(result.success).toBe(true);
      expect(step2Executed).toBe(false);
      expect(result.stepResults.has("step2")).toBe(false);
    });

    test("supports async skip condition", async () => {
      const executor = createWorkflowExecutor();

      const config: WorkflowConfig = {
        name: "AsyncSkipWorkflow",
        steps: [
          createTestStep("step1", {
            skip: async () => {
              await Bun.sleep(10);
              return true;
            },
          }),
        ],
      };

      const result = await executor.execute(config);

      expect(result.success).toBe(true);
      expect(result.stepResults.has("step1")).toBe(false);
    });
  });

  describe("Progress Callbacks", () => {
    test("calls progress callback for each step", async () => {
      const executor = createWorkflowExecutor();
      const progressEvents: Array<{ step: string; status: string }> = [];

      const config: WorkflowConfig = {
        name: "ProgressWorkflow",
        steps: [
          createTestStep("step1"),
          createTestStep("step2"),
        ],
      };

      await executor.executeWithProgress(config, (step, status) => {
        progressEvents.push({ step, status });
      });

      expect(progressEvents).toContainEqual({ step: "step1", status: "started" });
      expect(progressEvents).toContainEqual({ step: "step1", status: "completed" });
      expect(progressEvents).toContainEqual({ step: "step2", status: "started" });
      expect(progressEvents).toContainEqual({ step: "step2", status: "completed" });
    });

    test("reports failed status on step failure", async () => {
      const executor = createWorkflowExecutor();
      const progressEvents: Array<{ step: string; status: string }> = [];

      const config: WorkflowConfig = {
        name: "FailProgressWorkflow",
        steps: [
          createTestStep("fails", {
            execute: async () => ({ success: false }),
          }),
        ],
      };

      await executor.executeWithProgress(config, (step, status) => {
        progressEvents.push({ step, status });
      });

      expect(progressEvents).toContainEqual({ step: "fails", status: "started" });
      expect(progressEvents).toContainEqual({ step: "fails", status: "failed" });
    });
  });

  describe("ISC Integration", () => {
    test("evaluates ISC criteria after execution", async () => {
      const executor = createWorkflowExecutor();

      const config: WorkflowConfig = {
        name: "ISCWorkflow",
        steps: [
          createTestStep("step1", {
            execute: async () => ({ success: true, metrics: { items: 5 } }),
          }),
          createTestStep("step2", {
            execute: async () => ({ success: true, metrics: { errors: 0 } }),
          }),
        ],
        isc: {
          criteria: ["All steps pass", "No errors"],
          checkFn: (results) => {
            const step1 = results.get("step1");
            const step2 = results.get("step2");
            const allPassed = step1?.success && step2?.success;
            const noErrors = (step2?.metrics as any)?.errors === 0;

            return {
              met: allPassed && noErrors,
              score: allPassed && noErrors ? 100 : 50,
              unmetCriteria: allPassed && noErrors ? [] : ["Some criteria unmet"],
            };
          },
        },
      };

      const result = await executor.execute(config);

      expect(result.success).toBe(true);
      expect(result.iscResult).toBeDefined();
      expect(result.iscResult?.met).toBe(true);
      expect(result.iscResult?.score).toBe(100);
    });

    test("reports unmet ISC criteria", async () => {
      const executor = createWorkflowExecutor();

      const config: WorkflowConfig = {
        name: "UnmetISCWorkflow",
        steps: [
          createTestStep("step1", {
            execute: async () => ({ success: true, metrics: { errors: 5 } }),
          }),
        ],
        isc: {
          criteria: ["No errors"],
          checkFn: (results) => {
            const errors = (results.get("step1")?.metrics as any)?.errors ?? 0;
            return {
              met: errors === 0,
              score: errors === 0 ? 100 : 0,
              unmetCriteria: errors > 0 ? ["No errors"] : [],
            };
          },
        },
      };

      const result = await executor.execute(config);

      expect(result.iscResult?.met).toBe(false);
      expect(result.iscResult?.unmetCriteria).toContain("No errors");
    });
  });

  describe("Checkpointing", () => {
    test("saves checkpoint during execution (partial failure)", async () => {
      const executor = createWorkflowExecutor();

      const config: WorkflowConfig = {
        name: "CheckpointWorkflow",
        checkpointFile: TEST_CHECKPOINT_FILE,
        steps: [
          createTestStep("step1"),
          createTestStep("step2", {
            dependsOn: ["step1"],
            execute: async () => ({ success: false, message: "Intentional failure" }),
          }),
        ],
      };

      await executor.execute(config);

      // Checkpoint should exist because step2 failed (not cleaned up)
      expect(existsSync(TEST_CHECKPOINT_FILE)).toBe(true);
      const checkpoint = JSON.parse(readFileSync(TEST_CHECKPOINT_FILE, "utf-8"));
      expect(checkpoint.completedSteps).toContain("step1");
      expect(checkpoint.completedSteps).not.toContain("step2");
    });

    test("resumes from checkpoint via executeWithCheckpoint", async () => {
      const executor = createWorkflowExecutor();
      const executedSteps: string[] = [];

      // Create initial checkpoint with step1 complete
      writeFileSync(
        TEST_CHECKPOINT_FILE,
        JSON.stringify({
          workflowName: "ResumeWorkflow",
          completedSteps: ["step1"],
          stepResults: { step1: { success: true, message: "Already done" } },
          startedAt: new Date().toISOString(),
        })
      );

      const config: WorkflowConfig = {
        name: "ResumeWorkflow",
        checkpointFile: TEST_CHECKPOINT_FILE,
        steps: [
          createTestStep("step1", {
            execute: async () => {
              executedSteps.push("step1");
              return { success: true };
            },
          }),
          createTestStep("step2", {
            dependsOn: ["step1"],
            execute: async () => {
              executedSteps.push("step2");
              return { success: true };
            },
          }),
        ],
      };

      // Use executeWithCheckpoint which loads from checkpoint
      const result = await executor.executeWithCheckpoint(config);

      expect(result.success).toBe(true);
      // step1 should be skipped (from checkpoint)
      expect(executedSteps).not.toContain("step1");
      expect(executedSteps).toContain("step2");
    });

    test("cleans up checkpoint on successful completion", async () => {
      const executor = createWorkflowExecutor();

      // Pre-create checkpoint file to ensure cleanup works
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(TEST_CHECKPOINT_FILE, JSON.stringify({ dummy: true }));
      expect(existsSync(TEST_CHECKPOINT_FILE)).toBe(true);

      const config: WorkflowConfig = {
        name: "CleanupCheckpointWorkflow",
        checkpointFile: TEST_CHECKPOINT_FILE,
        steps: [createTestStep("step1")],
      };

      await executor.execute(config);

      // Checkpoint should be cleaned up on success
      expect(existsSync(TEST_CHECKPOINT_FILE)).toBe(false);
    });
  });

  describe("Validation", () => {
    test("validates workflow has at least one step", () => {
      const executor = createWorkflowExecutor();
      const config: WorkflowConfig = {
        name: "EmptyWorkflow",
        steps: [],
      };

      const validation = executor.validate(config);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("Workflow must have at least one step");
    });

    test("validates step names are unique", () => {
      const executor = createWorkflowExecutor();
      const config: WorkflowConfig = {
        name: "DuplicateNamesWorkflow",
        steps: [
          createTestStep("step1"),
          createTestStep("step1"),
        ],
      };

      const validation = executor.validate(config);

      expect(validation.valid).toBe(false);
      expect(validation.errors.some(e => e.includes("duplicate"))).toBe(true);
    });

    test("validates workflow name is provided", () => {
      const executor = createWorkflowExecutor();
      const config: WorkflowConfig = {
        name: "",
        steps: [createTestStep("step1")],
      };

      const validation = executor.validate(config);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("Workflow name is required");
    });
  });

  describe("createTieredWorkflow Helper", () => {
    test("creates daily, weekly, and monthly configs", () => {
      const dailySteps = [createTestStep("daily1"), createTestStep("daily2")];
      const weeklySteps = [createTestStep("weekly1")];
      const monthlySteps = [createTestStep("monthly1"), createTestStep("monthly2"), createTestStep("monthly3")];

      const { daily, weekly, monthly } = createTieredWorkflow(
        "SystemMaintenance",
        dailySteps,
        weeklySteps,
        monthlySteps
      );

      expect(daily.name).toBe("SystemMaintenance-daily");
      expect(daily.steps).toHaveLength(2);
      expect(weekly.name).toBe("SystemMaintenance-weekly");
      expect(weekly.steps).toHaveLength(3); // weekly includes daily + weekly
      expect(monthly.name).toBe("SystemMaintenance-monthly");
      expect(monthly.steps).toHaveLength(6); // monthly includes daily + weekly + monthly
    });

    test("sets appropriate notifications for each tier", () => {
      const { daily, weekly, monthly } = createTieredWorkflow(
        "Test",
        [createTestStep("d")],
        [createTestStep("w")],
        [createTestStep("m")]
      );

      expect(daily.notifyOnStart).toBe(true);
      expect(daily.notifyOnComplete).toBe(true);
      expect(weekly.notifyOnStart).toBe(true);
      expect(weekly.notifyOnComplete).toBe(true);
      expect(monthly.notifyOnStart).toBe(true);
      expect(monthly.notifyOnComplete).toBe(true);
    });
  });

  describe("Singleton Instance", () => {
    test("workflowExecutor is a singleton", () => {
      expect(workflowExecutor).toBeDefined();
      expect(typeof workflowExecutor.execute).toBe("function");
      expect(typeof workflowExecutor.executeWithProgress).toBe("function");
      expect(typeof workflowExecutor.resume).toBe("function");
      expect(typeof workflowExecutor.validate).toBe("function");
    });
  });

  describe("Step Results and Metrics", () => {
    test("captures step metrics in results", async () => {
      const executor = createWorkflowExecutor();

      const config: WorkflowConfig = {
        name: "MetricsWorkflow",
        steps: [
          createTestStep("step1", {
            execute: async () => ({
              success: true,
              message: "Processed items",
              data: { items: [1, 2, 3] },
              metrics: { processedCount: 3, errorCount: 0 },
            }),
          }),
        ],
      };

      const result = await executor.execute(config);

      const stepResult = result.stepResults.get("step1");
      expect(stepResult?.metrics).toEqual({ processedCount: 3, errorCount: 0 });
      expect(stepResult?.data).toEqual({ items: [1, 2, 3] });
    });
  });
});
