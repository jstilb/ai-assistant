#!/usr/bin/env bun
/**
 * ============================================================================
 * AutoInfoRunner.ts - Main CLI for AutoInfoManager skill
 * ============================================================================
 *
 * PURPOSE:
 * CLI-first entry point for tiered maintenance workflows. Reads step
 * definitions from Config/tiers.json and delegates execution to
 * StepDispatcher + WorkflowExecutor. This is the sole CLI entry point;
 * TierExecutor is used only as a library for parallel group execution.
 *
 * USAGE:
 *   # Execute tiers
 *   bun AutoInfoRunner.ts --tier daily
 *   bun AutoInfoRunner.ts --tier weekly
 *   bun AutoInfoRunner.ts --tier monthly
 *
 *   # Dry run
 *   bun AutoInfoRunner.ts --tier weekly --dry-run
 *
 *   # Resume from checkpoint
 *   bun AutoInfoRunner.ts --resume <checkpoint-path>
 *
 *   # Status and health
 *   bun AutoInfoRunner.ts --status
 *   bun AutoInfoRunner.ts --health
 *   bun AutoInfoRunner.ts --health --json
 *   bun AutoInfoRunner.ts --errors
 *
 * ============================================================================
 */

import { parseArgs } from "util";
import { join, dirname } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { z } from "zod";

// Import core tools
import {
  workflowExecutor,
  type WorkflowConfig,
  type WorkflowStep,
  type StepResult,
} from "../../../skills/CORE/Tools/WorkflowExecutor";
import { notifySync } from "../../../skills/CORE/Tools/NotificationService";
import { invokeSkill } from "../../../skills/CORE/Tools/SkillInvoker";
import { createStateManager, type StateManager } from "../../../skills/CORE/Tools/StateManager";
import { prepareOutputPath } from "../../../skills/CORE/Tools/OutputPathResolver";

// Import StepDispatcher for config-driven execution
import {
  createStepDispatcher,
  type StepDispatcher,
  type TierStepConfig,
  type InternalFunctionRegistry,
  type ConditionRegistry,
} from "./StepDispatcher";

// ============================================================================
// Constants
// ============================================================================

const KAYA_DIR = process.env.KAYA_DIR || join(homedir(), ".claude");
const SKILL_DIR = join(KAYA_DIR, "skills/AutoInfoManager");
const OUTPUT_DIR = join(KAYA_DIR, "MEMORY/AUTOINFO");
const STATE_DIR = join(SKILL_DIR, "State");
const CONFIG_DIR = join(SKILL_DIR, "Config");
const CHECKPOINT_DIR = join(KAYA_DIR, ".checkpoints");

// Ensure directories exist
const ensureDirs = () => {
  for (const dir of [OUTPUT_DIR, STATE_DIR, CHECKPOINT_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  for (const subdir of ["daily", "weekly", "monthly", "errors", "state"]) {
    const path = join(OUTPUT_DIR, subdir);
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  }
};

// ============================================================================
// Types and Schemas
// ============================================================================

type Tier = "daily" | "weekly" | "monthly";

/** Zod schema for individual tier run data */
const TierRunSchema = z.object({
  timestamp: z.string(),
  success: z.boolean(),
  durationMs: z.number(),
}).nullable();

/** Zod schema for LastRunState - validated state persistence */
const LastRunStateSchema = z.object({
  daily: TierRunSchema,
  weekly: TierRunSchema,
  monthly: TierRunSchema,
});

type LastRunState = z.infer<typeof LastRunStateSchema>;

// ============================================================================
// State Manager (replaces manual loadLastRuns/saveLastRun)
// ============================================================================

let _lastRunsManager: StateManager<LastRunState> | null = null;

function getLastRunsManager(): StateManager<LastRunState> {
  if (!_lastRunsManager) {
    _lastRunsManager = createStateManager({
      path: join(STATE_DIR, "last-runs.json"),
      schema: LastRunStateSchema,
      defaults: { daily: null, weekly: null, monthly: null },
      version: 1,
      backupOnWrite: true,
      backupDir: join(STATE_DIR, "backups"),
    });
  }
  return _lastRunsManager;
}

// ============================================================================
// State Management (using CORE/StateManager)
// ============================================================================

async function loadLastRuns(): Promise<LastRunState> {
  return await getLastRunsManager().load();
}

async function saveLastRun(tier: Tier, success: boolean, durationMs: number): Promise<void> {
  await getLastRunsManager().update((state) => ({
    ...state,
    [tier]: {
      timestamp: new Date().toISOString(),
      success,
      durationMs,
    },
  }));
}

// ============================================================================
// Tier Config Loading
// ============================================================================

interface TierConfig {
  schedule?: string;
  timeout: number;
  maxParallel?: number;
  inherits?: string;
  steps: TierStepConfig[];
}

interface TiersConfig {
  version: number;
  daily: TierConfig;
  weekly: TierConfig;
  monthly: TierConfig;
  errorHandling?: Record<string, unknown>;
  notifications?: Record<string, unknown>;
}

/**
 * Load and parse tiers.json. Returns the full config or defaults on failure.
 */
function loadTiersConfig(): TiersConfig {
  const configPath = join(CONFIG_DIR, "tiers.json");
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      return raw as TiersConfig;
    } catch (error) {
      console.warn(`[AutoInfoRunner] Failed to parse tiers.json: ${error instanceof Error ? error.message : String(error)}`);
      console.warn("[AutoInfoRunner] Falling back to minimal daily config");
    }
  }

  // Fallback: minimal daily-only config
  return {
    version: 1,
    daily: {
      timeout: 300000,
      steps: [
        { name: "NotifyStart", type: "notification", message: "Starting daily autoinfo (fallback config)" },
      ],
    },
    weekly: { timeout: 600000, steps: [] },
    monthly: { timeout: 900000, steps: [] },
  };
}

/**
 * Get steps for a tier, resolving inheritance (weekly inherits daily, monthly inherits weekly).
 */
function getStepsForTier(config: TiersConfig, tier: Tier): TierStepConfig[] {
  const tierConfig = config[tier];
  let steps: TierStepConfig[] = [];

  // Resolve inheritance chain
  if (tierConfig.inherits) {
    const parentTier = tierConfig.inherits as Tier;
    if (["daily", "weekly", "monthly"].includes(parentTier)) {
      steps = getStepsForTier(config, parentTier);
    }
  }

  // Append this tier's own steps
  steps = [...steps, ...tierConfig.steps];
  return steps;
}

// ============================================================================
// Internal Function Registry
// ============================================================================

/**
 * Build the internal function registry with all internal step implementations.
 * These are the functions called when a step has type: "internal" in tiers.json.
 */
function buildInternalRegistry(): InternalFunctionRegistry {
  const registry: InternalFunctionRegistry = new Map();

  // LightDriftCheck: time-based context staleness check
  registry.set("LightDriftCheck", async (): Promise<StepResult> => {
    const contextDir = join(KAYA_DIR, "context");
    let staleCount = 0;
    const now = Date.now();
    const threshold = 24 * 60 * 60 * 1000; // 24 hours

    if (existsSync(contextDir)) {
      const files = readdirSync(contextDir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        try {
          const stat = statSync(join(contextDir, file));
          if (now - stat.mtime.getTime() > threshold) {
            staleCount++;
          }
        } catch { /* skip */ }
      }
    }

    return {
      success: true,
      message: `${staleCount} stale context files detected`,
      metrics: { staleFiles: staleCount },
    };
  });

  // DailySynthesize: imports real implementation (M2 replaces stub)
  registry.set("DailySynthesize", async (): Promise<StepResult> => {
    try {
      const { dailySynthesize } = await import("./Synthesizers");
      return dailySynthesize();
    } catch {
      // Fallback: minimal synthesis
      return {
        success: true,
        message: "Daily synthesis: no synthesizer module available",
        data: { insights: [], trends: [], anomalies: [] },
      };
    }
  });

  // WeeklySynthesize
  registry.set("WeeklySynthesize", async (): Promise<StepResult> => {
    try {
      const { weeklySynthesize } = await import("./Synthesizers");
      return weeklySynthesize();
    } catch {
      return {
        success: true,
        message: "Weekly synthesis: no synthesizer module available",
      };
    }
  });

  // MonthlySynthesize
  registry.set("MonthlySynthesize", async (): Promise<StepResult> => {
    try {
      const { monthlySynthesize } = await import("./Synthesizers");
      return monthlySynthesize();
    } catch {
      return {
        success: true,
        message: "Monthly synthesis: no synthesizer module available",
      };
    }
  });

  // CheckKayaUpgrade
  registry.set("CheckKayaUpgrade", async (): Promise<StepResult> => {
    try {
      const proc = Bun.spawn(["git", "-C", KAYA_DIR, "fetch", "--dry-run"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      return { success: true, message: "Kaya upgrade check complete" };
    } catch {
      return { success: true, message: "Kaya upgrade check skipped" };
    }
  });

  // FullDriftCheck: hash-based drift detection
  registry.set("FullDriftCheck", async (): Promise<StepResult> => {
    const contextDir = join(KAYA_DIR, "context");
    const results: Record<string, string> = {};

    if (existsSync(contextDir)) {
      const files = readdirSync(contextDir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        try {
          const content = await Bun.file(join(contextDir, file)).text();
          const hasher = new Bun.CryptoHasher("sha256");
          hasher.update(content);
          results[file] = hasher.digest("hex").slice(0, 8);
        } catch { /* skip */ }
      }
    }

    return {
      success: true,
      message: `Checked ${Object.keys(results).length} context files`,
      data: { hashes: results },
      metrics: { filesChecked: Object.keys(results).length },
    };
  });

  // OrphanRecovery
  registry.set("OrphanRecovery", async (): Promise<StepResult> => {
    try {
      const { runOrphanRecovery } = await import("./OrphanRecovery");
      const result = await runOrphanRecovery({ dryRun: false, minAgeDays: 7 });

      const sizeStr = result.totalOrphanSizeBytes < 1024
        ? `${result.totalOrphanSizeBytes}B`
        : result.totalOrphanSizeBytes < 1024 * 1024
          ? `${(result.totalOrphanSizeBytes / 1024).toFixed(1)}KB`
          : `${(result.totalOrphanSizeBytes / (1024 * 1024)).toFixed(1)}MB`;

      return {
        success: result.success,
        message: `Scanned ${result.totalScanned} files, found ${result.orphansFound} orphans (${sizeStr})`,
        data: {
          orphansByCategory: Object.fromEntries(
            Object.entries(result.orphansByCategory).map(([cat, files]) => [cat, files.length])
          ),
        },
        metrics: {
          filesScanned: result.totalScanned,
          orphansFound: result.orphansFound,
          orphanSizeBytes: result.totalOrphanSizeBytes,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: `OrphanRecovery failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  // DeepDriftCheck (imports from DriftDetector in M2)
  registry.set("DeepDriftCheck", async (): Promise<StepResult> => {
    try {
      const { deepDriftCheck } = await import("./DriftDetector");
      return deepDriftCheck();
    } catch {
      return {
        success: true,
        message: "Deep drift check: no detector module available",
        metrics: { sourcesChecked: 0, driftDetected: 0 },
      };
    }
  });

  // ProcessScratchPad (for daily tier when config defines it as internal)
  registry.set("ProcessScratchPad", async (): Promise<StepResult> => {
    try {
      const toolPath = join(KAYA_DIR, "skills/InformationManager/Tools/ProcessScratchPad.ts");
      const proc = Bun.spawn(["bun", toolPath, "--json"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode === 0) {
        try {
          const result = JSON.parse(output);
          return {
            success: true,
            message: `Processed ${result.itemsProcessed} items`,
            metrics: {
              itemsProcessed: result.itemsProcessed || 0,
              tasksCreated: result.tasksCreated || 0,
            },
          };
        } catch {
          return { success: true, message: "ProcessScratchPad completed (no JSON output)" };
        }
      } else {
        const stderr = await new Response(proc.stderr).text();
        return { success: false, message: `ProcessScratchPad failed: ${stderr.slice(0, 200)}` };
      }
    } catch (error) {
      return {
        success: false,
        message: `ProcessScratchPad error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  return registry;
}

// ============================================================================
// Condition Registry
// ============================================================================

function buildConditionRegistry(): ConditionRegistry {
  const registry: ConditionRegistry = new Map();

  // architectureChanged: checks if config files have changed since last run
  registry.set("architectureChanged", async (): Promise<boolean> => {
    try {
      const { architectureUpdate } = await import("./DriftDetector");
      const result = await architectureUpdate();
      const data = result.data as { modified?: string[]; added?: string[]; removed?: string[] } | undefined;
      if (!data) return false;
      return (data.modified?.length || 0) + (data.added?.length || 0) + (data.removed?.length || 0) > 0;
    } catch {
      return false; // If DriftDetector not available, skip
    }
  });

  return registry;
}

// ============================================================================
// StepDispatcher Initialization
// ============================================================================

let _dispatcher: StepDispatcher | null = null;

async function getDispatcher(): Promise<StepDispatcher> {
  if (!_dispatcher) {
    let orchestrator: any;
    try {
      const mod = await import("../../../skills/CORE/Tools/AgentOrchestrator");
      orchestrator = mod.createOrchestrator({
        defaultModel: "sonnet",
        defaultTimeout: 120000,
        announceResults: false,
      });
    } catch {
      // Provide a no-op orchestrator if AgentOrchestrator fails to load
      orchestrator = {
        spawnWithAggregation: async () => ({
          results: [],
          aggregated: "Orchestrator unavailable",
        }),
      };
    }

    _dispatcher = createStepDispatcher({
      notifyFn: notifySync,
      invokeSkillFn: invokeSkill,
      orchestrator,
      internalRegistry: buildInternalRegistry(),
      conditionRegistry: buildConditionRegistry(),
    });
  }
  return _dispatcher;
}

// ============================================================================
// Report Generation
// ============================================================================

function generateReport(
  tier: Tier,
  startTime: Date,
  endTime: Date,
  stepResults: Map<string, StepResult>,
  success: boolean
): string {
  const duration = endTime.getTime() - startTime.getTime();
  const durationStr = `${Math.round(duration / 1000)}s`;

  const lines: string[] = [
    `# AutoInfo ${tier.charAt(0).toUpperCase() + tier.slice(1)} Report`,
    "",
    `**Date:** ${startTime.toISOString().split("T")[0]}`,
    `**Started:** ${startTime.toISOString()}`,
    `**Completed:** ${endTime.toISOString()}`,
    `**Duration:** ${durationStr}`,
    `**Status:** ${success ? "SUCCESS" : "FAILED"}`,
    "",
    "## Steps Executed",
    "",
  ];

  for (const [stepName, result] of stepResults) {
    const icon = result.success ? "[OK]" : "[FAIL]";
    lines.push(`- ${icon} **${stepName}**: ${result.message || "No message"}`);
    if (result.metrics) {
      for (const [key, value] of Object.entries(result.metrics)) {
        lines.push(`  - ${key}: ${value}`);
      }
    }
  }

  lines.push("");
  lines.push("## Metrics Summary");
  lines.push("");

  // Aggregate metrics
  const allMetrics: Record<string, number> = {};
  for (const [, result] of stepResults) {
    if (result.metrics) {
      for (const [key, value] of Object.entries(result.metrics)) {
        allMetrics[key] = (allMetrics[key] || 0) + value;
      }
    }
  }

  if (Object.keys(allMetrics).length > 0) {
    for (const [key, value] of Object.entries(allMetrics)) {
      lines.push(`- ${key}: ${value}`);
    }
  } else {
    lines.push("No metrics collected.");
  }

  lines.push("");
  lines.push("---");
  lines.push(`*Generated by AutoInfoManager at ${endTime.toISOString()}*`);

  return lines.join("\n");
}

/**
 * Generate a JSON sidecar for machine-readable report data
 */
function generateReportSidecar(
  tier: Tier,
  startTime: Date,
  endTime: Date,
  stepResults: Map<string, StepResult>,
  success: boolean
): string {
  const duration = endTime.getTime() - startTime.getTime();

  const steps: Array<{ name: string; success: boolean; message?: string; metrics?: Record<string, number>; durationMs?: number }> = [];
  for (const [name, result] of stepResults) {
    steps.push({
      name,
      success: result.success,
      message: result.message,
      metrics: result.metrics,
    });
  }

  // Aggregate metrics
  const allMetrics: Record<string, number> = {};
  for (const [, result] of stepResults) {
    if (result.metrics) {
      for (const [key, value] of Object.entries(result.metrics)) {
        allMetrics[key] = (allMetrics[key] || 0) + value;
      }
    }
  }

  return JSON.stringify({
    tier,
    timestamp: startTime.toISOString(),
    completedAt: endTime.toISOString(),
    durationMs: duration,
    success,
    steps,
    metrics: allMetrics,
  }, null, 2);
}

async function saveReport(tier: Tier, content: string, sidecarJson?: string): Promise<string> {
  const date = new Date();
  let titleSuffix: string;

  switch (tier) {
    case "daily":
      titleSuffix = date.toISOString().split("T")[0];
      break;
    case "weekly": {
      const weekNum = getWeekNumber(date);
      titleSuffix = `${date.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
      break;
    }
    case "monthly":
      titleSuffix = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      break;
  }

  // Use OutputPathResolver for consistent path generation
  const resolved = await prepareOutputPath({
    skill: "AutoInfo",
    title: `${tier}-report-${titleSuffix}`,
    type: "memory",
    extension: "md",
    includeTimestamp: false,
  });

  writeFileSync(resolved.path, content);

  // Save JSON sidecar alongside the markdown report
  if (sidecarJson) {
    const jsonPath = resolved.path.replace(/\.md$/, ".json");
    writeFileSync(jsonPath, sidecarJson);
  }

  return resolved.path;
}

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

// ============================================================================
// Tier Execution (config-driven via StepDispatcher)
// ============================================================================

async function executeTier(tier: Tier, dryRun: boolean = false): Promise<boolean> {
  ensureDirs();

  console.log(`\n=== AutoInfo ${tier.toUpperCase()} ===\n`);

  if (dryRun) {
    console.log("DRY RUN MODE - Steps will not be executed\n");
  }

  // Load config and build steps from tiers.json
  const tiersConfig = loadTiersConfig();
  const stepConfigs = getStepsForTier(tiersConfig, tier);
  const tierTimeout = tiersConfig[tier]?.timeout || 300000;

  if (stepConfigs.length === 0) {
    console.log("No steps configured for this tier.");
    return true;
  }

  // Get dispatcher and convert step configs to WorkflowSteps
  const dispatcher = await getDispatcher();
  const steps = dispatcher.dispatchTier(stepConfigs);

  if (dryRun) {
    console.log("Steps to execute:");
    for (let i = 0; i < steps.length; i++) {
      const config = stepConfigs[i];
      console.log(`  ${i + 1}. [${config.type}] ${steps[i].name}: ${steps[i].description || "No description"}`);
    }
    return true;
  }

  // Build workflow config
  const workflowConfig: WorkflowConfig = {
    name: `autoinfo-${tier}`,
    description: `AutoInfoManager ${tier} workflow`,
    steps,
    notifyOnStart: false,
    notifyOnComplete: true,
    timeout: tierTimeout,
    checkpointFile: join(CHECKPOINT_DIR, `autoinfo-${tier}.json`),
  };

  const startTime = new Date();

  // Execute with progress reporting
  const result = await workflowExecutor.executeWithProgress(workflowConfig, (step, status, stepResult) => {
    const icon = status === "completed" ? "[OK]" : status === "failed" ? "[FAIL]" : status === "started" ? "[RUN]" : "[SKIP]";
    console.log(`${icon} ${step}`);
    if (stepResult?.message) {
      console.log(`    ${stepResult.message}`);
    }
  });

  const endTime = new Date();

  // Generate and save report with JSON sidecar
  const report = generateReport(tier, startTime, endTime, result.stepResults, result.success);
  const sidecar = generateReportSidecar(tier, startTime, endTime, result.stepResults, result.success);
  const reportPath = await saveReport(tier, report, sidecar);

  // Update state (using StateManager)
  await saveLastRun(tier, result.success, result.durationMs);

  // Log errors if any
  if (!result.success && result.error) {
    const { logError } = await import("./ErrorLogger");
    await logError({
      tier,
      step: result.failedStep || "unknown",
      error: result.error,
      recoveryAttempted: false,
      recoverySucceeded: false,
    });
  }

  console.log(`\n=== ${result.success ? "SUCCESS" : "FAILED"} ===`);
  console.log(`Duration: ${result.durationMs}ms`);
  console.log(`Report saved: ${reportPath}`);

  // Final notification
  if (result.success) {
    notifySync(`${tier} autoinfo workflow completed successfully`);
  } else {
    notifySync(`${tier} autoinfo workflow failed at step: ${result.failedStep}`);
  }

  return result.success;
}

/**
 * Resume a tier from checkpoint using executeWithCheckpoint.
 * This properly skips already-completed steps.
 */
async function resumeTier(checkpointPath: string): Promise<boolean> {
  ensureDirs();

  if (!existsSync(checkpointPath)) {
    console.error(`Checkpoint file not found: ${checkpointPath}`);
    return false;
  }

  let checkpoint: { workflowName?: string; completedSteps?: string[] };
  try {
    checkpoint = JSON.parse(readFileSync(checkpointPath, "utf-8"));
  } catch (error) {
    console.error(`Failed to read checkpoint: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  const tier = checkpoint.workflowName?.replace("autoinfo-", "") as Tier;
  if (!tier || !["daily", "weekly", "monthly"].includes(tier)) {
    console.error(`Invalid tier in checkpoint: ${checkpoint.workflowName}`);
    return false;
  }

  console.log(`\n=== Resuming ${tier.toUpperCase()} from checkpoint ===`);
  console.log(`Last completed steps: ${checkpoint.completedSteps?.join(", ") || "none"}`);
  console.log("");

  // Load config and build steps
  const tiersConfig = loadTiersConfig();
  const stepConfigs = getStepsForTier(tiersConfig, tier);
  const tierTimeout = tiersConfig[tier]?.timeout || 300000;

  const dispatcher = await getDispatcher();
  const steps = dispatcher.dispatchTier(stepConfigs);

  // Build workflow config with checkpoint file
  const workflowConfig: WorkflowConfig = {
    name: `autoinfo-${tier}`,
    description: `AutoInfoManager ${tier} workflow (resumed)`,
    steps,
    notifyOnStart: false,
    notifyOnComplete: true,
    timeout: tierTimeout,
    checkpointFile: checkpointPath,
  };

  const startTime = new Date();

  // Use executeWithCheckpoint to properly skip completed steps
  const result = await workflowExecutor.executeWithCheckpoint(workflowConfig);

  const endTime = new Date();

  // Generate report
  const report = generateReport(tier, startTime, endTime, result.stepResults, result.success);
  const sidecar = generateReportSidecar(tier, startTime, endTime, result.stepResults, result.success);
  const reportPath = await saveReport(tier, report, sidecar);

  await saveLastRun(tier, result.success, result.durationMs);

  console.log(`\n=== ${result.success ? "SUCCESS" : "FAILED"} (resumed) ===`);
  console.log(`Duration: ${result.durationMs}ms`);
  console.log(`Report saved: ${reportPath}`);

  return result.success;
}

// ============================================================================
// Status and Health
// ============================================================================

async function showStatus(): Promise<void> {
  console.log("\n=== AutoInfo Status ===\n");

  const state = await loadLastRuns();

  for (const tier of ["daily", "weekly", "monthly"] as Tier[]) {
    const run = state[tier];
    if (run) {
      const status = run.success ? "[OK]" : "[FAIL]";
      const date = new Date(run.timestamp);
      console.log(`${tier.padEnd(10)} ${status} Last: ${date.toLocaleString()} (${Math.round(run.durationMs / 1000)}s)`);
    } else {
      console.log(`${tier.padEnd(10)} [--] Never run`);
    }
  }

  console.log("");
}

interface HealthData {
  directories: Record<string, boolean>;
  voiceServer: boolean;
  tiersConfig: { valid: boolean; error?: string };
  lastRuns: Record<string, { timestamp: string; success: boolean; durationMs: number } | null>;
  checkpoints: string[];
  staleContextFiles: number;
}

async function getHealthData(): Promise<HealthData> {
  const health: HealthData = {
    directories: {},
    voiceServer: false,
    tiersConfig: { valid: false },
    lastRuns: {},
    checkpoints: [],
    staleContextFiles: 0,
  };

  // Check directories
  for (const dir of [OUTPUT_DIR, STATE_DIR, CHECKPOINT_DIR]) {
    health.directories[dir] = existsSync(dir);
  }

  // Check voice server
  try {
    const response = await fetch("http://localhost:8888/health", { method: "HEAD" });
    health.voiceServer = response.ok;
  } catch {
    health.voiceServer = false;
  }

  // Check tiers.json
  const configPath = join(CONFIG_DIR, "tiers.json");
  try {
    if (existsSync(configPath)) {
      JSON.parse(readFileSync(configPath, "utf-8"));
      health.tiersConfig = { valid: true };
    } else {
      health.tiersConfig = { valid: false, error: "File not found" };
    }
  } catch (error) {
    health.tiersConfig = { valid: false, error: error instanceof Error ? error.message : String(error) };
  }

  // Last runs
  const state = await loadLastRuns();
  health.lastRuns = {
    daily: state.daily,
    weekly: state.weekly,
    monthly: state.monthly,
  };

  // Checkpoints
  if (existsSync(CHECKPOINT_DIR)) {
    health.checkpoints = readdirSync(CHECKPOINT_DIR).filter((f) => f.endsWith(".json"));
  }

  // Stale context files
  const contextDir = join(KAYA_DIR, "context");
  if (existsSync(contextDir)) {
    const now = Date.now();
    const threshold = 24 * 60 * 60 * 1000;
    const files = readdirSync(contextDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      try {
        const stat = statSync(join(contextDir, file));
        if (now - stat.mtime.getTime() > threshold) health.staleContextFiles++;
      } catch { /* skip */ }
    }
  }

  return health;
}

async function showHealth(jsonOutput: boolean = false): Promise<void> {
  const health = await getHealthData();

  if (jsonOutput) {
    console.log(JSON.stringify(health, null, 2));
    return;
  }

  console.log("\n=== AutoInfo Health ===\n");

  // Directories
  for (const [dir, exists] of Object.entries(health.directories)) {
    console.log(`${exists ? "[OK]" : "[MISSING]"} ${dir}`);
  }

  // Voice server
  console.log(`${health.voiceServer ? "[OK]" : "[DOWN]"} Voice server`);

  // Config
  console.log(`${health.tiersConfig.valid ? "[OK]" : "[FAIL]"} Tier config${health.tiersConfig.error ? ` (${health.tiersConfig.error})` : ""}`);

  // Last runs
  console.log("\nLast Runs:");
  for (const [tier, run] of Object.entries(health.lastRuns)) {
    if (run) {
      const date = new Date(run.timestamp);
      console.log(`  ${tier}: ${run.success ? "[OK]" : "[FAIL]"} ${date.toLocaleString()} (${Math.round(run.durationMs / 1000)}s)`);
    } else {
      console.log(`  ${tier}: Never run`);
    }
  }

  // Checkpoints
  if (health.checkpoints.length > 0) {
    console.log(`\nActive checkpoints: ${health.checkpoints.join(", ")}`);
  }

  // Stale files
  console.log(`\nStale context files: ${health.staleContextFiles}`);
  console.log("");
}

function showErrors(): void {
  console.log("\n=== Recent Errors (last 7 days) ===\n");

  const errorsDir = join(OUTPUT_DIR, "errors");
  if (!existsSync(errorsDir)) {
    console.log("No errors logged.");
    return;
  }

  const now = Date.now();
  const threshold = 7 * 24 * 60 * 60 * 1000;

  const files = readdirSync(errorsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse();

  let hasErrors = false;

  for (const file of files) {
    const datePart = file.replace(".jsonl", "");
    const fileDate = new Date(datePart);
    if (now - fileDate.getTime() > threshold) continue;

    const content = readFileSync(join(errorsDir, file), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      try {
        const error = JSON.parse(line);
        const recovered = error.recoverySucceeded ? "(recovered)" : "";
        console.log(`${datePart}: ${error.tier}/${error.step} - ${error.error} ${recovered}`);
        hasErrors = true;
      } catch {
        // Skip malformed lines
      }
    }
  }

  if (!hasErrors) {
    console.log("No errors in the last 7 days.");
  }

  console.log("");
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      tier: { type: "string", short: "t" },
      "dry-run": { type: "boolean" },
      resume: { type: "string", short: "r" },
      status: { type: "boolean", short: "s" },
      health: { type: "boolean" },
      errors: { type: "boolean", short: "e" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
AutoInfoRunner - CLI for AutoInfoManager skill

USAGE:
  bun AutoInfoRunner.ts [options]

OPTIONS:
  -t, --tier <tier>    Execute a tier (daily, weekly, monthly)
  --dry-run            Show steps without executing
  -r, --resume <path>  Resume from checkpoint file
  -s, --status         Show last run status
  --health             Check system health
  --health --json      Health check as JSON
  -e, --errors         Show recent errors
  -h, --help           Show this help

EXAMPLES:
  bun AutoInfoRunner.ts --tier daily
  bun AutoInfoRunner.ts --tier weekly --dry-run
  bun AutoInfoRunner.ts --resume ~/.claude/.checkpoints/autoinfo-daily.json
  bun AutoInfoRunner.ts --health --json
  bun AutoInfoRunner.ts --status
  bun AutoInfoRunner.ts --errors
`);
    return;
  }

  if (values.status) {
    await showStatus();
    return;
  }

  if (values.health) {
    await showHealth(values.json || false);
    return;
  }

  if (values.errors) {
    showErrors();
    return;
  }

  if (values.tier) {
    const tier = values.tier as Tier;
    if (!["daily", "weekly", "monthly"].includes(tier)) {
      console.error(`Invalid tier: ${tier}. Must be daily, weekly, or monthly.`);
      process.exit(1);
    }

    const success = await executeTier(tier, values["dry-run"]);
    process.exit(success ? 0 : 1);
  }

  if (values.resume) {
    const success = await resumeTier(values.resume);
    process.exit(success ? 0 : 1);
  }

  // Default: show status
  await showStatus();
}

// Run if executed directly
if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

// Export for testing
export {
  loadTiersConfig,
  getStepsForTier,
  buildInternalRegistry,
  buildConditionRegistry,
  generateReport,
  generateReportSidecar,
  getHealthData,
  type Tier,
  type TiersConfig,
  type TierConfig,
  type HealthData,
};
