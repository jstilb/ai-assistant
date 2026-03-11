#!/usr/bin/env bun
/**
 * CapabilityRouter.ts - Map capabilities to Task invocation specs
 *
 * Bridges CapabilitySelector output → concrete Task tool parameters.
 * Used by the orchestration workflow (Orchestrate.md) to determine how
 * each ISC row should be delegated: Task agent, ralph loop, or inline.
 *
 * Usage:
 *   bun run CapabilityRouter.ts --row "Implement auth middleware" --effort STANDARD --output json
 *   bun run CapabilityRouter.ts --capability "execution.engineer" --effort STANDARD --output json
 */

import { parseArgs } from "util";

// ============================================================================
// Types
// ============================================================================

type EffortLevel = "TRIVIAL" | "QUICK" | "STANDARD" | "THOROUGH" | "DETERMINED";

interface TaskInvocationSpec {
  /** Agent type for Task tool's subagent_type parameter */
  subagent_type: string;
  /** Model to use (sonnet, opus, haiku) */
  model: "sonnet" | "opus" | "haiku";
  /** How to execute: task (spawn agent), ralph_loop (bash loop), inline (current session) */
  executionMode: "task" | "ralph_loop" | "inline";
  /** Configuration for ralph_loop mode */
  ralphConfig?: {
    maxIterations: number;
    completionPromise: string;
    budgetLevel: string;
  };
  /** Reasoning for the routing decision */
  reasoning: string;
}

interface RoutingResult {
  row: string;
  effort: EffortLevel;
  capabilityName: string | null;
  capabilityCategory: string | null;
  invocation: TaskInvocationSpec;
}

// ============================================================================
// Constants
// ============================================================================

/** Default iteration limits by effort for ralph loops */
const RALPH_ITERATIONS: Record<EffortLevel, number> = {
  TRIVIAL: 1,
  QUICK: 3,
  STANDARD: 10,
  THOROUGH: 25,
  DETERMINED: 100,
};

// ============================================================================
// Capability → Invocation Mapping
// ============================================================================

/**
 * Static mapping from capability names to Task invocation specs.
 * CapabilitySelector returns capability.name (e.g. "engineer", "perplexity")
 * and capability.category (e.g. "execution", "research").
 */
const CAPABILITY_MAP: Record<string, Omit<TaskInvocationSpec, "reasoning" | "ralphConfig">> = {
  // Execution capabilities
  engineer:       { subagent_type: "Engineer",          model: "sonnet", executionMode: "task" },
  intern:         { subagent_type: "Intern",            model: "haiku",  executionMode: "task" },
  architect:      { subagent_type: "Architect",         model: "opus",   executionMode: "task" },
  qa_tester:      { subagent_type: "QATester",          model: "sonnet", executionMode: "task" },
  designer:       { subagent_type: "Designer",          model: "sonnet", executionMode: "task" },
  pentester:      { subagent_type: "Pentester",         model: "sonnet", executionMode: "task" },
  ralph_loop:     { subagent_type: "Engineer",          model: "sonnet", executionMode: "ralph_loop" },

  // Research capabilities
  perplexity:     { subagent_type: "ClaudeResearcher",  model: "sonnet", executionMode: "task" },
  gemini:         { subagent_type: "GeminiResearcher",  model: "sonnet", executionMode: "task" },
  grok:           { subagent_type: "GrokResearcher",    model: "sonnet", executionMode: "task" },
  claude:         { subagent_type: "ClaudeResearcher",  model: "sonnet", executionMode: "task" },
  codex:          { subagent_type: "CodexResearcher",   model: "sonnet", executionMode: "task" },

  // Thinking capabilities
  "deep thinking":  { subagent_type: "Intern",          model: "opus",   executionMode: "task" },
  tree_of_thought:  { subagent_type: "Architect",       model: "opus",   executionMode: "task" },
  plan_mode:        { subagent_type: "Architect",       model: "opus",   executionMode: "task" },

  // Debate capabilities
  council:        { subagent_type: "Intern",            model: "sonnet", executionMode: "task" },
  redteam:        { subagent_type: "Pentester",         model: "sonnet", executionMode: "task" },

  // Analysis capabilities
  first_principles: { subagent_type: "Intern",          model: "opus",   executionMode: "task" },
  science:          { subagent_type: "Intern",          model: "sonnet", executionMode: "task" },
};

/** Default invocation when no capability matches */
const DEFAULT_INVOCATION: Omit<TaskInvocationSpec, "reasoning" | "ralphConfig"> = {
  subagent_type: "Engineer",
  model: "sonnet",
  executionMode: "task",
};

// ============================================================================
// Core Logic
// ============================================================================

/**
 * Route an ISC row to a Task invocation spec.
 *
 * Strategy:
 * 1. If a capability name is provided directly, look it up in CAPABILITY_MAP
 * 2. Otherwise, call CapabilitySelector to determine the best capability
 * 3. Map the result to a TaskInvocationSpec
 * 4. For TRIVIAL effort, override to inline mode
 */
function routeCapability(
  row: string,
  effort: EffortLevel,
  capabilityName?: string,
): RoutingResult {
  let resolvedName: string | null = capabilityName || null;
  let resolvedCategory: string | null = null;
  let reasoning = "";

  // Step 1: Resolve capability via inline keyword matching if not provided
  if (!resolvedName) {
    const rowLower = row.toLowerCase();
    const KEYWORD_MAP: Record<string, string[]> = {
      perplexity:  ["web research", "current events", "citations", "sources", "articles"],
      gemini:      ["multiple perspectives", "parallel research", "comprehensive research"],
      grok:        ["contrarian", "fact-check", "unbiased", "critical analysis"],
      claude:      ["academic", "scholarly", "papers", "literature"],
      codex:       ["code pattern", "technical archaeology", "implementation patterns"],
      architect:   ["system design", "architecture", "high-level design"],
      engineer:    ["implement", "code", "build", "develop", "create", "write code"],
      qa_tester:   ["test", "quality", "validation", "verify"],
      designer:    ["ui", "ux", "user experience", "interface", "design"],
      pentester:   ["security", "vulnerability", "penetration", "pentest"],
      intern:      ["simple", "data gathering", "grunt work"],
      ralph_loop:  ["iterate until", "keep trying", "until tests pass", "until it works", "retry until", "loop until"],
    };

    let bestMatch: string | null = null;
    let bestScore = 0;
    for (const [capName, keywords] of Object.entries(KEYWORD_MAP)) {
      // Multi-word phrases score higher (more specific match)
      const score = keywords.reduce((sum, kw) => rowLower.includes(kw) ? sum + kw.split(/\s+/).length : sum, 0);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = capName;
        reasoning = `Matched keywords: ${keywords.filter(kw => rowLower.includes(kw)).join(", ")}`;
      }
    }
    if (bestMatch) {
      resolvedName = bestMatch;
      resolvedCategory = CAPABILITY_MAP[bestMatch] ? "mapped" : "default";
    }
  }

  // Step 2: Look up in static map
  const mapped = resolvedName ? CAPABILITY_MAP[resolvedName] : undefined;
  const invocationBase = mapped || DEFAULT_INVOCATION;

  // Step 3: Build full invocation spec
  const invocation: TaskInvocationSpec = {
    ...invocationBase,
    reasoning: reasoning || (mapped ? `Mapped from capability: ${resolvedName}` : "No capability match — using default Engineer agent"),
  };

  // Step 4: Add ralph config if ralph_loop mode
  if (invocation.executionMode === "ralph_loop") {
    invocation.ralphConfig = {
      maxIterations: RALPH_ITERATIONS[effort],
      completionPromise: "Task completed successfully",
      budgetLevel: effort,
    };
  }

  // Step 5: Override to inline for TRIVIAL effort
  if (effort === "TRIVIAL") {
    invocation.executionMode = "inline";
    invocation.reasoning += " (overridden to inline for TRIVIAL effort)";
  }

  return {
    row,
    effort,
    capabilityName: resolvedName,
    capabilityCategory: resolvedCategory,
    invocation,
  };
}

/**
 * Route multiple ISC rows at once.
 */
function routeMultiple(
  rows: Array<{ description: string; capability?: string }>,
  effort: EffortLevel,
): RoutingResult[] {
  return rows.map(row => routeCapability(row.description, effort, row.capability));
}

/**
 * Get the highest-priority invocation from a set of routing results.
 * Used to determine which agent type to spawn for a project group.
 *
 * Priority: opus > sonnet > haiku
 */
function getHighestPriorityInvocation(results: RoutingResult[]): TaskInvocationSpec | null {
  if (results.length === 0) return null;

  const MODEL_PRIORITY: Record<string, number> = { opus: 3, sonnet: 2, haiku: 1 };

  let highest = results[0].invocation;
  for (const result of results.slice(1)) {
    const currentPriority = MODEL_PRIORITY[result.invocation.model] || 0;
    const highestPriority = MODEL_PRIORITY[highest.model] || 0;
    if (currentPriority > highestPriority) {
      highest = result.invocation;
    }
  }

  return highest;
}

// ============================================================================
// CLI Interface
// ============================================================================

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      row: { type: "string", short: "r" },
      capability: { type: "string", short: "c" },
      effort: { type: "string", short: "e", default: "STANDARD" },
      output: { type: "string", short: "o", default: "text" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`
CapabilityRouter - Map capabilities to Task invocation specs

USAGE:
  bun run CapabilityRouter.ts --row "Implement auth middleware" --effort STANDARD
  bun run CapabilityRouter.ts --capability "engineer" --effort STANDARD
  bun run CapabilityRouter.ts --row "Research best practices" --effort THOROUGH --output json

OPTIONS:
  -r, --row <text>          ISC row description to route
  -c, --capability <name>   Capability name to route directly (skips CapabilitySelector)
  -e, --effort <level>      Effort level (default: STANDARD)
  -o, --output <fmt>        Output format: text (default), json
  -h, --help                Show this help

EXECUTION MODES:
  task        Spawn a Claude Code agent via Task tool
  ralph_loop  Generate loop infrastructure and run via Bash
  inline      Handle directly in current session (TRIVIAL only)

EXAMPLES:
  bun run CapabilityRouter.ts -r "Implement auth middleware" -e STANDARD
  # → { subagent_type: "Engineer", model: "sonnet", executionMode: "task" }

  bun run CapabilityRouter.ts -r "Research API best practices" -e THOROUGH
  # → { subagent_type: "ClaudeResearcher", model: "sonnet", executionMode: "task" }

  bun run CapabilityRouter.ts -c "ralph_loop" -e STANDARD
  # → { executionMode: "ralph_loop", ralphConfig: { maxIterations: 10 } }
`);
    return;
  }

  if (!values.row && !values.capability) {
    console.error("Error: --row or --capability is required");
    console.error("Use --help for usage information");
    process.exit(1);
  }

  const effort = (values.effort?.toUpperCase() || "STANDARD") as EffortLevel;
  const result = routeCapability(
    values.row || values.capability || "",
    effort,
    values.capability || undefined,
  );

  if (values.output === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`ROW: ${result.row}`);
    console.log(`EFFORT: ${result.effort}`);
    console.log(`CAPABILITY: ${result.capabilityName || "none"} (${result.capabilityCategory || "default"})`);
    console.log();
    console.log(`INVOCATION:`);
    console.log(`  Agent Type:      ${result.invocation.subagent_type}`);
    console.log(`  Model:           ${result.invocation.model}`);
    console.log(`  Execution Mode:  ${result.invocation.executionMode}`);
    if (result.invocation.ralphConfig) {
      console.log(`  Ralph Config:`);
      console.log(`    Max Iterations: ${result.invocation.ralphConfig.maxIterations}`);
      console.log(`    Completion:     ${result.invocation.ralphConfig.completionPromise}`);
      console.log(`    Budget Level:   ${result.invocation.ralphConfig.budgetLevel}`);
    }
    console.log(`  Reasoning:       ${result.invocation.reasoning}`);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}

// Exports for programmatic use
export {
  routeCapability,
  routeMultiple,
  getHighestPriorityInvocation,
  CAPABILITY_MAP,
  DEFAULT_INVOCATION,
  RALPH_ITERATIONS,
  type TaskInvocationSpec,
  type RoutingResult,
  type EffortLevel,
};
