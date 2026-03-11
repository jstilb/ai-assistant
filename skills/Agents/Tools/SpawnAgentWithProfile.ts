#!/usr/bin/env bun

/**
 * Spawn Agent With Profile
 *
 * Helper utility to spawn agents with pre-loaded profile context.
 * Generates enriched prompts for the Task tool.
 */

import AgentContextLoader from "./LoadAgentContext";
import { z } from "zod";

const SpawnAgentOptionsSchema = z.object({
  agentType: z.string().min(1, "agentType is required").regex(
    /^[a-zA-Z0-9_-]+$/,
    "agentType must be alphanumeric (plus hyphens/underscores)",
  ),
  taskDescription: z.string().min(1, "taskDescription is required"),
  projectPath: z.string().optional(),
  model: z.enum(["opus", "sonnet", "haiku"]).optional(),
  runInBackground: z.boolean().optional(),
  description: z.string().optional(),
});

export interface SpawnAgentOptions {
  agentType: string;
  taskDescription: string;
  projectPath?: string;
  model?: "opus" | "sonnet" | "haiku";
  runInBackground?: boolean;
  description?: string;
}

export interface AgentPrompt {
  prompt: string;
  model: "opus" | "sonnet" | "haiku";
  description: string;
}

/**
 * Generate enriched prompt for spawning an agent with profile
 */
export async function generateAgentPrompt(
  options: SpawnAgentOptions
): Promise<AgentPrompt> {
  SpawnAgentOptionsSchema.parse(options);
  const loader = new AgentContextLoader();

  // Generate enriched prompt with task context
  const { prompt, model: profileModel } = loader.generateEnrichedPrompt(
    options.agentType,
    options.taskDescription
  );

  // Use provided model or fall back to profile's preference
  const model = options.model || profileModel || "sonnet";

  // Generate description if not provided
  const description =
    options.description ||
    `${options.agentType}: ${options.taskDescription.substring(0, 50)}...`;

  return {
    prompt,
    model,
    description,
  };
}

// CLI usage
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log("Usage: SpawnAgentWithProfile.ts <agentType> <taskDescription> [projectPath]");
    console.log("\nExample:");
    console.log('  bun run SpawnAgentWithProfile.ts Architect "Design REST API" ~/Projects/MyApp');
    console.log("\nAvailable agents:");
    const loader = new AgentContextLoader();
    const agents = loader.getAvailableAgents();
    agents.forEach((a) => console.log(`  - ${a}`));
    process.exit(1);
  }

  const [agentType, taskDescription, projectPath] = args;

  try {
    const prompt = await generateAgentPrompt({
      agentType,
      taskDescription,
      projectPath,
    });

    console.log("\n=== Agent Spawn Configuration ===\n");
    console.log(`Agent Type: ${agentType}`);
    console.log(`Model: ${prompt.model}`);
    console.log(`Description: ${prompt.description}`);
    console.log("\n=== Enriched Prompt (ready for Task tool) ===\n");
    console.log(prompt.prompt);
  } catch (error) {
    console.error(`Error generating prompt: ${error}`);
    process.exit(1);
  }
}

export default { generateAgentPrompt };
