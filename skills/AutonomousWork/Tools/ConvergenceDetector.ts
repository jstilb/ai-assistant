#!/usr/bin/env bun
/**
 * ConvergenceDetector.ts - Trajectory analysis for Ralph loops
 *
 * Tracks test pass rates, error counts, and build success across iterations
 * to detect convergence patterns and trigger appropriate actions.
 *
 * Usage:
 *   bun run ConvergenceDetector.ts --init                      # Initialize tracking
 *   bun run ConvergenceDetector.ts --record <metrics-json>     # Record iteration metrics
 *   bun run ConvergenceDetector.ts --analyze                   # Analyze trajectory
 *   bun run ConvergenceDetector.ts --status                    # Show current status
 *   bun run ConvergenceDetector.ts --should-continue           # Check if loop should continue
 *
 * Trajectories:
 *   CONVERGING  - Metrics improving, continue loop
 *   STABLE      - Metrics steady, may be complete or stuck
 *   OSCILLATING - Metrics fluctuating, needs intervention
 *   DIVERGING   - Metrics worsening, consider rollback
 *
 * Actions:
 *   3 consecutive DIVERGING  → Auto-rollback triggered
 *   5 consecutive OSCILLATING → Pause for review
 *   10 iterations no-progress → Stop loop
 */

import { execSync } from "child_process";
import { join } from "path";
import { z } from "zod";
import { createStateManager, type StateManager } from "../../CORE/Tools/StateManager.ts";

// Zod Schemas
const TrajectorySchema = z.enum(["CONVERGING", "STABLE", "OSCILLATING", "DIVERGING", "UNKNOWN"]);
const LoopStatusSchema = z.enum(["ACTIVE", "PAUSED", "ROLLED_BACK", "STOPPED", "COMPLETED"]);

const IterationMetricsSchema = z.object({
  iteration: z.number(),
  timestamp: z.string(),
  testsPassed: z.number(),
  testsFailed: z.number(),
  testsTotal: z.number(),
  passRate: z.number(),
  buildSuccess: z.boolean(),
  errorCount: z.number(),
  warningCount: z.number(),
  lintErrors: z.number(),
  typeErrors: z.number(),
  commitHash: z.string().optional(),
  notes: z.string().optional(),
});

const TrajectoryHistoryItemSchema = z.object({
  iteration: z.number(),
  trajectory: TrajectorySchema,
  timestamp: z.string(),
});

const ThresholdsSchema = z.object({
  divergingToRollback: z.number(),
  oscillatingToPause: z.number(),
  noProgressToStop: z.number(),
  passRateImprovement: z.number(),
  passRateDecline: z.number(),
});

const ConvergenceStateSchema = z.object({
  startedAt: z.string(),
  lastUpdated: z.string(),
  status: LoopStatusSchema,
  currentTrajectory: TrajectorySchema,
  iterations: z.array(IterationMetricsSchema),
  trajectoryHistory: z.array(TrajectoryHistoryItemSchema),
  consecutiveDiverging: z.number(),
  consecutiveOscillating: z.number(),
  consecutiveNoProgress: z.number(),
  lastGoodCommit: z.string().optional(),
  rollbackCount: z.number(),
  thresholds: ThresholdsSchema,
});

// Type inference from schemas
type Trajectory = z.infer<typeof TrajectorySchema>;
type LoopStatus = z.infer<typeof LoopStatusSchema>;
type IterationMetrics = z.infer<typeof IterationMetricsSchema>;
type ConvergenceState = z.infer<typeof ConvergenceStateSchema>;

const STATE_FILE = join(process.cwd(), ".ralph-convergence.json");

const DEFAULT_THRESHOLDS = {
  divergingToRollback: 3,
  oscillatingToPause: 5,
  noProgressToStop: 10,
  passRateImprovement: 0.05, // 5% improvement
  passRateDecline: 0.1, // 10% decline
};

// StateManager instance
const stateManager: StateManager<ConvergenceState> = createStateManager({
  path: STATE_FILE,
  schema: ConvergenceStateSchema,
  defaults: () => {
    const state: ConvergenceState = {
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      status: "ACTIVE",
      currentTrajectory: "UNKNOWN",
      iterations: [],
      trajectoryHistory: [],
      consecutiveDiverging: 0,
      consecutiveOscillating: 0,
      consecutiveNoProgress: 0,
      rollbackCount: 0,
      thresholds: DEFAULT_THRESHOLDS,
    };

    // Try to get current git commit as baseline
    try {
      state.lastGoodCommit = execSync("git rev-parse HEAD", {
        encoding: "utf-8",
      }).trim();
    } catch {
      // Not in a git repo or no commits
    }

    return state;
  },
  backupOnWrite: true,
  backupDir: join(process.cwd(), ".ralph-backups"),
});

/**
 * Initialize convergence tracking
 */
async function initTracking(): Promise<ConvergenceState> {
  const state: ConvergenceState = {
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    status: "ACTIVE",
    currentTrajectory: "UNKNOWN",
    iterations: [],
    trajectoryHistory: [],
    consecutiveDiverging: 0,
    consecutiveOscillating: 0,
    consecutiveNoProgress: 0,
    rollbackCount: 0,
    thresholds: DEFAULT_THRESHOLDS,
  };

  // Try to get current git commit as baseline
  try {
    state.lastGoodCommit = execSync("git rev-parse HEAD", {
      encoding: "utf-8",
    }).trim();
  } catch {
    // Not in a git repo or no commits
  }

  await stateManager.save(state);
  return state;
}

/**
 * Parse test output to extract metrics
 */
function parseTestOutput(output: string): Partial<IterationMetrics> {
  const metrics: Partial<IterationMetrics> = {
    testsPassed: 0,
    testsFailed: 0,
    testsTotal: 0,
    errorCount: 0,
    warningCount: 0,
    lintErrors: 0,
    typeErrors: 0,
    buildSuccess: true,
  };

  // Jest/Vitest format: "Tests: X passed, Y failed, Z total"
  const testMatch = output.match(
    /Tests?:\s*(\d+)\s*passed.*?(\d+)\s*failed.*?(\d+)\s*total/i
  );
  if (testMatch) {
    metrics.testsPassed = parseInt(testMatch[1]);
    metrics.testsFailed = parseInt(testMatch[2]);
    metrics.testsTotal = parseInt(testMatch[3]);
  }

  // Pytest format: "X passed, Y failed"
  const pytestMatch = output.match(/(\d+)\s*passed.*?(\d+)\s*failed/i);
  if (pytestMatch && !testMatch) {
    metrics.testsPassed = parseInt(pytestMatch[1]);
    metrics.testsFailed = parseInt(pytestMatch[2]);
    metrics.testsTotal = metrics.testsPassed + metrics.testsFailed;
  }

  // Error/warning counts
  const errorMatches = output.match(/\berrors?\b/gi);
  metrics.errorCount = errorMatches?.length || 0;

  const warningMatches = output.match(/\bwarnings?\b/gi);
  metrics.warningCount = warningMatches?.length || 0;

  // TypeScript errors: "Found X errors"
  const tsErrorMatch = output.match(/Found\s+(\d+)\s+errors?/i);
  if (tsErrorMatch) {
    metrics.typeErrors = parseInt(tsErrorMatch[1]);
  }

  // ESLint/Ruff: "X problems"
  const lintMatch = output.match(/(\d+)\s+problems?/i);
  if (lintMatch) {
    metrics.lintErrors = parseInt(lintMatch[1]);
  }

  // Build failure detection
  if (
    output.includes("BUILD FAILED") ||
    output.includes("build failed") ||
    output.includes("error: ") ||
    output.includes("FATAL ERROR")
  ) {
    metrics.buildSuccess = false;
  }

  return metrics;
}

/**
 * Record metrics from an iteration
 */
async function recordIteration(metricsInput: Partial<IterationMetrics>): Promise<{
  state: ConvergenceState;
  trajectory: Trajectory;
  action: string;
}> {
  return await stateManager.transaction(async (state) => {
    const iteration = state.iterations.length + 1;

    // Calculate pass rate
    const testsTotal = metricsInput.testsTotal || 0;
    const testsPassed = metricsInput.testsPassed || 0;
    const passRate = testsTotal > 0 ? testsPassed / testsTotal : 0;

    const metrics: IterationMetrics = {
      iteration,
      timestamp: new Date().toISOString(),
      testsPassed,
      testsFailed: metricsInput.testsFailed || 0,
      testsTotal,
      passRate,
      buildSuccess: metricsInput.buildSuccess ?? true,
      errorCount: metricsInput.errorCount || 0,
      warningCount: metricsInput.warningCount || 0,
      lintErrors: metricsInput.lintErrors || 0,
      typeErrors: metricsInput.typeErrors || 0,
      commitHash: metricsInput.commitHash,
      notes: metricsInput.notes,
    };

    state.iterations.push(metrics);

    // Analyze trajectory
    const trajectory = analyzeTrajectory(state);
    state.currentTrajectory = trajectory;
    state.trajectoryHistory.push({
      iteration,
      trajectory,
      timestamp: new Date().toISOString(),
    });

    // Update consecutive counters
    updateConsecutiveCounters(state, trajectory);

    // Determine action
    const action = determineAction(state);
    state.lastUpdated = new Date().toISOString();

    // Update last good commit if this iteration was good
    if (metrics.buildSuccess && metrics.testsFailed === 0 && metrics.commitHash) {
      state.lastGoodCommit = metrics.commitHash;
    }

    return { state, trajectory, action };
  });
}

/**
 * Analyze trajectory based on recent iterations
 */
function analyzeTrajectory(state: ConvergenceState): Trajectory {
  const iterations = state.iterations;
  if (iterations.length < 2) return "UNKNOWN";

  const recent = iterations.slice(-5); // Look at last 5 iterations
  const passRates = recent.map((i) => i.passRate);
  const errorCounts = recent.map((i) => i.errorCount + i.typeErrors);
  const buildSuccesses = recent.map((i) => (i.buildSuccess ? 1 : 0));

  // Calculate trends
  const passRateTrend = calculateTrend(passRates);
  const errorTrend = calculateTrend(errorCounts);
  const buildTrend = calculateTrend(buildSuccesses);

  // Determine trajectory
  const { passRateImprovement, passRateDecline } = state.thresholds;

  // CONVERGING: Pass rate improving, errors decreasing, builds succeeding
  if (
    passRateTrend > passRateImprovement &&
    errorTrend <= 0 &&
    buildTrend >= 0
  ) {
    return "CONVERGING";
  }

  // DIVERGING: Pass rate declining significantly, errors increasing, builds failing
  if (
    passRateTrend < -passRateDecline ||
    errorTrend > 2 ||
    buildTrend < -0.3
  ) {
    return "DIVERGING";
  }

  // OSCILLATING: Metrics fluctuating without clear direction
  const passRateVariance = calculateVariance(passRates);
  if (passRateVariance > 0.1 || Math.abs(passRateTrend) < passRateImprovement) {
    // Check for back-and-forth pattern
    const changes = passRates
      .slice(1)
      .map((v, i) => Math.sign(v - passRates[i]));
    const directionChanges = changes
      .slice(1)
      .filter((c, i) => c !== 0 && c !== changes[i]).length;
    if (directionChanges >= 2) {
      return "OSCILLATING";
    }
  }

  // STABLE: Metrics consistent
  if (passRateVariance < 0.05 && Math.abs(errorTrend) < 1) {
    return "STABLE";
  }

  return "UNKNOWN";
}

/**
 * Calculate linear trend (slope) of values
 */
function calculateTrend(values: number[]): number {
  if (values.length < 2) return 0;
  const n = values.length;
  const sumX = (n * (n - 1)) / 2;
  const sumY = values.reduce((a, b) => a + b, 0);
  const sumXY = values.reduce((sum, y, x) => sum + x * y, 0);
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;

  return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
}

/**
 * Calculate variance of values
 */
function calculateVariance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return (
    values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length
  );
}

/**
 * Update consecutive counters based on trajectory
 */
function updateConsecutiveCounters(
  state: ConvergenceState,
  trajectory: Trajectory
): void {
  if (trajectory === "DIVERGING") {
    state.consecutiveDiverging++;
    state.consecutiveOscillating = 0;
  } else if (trajectory === "OSCILLATING") {
    state.consecutiveOscillating++;
    state.consecutiveDiverging = 0;
  } else if (trajectory === "CONVERGING") {
    state.consecutiveDiverging = 0;
    state.consecutiveOscillating = 0;
    state.consecutiveNoProgress = 0;
  } else if (trajectory === "STABLE") {
    state.consecutiveNoProgress++;
    state.consecutiveDiverging = 0;
    state.consecutiveOscillating = 0;
  } else {
    // UNKNOWN
    state.consecutiveNoProgress++;
  }
}

/**
 * Determine action based on state
 */
function determineAction(state: ConvergenceState): string {
  const { thresholds } = state;

  // Check for rollback
  if (state.consecutiveDiverging >= thresholds.divergingToRollback) {
    state.status = "ROLLED_BACK";
    state.rollbackCount++;
    if (state.lastGoodCommit) {
      return `ROLLBACK: ${state.consecutiveDiverging} consecutive diverging iterations. Rolling back to ${state.lastGoodCommit}`;
    }
    return `ROLLBACK: ${state.consecutiveDiverging} consecutive diverging iterations. No good commit to rollback to - manual intervention required.`;
  }

  // Check for pause
  if (state.consecutiveOscillating >= thresholds.oscillatingToPause) {
    state.status = "PAUSED";
    return `PAUSE: ${state.consecutiveOscillating} consecutive oscillating iterations. Loop paused for review.`;
  }

  // Check for stop
  if (state.consecutiveNoProgress >= thresholds.noProgressToStop) {
    state.status = "STOPPED";
    return `STOP: ${state.consecutiveNoProgress} iterations without progress. Loop terminated.`;
  }

  // Continue
  return "CONTINUE";
}

/**
 * Check if loop should continue
 */
async function shouldContinue(): Promise<{
  continue: boolean;
  reason: string;
  trajectory: Trajectory;
}> {
  if (!(await stateManager.exists())) {
    return {
      continue: true,
      reason: "No tracking state - starting fresh",
      trajectory: "UNKNOWN",
    };
  }

  const state = await stateManager.load();

  if (state.status !== "ACTIVE") {
    return {
      continue: false,
      reason: `Loop status is ${state.status}`,
      trajectory: state.currentTrajectory,
    };
  }

  return {
    continue: true,
    reason: `Trajectory: ${state.currentTrajectory}`,
    trajectory: state.currentTrajectory,
  };
}

/**
 * Perform rollback to last good commit
 */
async function performRollback(): Promise<{ success: boolean; message: string }> {
  const state = await stateManager.load();

  if (!state.lastGoodCommit) {
    return { success: false, message: "No good commit to rollback to" };
  }

  try {
    execSync(`git reset --hard ${state.lastGoodCommit}`, { encoding: "utf-8" });

    // Update state after successful rollback
    await stateManager.update((s) => {
      s.status = "ACTIVE"; // Resume after rollback
      s.consecutiveDiverging = 0;
      return s;
    });

    return {
      success: true,
      message: `Rolled back to ${state.lastGoodCommit}`,
    };
  } catch (e) {
    return { success: false, message: `Rollback failed: ${e}` };
  }
}

/**
 * Get formatted status display
 */
async function getStatus(): Promise<string> {
  if (!(await stateManager.exists())) {
    return "No convergence tracking active.";
  }

  const state = await stateManager.load();

  const recentIterations = state.iterations.slice(-5);
  const recentDisplay = recentIterations
    .map(
      (i) =>
        `  #${i.iteration}: ${(i.passRate * 100).toFixed(1)}% pass, ${i.errorCount} errors, build: ${i.buildSuccess ? "OK" : "FAIL"}`
    )
    .join("\n");

  const trajectoryEmoji = {
    CONVERGING: "✅",
    STABLE: "➖",
    OSCILLATING: "🔄",
    DIVERGING: "❌",
    UNKNOWN: "❓",
  };

  return `
==========================================
RALPH LOOP CONVERGENCE STATUS
==========================================
Status:              ${state.status}
Current Trajectory:  ${trajectoryEmoji[state.currentTrajectory]} ${state.currentTrajectory}
Total Iterations:    ${state.iterations.length}
Rollbacks:           ${state.rollbackCount}

Consecutive Counters:
  Diverging:         ${state.consecutiveDiverging}/${state.thresholds.divergingToRollback} (rollback at)
  Oscillating:       ${state.consecutiveOscillating}/${state.thresholds.oscillatingToPause} (pause at)
  No Progress:       ${state.consecutiveNoProgress}/${state.thresholds.noProgressToStop} (stop at)

Last Good Commit:    ${state.lastGoodCommit || "None"}

Recent Iterations:
${recentDisplay || "  (no iterations recorded)"}

Started:             ${state.startedAt}
Last Updated:        ${state.lastUpdated}
==========================================
`;
}

// CLI handling
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
ConvergenceDetector - Ralph Loop Trajectory Analysis

Commands:
  --init                    Initialize convergence tracking
  --record <json>           Record iteration metrics (JSON object or parse from stdin)
  --parse <output>          Parse test/build output and record metrics
  --analyze                 Analyze current trajectory
  --should-continue         Check if loop should continue (exit 0=yes, 1=no)
  --rollback                Perform rollback to last good commit
  --status                  Show current status
  --reset                   Reset tracking state

Metrics JSON format:
  {
    "testsPassed": 10,
    "testsFailed": 2,
    "testsTotal": 12,
    "buildSuccess": true,
    "errorCount": 0,
    "typeErrors": 0,
    "commitHash": "abc123"
  }

Examples:
  bun run ConvergenceDetector.ts --init
  bun run ConvergenceDetector.ts --record '{"testsPassed":10,"testsFailed":0,"testsTotal":10,"buildSuccess":true}'
  npm test 2>&1 | bun run ConvergenceDetector.ts --parse -
  bun run ConvergenceDetector.ts --should-continue && ./loop.sh
`);
    process.exit(0);
  }

  if (args[0] === "--init") {
    const state = await initTracking();
    console.log("Convergence tracking initialized.");
    console.log(`Thresholds: ${JSON.stringify(state.thresholds, null, 2)}`);
    process.exit(0);
  }

  if (args[0] === "--record") {
    let metricsJson = args[1];
    if (!metricsJson || metricsJson === "-") {
      // Read from stdin
      const { readFileSync } = await import("fs");
      metricsJson = readFileSync(0, "utf-8");
    }
    try {
      const metrics = JSON.parse(metricsJson);
      const result = await recordIteration(metrics);
      console.log(`Trajectory: ${result.trajectory}`);
      console.log(`Action: ${result.action}`);
      process.exit(
        result.action === "CONTINUE" || result.action.startsWith("ROLLBACK")
          ? 0
          : 1
      );
    } catch (e) {
      console.error(`Error parsing metrics: ${e}`);
      process.exit(1);
    }
  }

  if (args[0] === "--parse") {
    let output = args[1];
    if (!output || output === "-") {
      const { readFileSync } = await import("fs");
      output = readFileSync(0, "utf-8");
    } else {
      const { existsSync, readFileSync } = await import("fs");
      if (existsSync(output)) {
        output = readFileSync(output, "utf-8");
      }
    }
    const metrics = parseTestOutput(output);

    // Try to get current commit
    try {
      metrics.commitHash = execSync("git rev-parse HEAD", {
        encoding: "utf-8",
      }).trim();
    } catch {
      // Not in git repo
    }

    const result = await recordIteration(metrics);
    console.log(`Parsed metrics: ${JSON.stringify(metrics, null, 2)}`);
    console.log(`Trajectory: ${result.trajectory}`);
    console.log(`Action: ${result.action}`);
    process.exit(result.action === "CONTINUE" ? 0 : 1);
  }

  if (args[0] === "--analyze") {
    if (!(await stateManager.exists())) {
      console.log("No tracking state. Initialize with --init first.");
      process.exit(1);
    }
    const state = await stateManager.load();
    const trajectory = analyzeTrajectory(state);
    console.log(`Current trajectory: ${trajectory}`);
    process.exit(0);
  }

  if (args[0] === "--should-continue") {
    const result = await shouldContinue();
    console.log(result.reason);
    process.exit(result.continue ? 0 : 1);
  }

  if (args[0] === "--rollback") {
    const result = await performRollback();
    console.log(result.message);
    process.exit(result.success ? 0 : 1);
  }

  if (args[0] === "--reset") {
    if (await stateManager.exists()) {
      await stateManager.update((state) => {
        state.status = "COMPLETED";
        return state;
      });
    }
    console.log("Convergence tracking reset.");
    process.exit(0);
  }

  if (args[0] === "--status" || args.length === 0) {
    console.log(await getStatus());
    process.exit(0);
  }

  console.error(`Unknown command: ${args[0]}. Use --help for usage.`);
  process.exit(1);
}

// Run CLI if executed directly
if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
