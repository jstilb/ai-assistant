#!/usr/bin/env bun
/**
 * ============================================================================
 * WorkflowExecutor - Unified workflow execution engine for Kaya
 * ============================================================================
 *
 * PURPOSE:
 * Standardizes Daily/Weekly/Monthly workflow patterns across skills with:
 * - Step sequencing with dependency DAG resolution
 * - Parallel execution with configurable limits
 * - Retry/error handling with exponential backoff
 * - Progress callbacks for status reporting
 * - ISC (Ideal State Criteria) integration for THEALGORITHM
 * - Checkpointing for resumable workflows
 * - Voice notifications for start/complete events
 *
 * USAGE:
 *   # As library
 *   import { workflowExecutor, createTieredWorkflow } from './WorkflowExecutor';
 *   const result = await workflowExecutor.execute(config);
 *
 *   # As CLI
 *   bun run WorkflowExecutor.ts --workflow daily-maintenance
 *   bun run WorkflowExecutor.ts --resume ~/.claude/.checkpoints/daily.json
 *   bun run WorkflowExecutor.ts --validate workflow.json
 *
 * ============================================================================
 */

import { parseArgs } from "util";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// ============================================================================
// Types
// ============================================================================

/**
 * Result of executing a single workflow step
 */
export interface StepResult {
  /** Whether the step completed successfully */
  success: boolean;
  /** Human-readable message about the step outcome */
  message?: string;
  /** Arbitrary data returned by the step */
  data?: unknown;
  /** Numeric metrics for aggregation (e.g., { processedCount: 10 }) */
  metrics?: Record<string, number>;
}

/**
 * ISC check result for THEALGORITHM integration
 */
export interface ISCCheckResult {
  /** Whether all ISC criteria are met */
  met: boolean;
  /** Score from 0-100 indicating completeness */
  score: number;
  /** List of criteria that are not yet met */
  unmetCriteria: string[];
}

/**
 * Ideal State Criteria specification
 */
export interface ISCSpec {
  /** Human-readable list of criteria */
  criteria: string[];
  /** Function to evaluate criteria against step results */
  checkFn: (results: Map<string, StepResult>) => ISCCheckResult;
}

/**
 * Individual workflow step definition
 */
export interface WorkflowStep {
  /** Unique name for this step */
  name: string;
  /** Human-readable description of what this step does */
  description?: string;
  /** The function to execute for this step */
  execute: () => Promise<StepResult> | StepResult;
  /** Error handler called on step failure (before retry) */
  onError?: (error: Error) => Promise<void> | void;
  /** Number of retry attempts (0 = no retry) */
  retry?: number;
  /** Delay between retries in milliseconds */
  retryDelayMs?: number;
  /** Step timeout in milliseconds */
  timeout?: number;
  /** Names of steps that must complete before this step */
  dependsOn?: string[];
  /** Whether this step can run in parallel with others */
  parallel?: boolean;
  /** Condition to skip this step (returns true to skip) */
  skip?: () => boolean | Promise<boolean>;
}

/**
 * Complete workflow configuration
 */
export interface WorkflowConfig {
  /** Workflow name (used for logging and checkpoints) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Ordered list of steps to execute */
  steps: WorkflowStep[];
  /** ISC specification for THEALGORITHM integration */
  isc?: ISCSpec;
  /** Maximum number of parallel steps (default: 5) */
  maxParallel?: number;
  /** File path for checkpointing (enables resume) */
  checkpointFile?: string;
  /** Send voice notification when workflow starts */
  notifyOnStart?: boolean;
  /** Send voice notification when workflow completes */
  notifyOnComplete?: boolean;
  /** Default timeout for steps (ms) */
  timeout?: number;
}

/**
 * Result of executing a complete workflow
 */
export interface WorkflowResult {
  /** Whether all steps completed successfully */
  success: boolean;
  /** ISO timestamp when workflow started */
  startedAt: string;
  /** ISO timestamp when workflow completed */
  completedAt: string;
  /** Total execution time in milliseconds */
  durationMs: number;
  /** Map of step name to step result */
  stepResults: Map<string, StepResult>;
  /** ISC evaluation result (if ISC was specified) */
  iscResult?: ISCCheckResult;
  /** Name of the step that failed (if any) */
  failedStep?: string;
  /** Error message (if workflow failed) */
  error?: string;
}

/**
 * Progress callback function signature
 */
export type ProgressCallback = (
  step: string,
  status: "started" | "completed" | "failed" | "skipped",
  result?: StepResult
) => void;

/**
 * Checkpoint data structure for resumable workflows
 */
interface Checkpoint {
  workflowName: string;
  completedSteps: string[];
  stepResults: Record<string, StepResult>;
  startedAt: string;
}

/**
 * Validation result
 */
interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * WorkflowExecutor interface
 */
export interface WorkflowExecutor {
  /** Execute a workflow configuration */
  execute(config: WorkflowConfig): Promise<WorkflowResult>;
  /** Execute with progress reporting */
  executeWithProgress(
    config: WorkflowConfig,
    onProgress: ProgressCallback
  ): Promise<WorkflowResult>;
  /** Execute with checkpoint loading (resumes from checkpoint if exists) */
  executeWithCheckpoint(config: WorkflowConfig): Promise<WorkflowResult>;
  /** Resume a workflow from checkpoint (requires config to be provided separately) */
  resume(checkpointFile: string): Promise<WorkflowResult>;
  /** Validate a workflow configuration */
  validate(config: WorkflowConfig): ValidationResult;
}

// ============================================================================
// Implementation
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(homedir(), ".claude");
const VOICE_SERVER_URL = "http://localhost:8888/notify";
const DEFAULT_MAX_PARALLEL = 5;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes

/**
 * Send voice notification (fire and forget)
 */
async function sendNotification(message: string, title?: string): Promise<void> {
  try {
    await fetch(VOICE_SERVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        title: title || "Kaya Workflow",
      }),
    });
  } catch {
    // Voice server may not be running - fail silently
  }
}

/**
 * Build topological sort order from step dependencies
 */
function topologicalSort(steps: WorkflowStep[]): WorkflowStep[] {
  const stepMap = new Map<string, WorkflowStep>();
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  // Initialize
  for (const step of steps) {
    stepMap.set(step.name, step);
    inDegree.set(step.name, 0);
    adjacency.set(step.name, []);
  }

  // Build graph
  for (const step of steps) {
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        adjacency.get(dep)?.push(step.name);
        inDegree.set(step.name, (inDegree.get(step.name) || 0) + 1);
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  const sorted: WorkflowStep[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    sorted.push(stepMap.get(name)!);

    for (const neighbor of adjacency.get(name) || []) {
      const newDegree = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  return sorted;
}

/**
 * Detect circular dependencies in workflow
 */
function hasCircularDependencies(steps: WorkflowStep[]): boolean {
  const sorted = topologicalSort(steps);
  return sorted.length !== steps.length;
}

/**
 * Execute a single step with retry and timeout
 */
async function executeStep(
  step: WorkflowStep,
  defaultTimeout: number
): Promise<StepResult> {
  const maxAttempts = (step.retry ?? 0) + 1;
  const retryDelay = step.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const timeout = step.timeout ?? defaultTimeout;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Create timeout promise
      const timeoutPromise = new Promise<StepResult>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Step '${step.name}' timed out after ${timeout}ms`));
        }, timeout);
      });

      // Race between execution and timeout
      const result = await Promise.race([
        Promise.resolve(step.execute()),
        timeoutPromise,
      ]);

      if (result.success) {
        return result;
      }

      // Step returned failure (not thrown)
      lastError = new Error(result.message || "Step failed");

      if (attempt < maxAttempts) {
        await Bun.sleep(retryDelay);
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Call onError handler if provided
      if (step.onError) {
        try {
          await step.onError(lastError);
        } catch {
          // Ignore errors in error handler
        }
      }

      if (attempt < maxAttempts) {
        await Bun.sleep(retryDelay);
      }
    }
  }

  return {
    success: false,
    message: lastError?.message || "Unknown error",
  };
}

/**
 * Save checkpoint to file
 */
function saveCheckpoint(
  checkpointFile: string,
  workflowName: string,
  completedSteps: string[],
  stepResults: Map<string, StepResult>,
  startedAt: string
): void {
  const dir = dirname(checkpointFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const checkpoint: Checkpoint = {
    workflowName,
    completedSteps,
    stepResults: Object.fromEntries(stepResults),
    startedAt,
  };

  writeFileSync(checkpointFile, JSON.stringify(checkpoint, null, 2));
}

/**
 * Load checkpoint from file
 */
function loadCheckpoint(checkpointFile: string): Checkpoint | null {
  if (!existsSync(checkpointFile)) {
    return null;
  }

  try {
    const content = readFileSync(checkpointFile, "utf-8");
    return JSON.parse(content) as Checkpoint;
  } catch {
    return null;
  }
}

/**
 * Create the workflow executor implementation
 */
export function createWorkflowExecutor(): WorkflowExecutor {
  return {
    validate(config: WorkflowConfig): ValidationResult {
      const errors: string[] = [];

      // Check workflow name
      if (!config.name || config.name.trim() === "") {
        errors.push("Workflow name is required");
      }

      // Check steps exist
      if (!config.steps || config.steps.length === 0) {
        errors.push("Workflow must have at least one step");
      }

      // Check for duplicate step names
      const stepNames = new Set<string>();
      for (const step of config.steps) {
        if (stepNames.has(step.name)) {
          errors.push(`Step name '${step.name}' is duplicate`);
        }
        stepNames.add(step.name);
      }

      // Check dependencies reference existing steps
      for (const step of config.steps) {
        if (step.dependsOn) {
          for (const dep of step.dependsOn) {
            if (!stepNames.has(dep)) {
              errors.push(`Step '${step.name}' depends on unknown step '${dep}'`);
            }
          }
        }
      }

      // Check for circular dependencies
      if (config.steps.length > 0 && hasCircularDependencies(config.steps)) {
        errors.push("Workflow contains circular dependencies");
      }

      return {
        valid: errors.length === 0,
        errors,
      };
    },

    async execute(config: WorkflowConfig): Promise<WorkflowResult> {
      return this.executeWithProgress(config, () => {});
    },

    async executeWithProgress(
      config: WorkflowConfig,
      onProgress: ProgressCallback
    ): Promise<WorkflowResult> {
      // Validate configuration
      const validation = this.validate(config);
      if (!validation.valid) {
        return {
          success: false,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
          stepResults: new Map(),
          error: `Invalid workflow: ${validation.errors.join(", ")}`,
        };
      }

      const startedAt = new Date().toISOString();
      const startTime = Date.now();
      const stepResults = new Map<string, StepResult>();
      const completedSteps = new Set<string>();
      let failedStep: string | undefined;
      let error: string | undefined;

      // Send start notification
      if (config.notifyOnStart) {
        await sendNotification(
          `Starting ${config.name} workflow`,
          config.name
        );
      }

      // Sort steps by dependency order
      const sortedSteps = topologicalSort(config.steps);
      const maxParallel = config.maxParallel ?? DEFAULT_MAX_PARALLEL;
      const defaultTimeout = config.timeout ?? DEFAULT_TIMEOUT_MS;

      // Group steps by dependency level for parallel execution
      const stepMap = new Map<string, WorkflowStep>();
      for (const step of sortedSteps) {
        stepMap.set(step.name, step);
      }

      // Execute steps respecting dependencies and parallelism
      const pending = new Set(sortedSteps.map((s) => s.name));
      const running = new Set<string>();

      const canStart = (step: WorkflowStep): boolean => {
        // Check dependencies are complete
        if (step.dependsOn) {
          for (const dep of step.dependsOn) {
            if (!completedSteps.has(dep)) {
              return false;
            }
          }
        }
        return true;
      };

      const executeStepAsync = async (step: WorkflowStep): Promise<void> => {
        running.add(step.name);

        // Check skip condition
        if (step.skip) {
          const shouldSkip = await Promise.resolve(step.skip());
          if (shouldSkip) {
            pending.delete(step.name);
            running.delete(step.name);
            completedSteps.add(step.name);
            onProgress(step.name, "skipped");
            return;
          }
        }

        onProgress(step.name, "started");

        const result = await executeStep(step, defaultTimeout);
        stepResults.set(step.name, result);
        running.delete(step.name);
        pending.delete(step.name);

        if (result.success) {
          completedSteps.add(step.name);

          // Save checkpoint if configured (only on success)
          if (config.checkpointFile) {
            saveCheckpoint(
              config.checkpointFile,
              config.name,
              Array.from(completedSteps),
              stepResults,
              startedAt
            );
          }

          onProgress(step.name, "completed", result);
        } else {
          failedStep = step.name;
          error = result.message || "Step failed";
          onProgress(step.name, "failed", result);
        }
      };

      // Main execution loop
      while (pending.size > 0 && !failedStep) {
        // Find steps that can start
        const ready: WorkflowStep[] = [];
        for (const name of pending) {
          if (!running.has(name)) {
            const step = stepMap.get(name)!;
            if (canStart(step)) {
              ready.push(step);
            }
          }
        }

        if (ready.length === 0 && running.size === 0) {
          // Deadlock - should not happen with proper validation
          error = "Workflow deadlocked - check dependencies";
          break;
        }

        if (ready.length === 0) {
          // Wait for running steps to complete
          await Bun.sleep(10);
          continue;
        }

        // Group by parallel capability
        const parallelSteps = ready.filter((s) => s.parallel !== false);
        const sequentialSteps = ready.filter((s) => s.parallel === false);

        // Execute parallel steps (up to maxParallel)
        const parallelBatch = parallelSteps.slice(
          0,
          Math.max(0, maxParallel - running.size)
        );

        if (parallelBatch.length > 0) {
          // Start all parallel steps
          const promises = parallelBatch.map((step) => executeStepAsync(step));
          await Promise.all(promises);
        } else if (sequentialSteps.length > 0 && running.size === 0) {
          // Execute one sequential step at a time when no parallel work is running
          await executeStepAsync(sequentialSteps[0]);
        } else if (running.size > 0) {
          // Wait for running steps
          await Bun.sleep(10);
        }
      }

      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startTime;

      // Evaluate ISC if specified
      let iscResult: ISCCheckResult | undefined;
      if (config.isc && !failedStep) {
        iscResult = config.isc.checkFn(stepResults);
      }

      // Clean up checkpoint on success
      if (!failedStep && config.checkpointFile && existsSync(config.checkpointFile)) {
        rmSync(config.checkpointFile);
      }

      // Send completion notification
      if (config.notifyOnComplete) {
        const message = failedStep
          ? `${config.name} failed at step: ${failedStep}`
          : `${config.name} completed successfully`;
        await sendNotification(message, config.name);
      }

      return {
        success: !failedStep,
        startedAt,
        completedAt,
        durationMs,
        stepResults,
        iscResult,
        failedStep,
        error,
      };
    },

    async executeWithCheckpoint(config: WorkflowConfig): Promise<WorkflowResult> {
      // Load checkpoint if exists
      let checkpoint: Checkpoint | null = null;
      if (config.checkpointFile) {
        checkpoint = loadCheckpoint(config.checkpointFile);
      }

      // If checkpoint exists, modify config to skip completed steps
      if (checkpoint && checkpoint.workflowName === config.name) {
        const completedSet = new Set(checkpoint.completedSteps);
        const modifiedSteps = config.steps.map(step => {
          if (completedSet.has(step.name)) {
            // Mark step to skip
            return {
              ...step,
              skip: () => true,
            };
          }
          return step;
        });

        // Pre-populate step results from checkpoint
        const preloadedResults = new Map<string, StepResult>(
          Object.entries(checkpoint.stepResults)
        );

        // Execute with modified config
        const result = await this.executeWithProgress(
          { ...config, steps: modifiedSteps },
          () => {}
        );

        // Merge preloaded results with new results
        for (const [name, stepResult] of preloadedResults) {
          if (!result.stepResults.has(name)) {
            result.stepResults.set(name, stepResult);
          }
        }

        return result;
      }

      // No checkpoint - execute normally
      return this.execute(config);
    },

    async resume(checkpointFile: string): Promise<WorkflowResult> {
      const checkpoint = loadCheckpoint(checkpointFile);

      if (!checkpoint) {
        return {
          success: false,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
          stepResults: new Map(),
          error: `Checkpoint file not found: ${checkpointFile}`,
        };
      }

      // Load workflow configuration (this would typically come from a registry)
      // For now, return an error indicating the workflow config is needed
      return {
        success: false,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 0,
        stepResults: new Map(),
        error: "Resume requires workflow configuration to be provided. Use executeWithCheckpoint instead.",
      };
    },
  };
}

/**
 * Create tiered workflow configurations (daily, weekly, monthly)
 *
 * Weekly includes daily steps, monthly includes both.
 */
export function createTieredWorkflow(
  name: string,
  daily: WorkflowStep[],
  weekly: WorkflowStep[],
  monthly: WorkflowStep[]
): { daily: WorkflowConfig; weekly: WorkflowConfig; monthly: WorkflowConfig } {
  const checkpointDir = join(KAYA_HOME, ".checkpoints");

  return {
    daily: {
      name: `${name}-daily`,
      description: `Daily ${name.toLowerCase()} workflow`,
      steps: [...daily],
      notifyOnStart: true,
      notifyOnComplete: true,
      checkpointFile: join(checkpointDir, `${name.toLowerCase()}-daily.json`),
    },
    weekly: {
      name: `${name}-weekly`,
      description: `Weekly ${name.toLowerCase()} workflow (includes daily)`,
      steps: [...daily, ...weekly],
      notifyOnStart: true,
      notifyOnComplete: true,
      checkpointFile: join(checkpointDir, `${name.toLowerCase()}-weekly.json`),
    },
    monthly: {
      name: `${name}-monthly`,
      description: `Monthly ${name.toLowerCase()} workflow (includes daily and weekly)`,
      steps: [...daily, ...weekly, ...monthly],
      notifyOnStart: true,
      notifyOnComplete: true,
      checkpointFile: join(checkpointDir, `${name.toLowerCase()}-monthly.json`),
    },
  };
}

/**
 * Singleton workflow executor instance
 */
export const workflowExecutor = createWorkflowExecutor();

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      workflow: { type: "string", short: "w" },
      resume: { type: "string", short: "r" },
      validate: { type: "string", short: "v" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
WorkflowExecutor - Unified workflow execution for Kaya

USAGE:
  bun run WorkflowExecutor.ts [options]

OPTIONS:
  -w, --workflow <name>    Execute a registered workflow by name
  -r, --resume <file>      Resume workflow from checkpoint file
  -v, --validate <file>    Validate workflow configuration from JSON file
  -h, --help               Show this help message

EXAMPLES:
  # Execute a workflow
  bun run WorkflowExecutor.ts --workflow daily-maintenance

  # Resume from checkpoint
  bun run WorkflowExecutor.ts --resume ~/.claude/.checkpoints/daily.json

  # Validate workflow config
  bun run WorkflowExecutor.ts --validate workflow.json

LIBRARY USAGE:
  import { workflowExecutor, createTieredWorkflow } from './WorkflowExecutor';

  // Define workflow
  const config = {
    name: 'MyWorkflow',
    steps: [
      { name: 'step1', execute: async () => ({ success: true }) },
      { name: 'step2', execute: async () => ({ success: true }), dependsOn: ['step1'] }
    ],
    notifyOnStart: true,
    notifyOnComplete: true,
  };

  // Execute
  const result = await workflowExecutor.execute(config);
  console.log(\`Completed in \${result.durationMs}ms\`);

  // Execute with progress
  await workflowExecutor.executeWithProgress(config, (step, status) => {
    console.log(\`[\${status}] \${step}\`);
  });

  // Create tiered workflows
  const { daily, weekly, monthly } = createTieredWorkflow(
    'Maintenance',
    [dailyStep1, dailyStep2],
    [weeklyStep1],
    [monthlyStep1]
  );
`);
    return;
  }

  if (values.validate) {
    try {
      const content = readFileSync(values.validate, "utf-8");
      const config = JSON.parse(content) as WorkflowConfig;
      const result = workflowExecutor.validate(config);

      if (result.valid) {
        console.log("Workflow configuration is valid");
      } else {
        console.log("Validation errors:");
        for (const error of result.errors) {
          console.log(`  - ${error}`);
        }
        process.exit(1);
      }
    } catch (error) {
      console.error("Error reading workflow config:", error);
      process.exit(1);
    }
    return;
  }

  if (values.resume) {
    const checkpoint = loadCheckpoint(values.resume);
    if (!checkpoint) {
      console.error(`Checkpoint not found: ${values.resume}`);
      process.exit(1);
    }

    console.log(`Checkpoint found for workflow: ${checkpoint.workflowName}`);
    console.log(`Completed steps: ${checkpoint.completedSteps.join(", ")}`);
    console.log(`Started at: ${checkpoint.startedAt}`);
    console.log("");
    console.log("To resume, provide the workflow configuration and use executeWithProgress.");
    return;
  }

  if (values.workflow) {
    console.log(`Workflow execution via CLI requires a workflow registry.`);
    console.log(`Use the library API to execute workflows programmatically.`);
    return;
  }

  // Default: show help
  console.log("Use --help for usage information");
}

// Run CLI if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
