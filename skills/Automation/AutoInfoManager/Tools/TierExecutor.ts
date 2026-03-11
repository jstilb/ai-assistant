#!/usr/bin/env bun
/**
 * ============================================================================
 * TierExecutor.ts - AgentOrchestrator wrapper for parallel group execution
 * ============================================================================
 *
 * PURPOSE:
 * Provides a library interface for executing parallel workflow groups using
 * AgentOrchestrator. This is NOT a standalone CLI -- AutoInfoRunner.ts is the
 * sole CLI entry point. TierExecutor is used by StepDispatcher for "parallel"
 * and "orchestrator" step types.
 *
 * USAGE:
 *   import { createTierExecutor } from './TierExecutor';
 *
 *   const executor = createTierExecutor();
 *   const result = await executor.executeGroup([
 *     { skill: 'InformationManager', workflow: 'RefreshAll' },
 *     { skill: 'InformationManager', workflow: 'GatherGoogleDrive' },
 *   ]);
 *
 * ============================================================================
 */

import { join } from "path";
import { homedir } from "os";
import { readdirSync, statSync, existsSync } from "fs";
import {
  type AgentOrchestrator,
  type AgentSpec,
  type AgentResult,
  createOrchestrator,
} from "../../../../lib/core/AgentOrchestrator";
import { notifySync } from "../../../../lib/core/NotificationService";

// ============================================================================
// Types
// ============================================================================

export type Tier = "daily" | "weekly" | "monthly";

export interface WorkflowTask {
  /** Skill name (e.g., 'InformationManager') */
  skill: string;
  /** Workflow name (e.g., 'Organize-ScratchPad') */
  workflow: string;
  /** Optional custom prompt override */
  customPrompt?: string;
  /** Timeout in ms (default: 120000) */
  timeout?: number;
}

export interface TierExecutionConfig {
  /** Groups of workflows to run in parallel */
  parallelGroups: WorkflowTask[][];
  /** Whether to announce results via voice */
  announceResults?: boolean;
  /** Maximum concurrent agents per group */
  maxConcurrent?: number;
  /** Default model for agents */
  defaultModel?: "haiku" | "sonnet" | "opus";
}

export interface TierExecutionResult {
  /** Whether all workflows succeeded */
  success: boolean;
  /** Total execution time in ms */
  durationMs: number;
  /** Results for each parallel group */
  groupResults: GroupResult[];
  /** Synthesized summary of all work */
  synthesis: string;
  /** Errors encountered */
  errors: string[];
}

export interface GroupResult {
  /** Group index */
  index: number;
  /** Whether this group succeeded */
  success: boolean;
  /** Agent results for this group */
  agentResults: AgentResult[];
  /** Synthesized result for this group */
  aggregated: string;
  /** Duration in ms */
  durationMs: number;
}

export interface TierExecutor {
  /** Execute a tier with the given configuration */
  execute(tier: Tier, config: TierExecutionConfig): Promise<TierExecutionResult>;
  /** Execute a single workflow */
  executeWorkflow(task: WorkflowTask): Promise<AgentResult>;
  /** Execute a parallel group of workflows */
  executeGroup(tasks: WorkflowTask[]): Promise<GroupResult>;
}

// ============================================================================
// Configuration
// ============================================================================

const KAYA_DIR = process.env.KAYA_DIR || join(homedir(), ".claude");

/** Obsidian vault path from config */
export function getObsidianVaultPath(): string {
  try {
    const configPath = join(KAYA_DIR, "skills/Productivity/InformationManager/config/obsidian.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(require("fs").readFileSync(configPath, "utf-8"));
      return config.vaultPath || join(homedir(), "Desktop/obsidian");
    }
  } catch {
    // Fall back to default
  }
  return join(homedir(), "Desktop/obsidian");
}

/** Get all folders in the Obsidian vault (excluding hidden/system folders) */
export function getObsidianFolders(): string[] {
  const vaultPath = getObsidianVaultPath();
  const folders: string[] = [];

  try {
    if (!existsSync(vaultPath)) {
      return folders;
    }

    const entries = readdirSync(vaultPath);
    for (const entry of entries) {
      if (entry.startsWith(".") || entry.startsWith("_")) {
        continue;
      }

      const fullPath = join(vaultPath, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          folders.push(entry);
        }
      } catch {
        // Skip if we can't stat the entry
      }
    }
  } catch (error) {
    console.warn(`Error reading Obsidian vault: ${error}`);
  }

  return folders.sort();
}

/** Generate folder refresh tasks for all Obsidian folders */
export function generateFolderRefreshTasks(): WorkflowTask[] {
  const folders = getObsidianFolders();
  return folders.map(folder => ({
    skill: "InformationManager",
    workflow: "Refresh-VaultFolder",
    customPrompt: `Refresh the Obsidian folder "${folder}":

1. Run the Refresh-VaultFolder workflow for the folder: ${folder}
2. Generate/update the _Context.md file in that folder
3. Return a brief summary of:
   - Number of notes in the folder
   - Key topics identified
   - Any orphan notes found

Be efficient and concise.`,
    timeout: 180000,
  }));
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Build a prompt for executing a skill workflow
 */
function buildWorkflowPrompt(task: WorkflowTask): string {
  if (task.customPrompt) {
    return task.customPrompt;
  }

  return `Execute the ${task.skill}/${task.workflow} workflow and return a summary of what was accomplished.

Instructions:
1. Run the workflow: /${task.skill} ${task.workflow}
2. Wait for completion
3. Return a structured summary including:
   - What was processed/updated
   - Any issues encountered
   - Key metrics (items processed, time taken, etc.)

Be thorough but concise. Return results in a format suitable for aggregation.`;
}

/**
 * Create a TierExecutor instance
 */
export function createTierExecutor(baseOptions?: {
  orchestrator?: AgentOrchestrator;
  defaultTimeout?: number;
}): TierExecutor {
  const orchestrator = baseOptions?.orchestrator || createOrchestrator({
    defaultModel: "sonnet",
    defaultTimeout: baseOptions?.defaultTimeout || 120000,
    announceResults: false,
  });

  return {
    async execute(tier: Tier, config: TierExecutionConfig): Promise<TierExecutionResult> {
      const startTime = Date.now();
      const errors: string[] = [];
      const groupResults: GroupResult[] = [];

      notifySync(`Starting ${tier} tier execution with ${config.parallelGroups.length} parallel groups`);

      for (let i = 0; i < config.parallelGroups.length; i++) {
        const group = config.parallelGroups[i];

        try {
          const groupResult = await this.executeGroup(group);
          groupResult.index = i;
          groupResults.push(groupResult);

          if (!groupResult.success) {
            const failedAgents = groupResult.agentResults
              .filter(r => !r.success)
              .map(r => r.agentName);
            errors.push(`Group ${i} partial failure: ${failedAgents.join(", ")}`);
          }
        } catch (error) {
          errors.push(`Group ${i} error: ${error instanceof Error ? error.message : String(error)}`);
          groupResults.push({
            index: i,
            success: false,
            agentResults: [],
            aggregated: `Error: ${error instanceof Error ? error.message : String(error)}`,
            durationMs: 0,
          });
        }
      }

      // Synthesize all group results
      let synthesis = "";
      if (groupResults.length > 0) {
        const successfulAggregations = groupResults
          .filter(g => g.aggregated && g.aggregated.length > 0)
          .map(g => g.aggregated);

        if (successfulAggregations.length > 0) {
          try {
            const { aggregated } = await orchestrator.spawnWithAggregation(
              [{ type: "Intern", count: 1 }],
              `Synthesize these workflow results into a cohesive summary:\n\n${successfulAggregations.join("\n\n---\n\n")}`,
              "synthesis",
              { announceResults: false }
            );
            synthesis = aggregated;
          } catch {
            synthesis = successfulAggregations.join("\n\n---\n\n");
          }
        }
      }

      const durationMs = Date.now() - startTime;
      const allSuccess = groupResults.every(g => g.success);

      if (allSuccess) {
        notifySync(`${tier} tier completed successfully in ${Math.round(durationMs / 1000)}s`);
      } else {
        notifySync(`${tier} tier completed with ${errors.length} errors`);
      }

      return {
        success: allSuccess,
        durationMs,
        groupResults,
        synthesis,
        errors,
      };
    },

    async executeWorkflow(task: WorkflowTask): Promise<AgentResult> {
      const prompt = buildWorkflowPrompt(task);
      const agentSpec: AgentSpec = {
        type: "Intern",
        name: `${task.skill}/${task.workflow}`,
        timeout: task.timeout || 120000,
      };

      const results = await orchestrator.spawn([agentSpec], prompt, {
        parallel: false,
        announceResults: false,
      });

      return results[0];
    },

    async executeGroup(tasks: WorkflowTask[]): Promise<GroupResult> {
      const startTime = Date.now();

      if (tasks.length === 0) {
        return {
          index: 0,
          success: true,
          agentResults: [],
          aggregated: "No tasks in group",
          durationMs: 0,
        };
      }

      const agents: AgentSpec[] = tasks.map(task => ({
        type: "Intern",
        name: `${task.skill}/${task.workflow}`,
        timeout: task.timeout || 120000,
      }));

      const combinedTask = tasks
        .map(task => `[${task.skill}/${task.workflow}]:\n${buildWorkflowPrompt(task)}`)
        .join("\n\n---\n\n");

      const { results, aggregated } = await orchestrator.spawnWithAggregation(
        agents,
        combinedTask,
        "synthesis",
        {
          parallel: true,
          maxConcurrent: 8,
          announceResults: false,
        }
      );

      const durationMs = Date.now() - startTime;
      const success = results.some(r => r.success);

      return {
        index: 0,
        success,
        agentResults: results,
        aggregated,
        durationMs,
      };
    },
  };
}

// Default executor instance
export const tierExecutor = createTierExecutor();
