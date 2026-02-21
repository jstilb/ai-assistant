#!/usr/bin/env bun
/**
 * BudgetTracker.ts - Budget tracking with Claude CLI usage integration
 *
 * Tracks actual API spend from Claude CLI output to enforce budget limits
 * during Ralph loops. Prevents cost overruns by pulling real usage data
 * rather than estimating.
 *
 * Usage:
 *   bun run BudgetTracker.ts --init STANDARD          # Initialize with STANDARD budget ($10)
 *   bun run BudgetTracker.ts --add-spend 0.15         # Record spend from iteration
 *   bun run BudgetTracker.ts --check                  # Check if budget allows continuation
 *   bun run BudgetTracker.ts --status                 # Show current budget status
 *   bun run BudgetTracker.ts --parse-session <file>   # Parse Claude session output for cost
 *
 * Budget Levels:
 *   QUICK      - $1    (quick fixes, simple iterations)
 *   STANDARD   - $10   (typical development tasks)
 *   THOROUGH   - $50   (comprehensive implementations)
 *   DETERMINED - $200  (large-scale refactors, migrations)
 */

import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { createStateManager } from "../../CORE/Tools/StateManager.ts";

// Budget level definitions
const BUDGET_LEVELS = {
  QUICK: 1,
  STANDARD: 10,
  THOROUGH: 50,
  DETERMINED: 200,
} as const;

type BudgetLevel = keyof typeof BUDGET_LEVELS;

// Zod schemas for type-safe state management
const SpendHistoryEntrySchema = z.object({
  iteration: z.number(),
  amount: z.number(),
  timestamp: z.string(),
  source: z.string(),
});

const BudgetStateSchema = z.object({
  level: z.enum(["QUICK", "STANDARD", "THOROUGH", "DETERMINED", "CUSTOM"]),
  totalBudget: z.number(),
  spent: z.number(),
  remaining: z.number(),
  hardStop: z.number(),
  iterations: z.number(),
  startedAt: z.string(),
  lastUpdated: z.string(),
  spendHistory: z.array(SpendHistoryEntrySchema),
  status: z.enum(["ACTIVE", "PAUSED", "STOPPED", "COMPLETED"]),
  source: z.literal("claude-cli"),
});

type BudgetState = z.infer<typeof BudgetStateSchema>;

interface ParsedCost {
  inputTokens?: number;
  outputTokens?: number;
  totalCost?: number;
  model?: string;
}

const STATE_FILE = join(process.cwd(), ".ralph-budget.json");

// Initialize StateManager with auto-backup enabled for budget safety
const budgetManager = createStateManager({
  path: STATE_FILE,
  schema: BudgetStateSchema,
  defaults: () => ({
    level: "STANDARD" as const,
    totalBudget: 10,
    spent: 0,
    remaining: 10,
    hardStop: 95,
    iterations: 0,
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    spendHistory: [],
    status: "ACTIVE" as const,
    source: "claude-cli" as const,
  }),
  version: 1,
  backupOnWrite: true, // Critical: backup before updating budget
});

/**
 * Initialize a new budget tracking session
 */
async function initBudget(level: BudgetLevel | number): Promise<BudgetState> {
  const totalBudget =
    typeof level === "number"
      ? level
      : BUDGET_LEVELS[level] || BUDGET_LEVELS.STANDARD;
  const levelName =
    typeof level === "string" ? level : findLevelName(totalBudget);

  const state: BudgetState = {
    level: levelName as BudgetLevel | "CUSTOM",
    totalBudget,
    spent: 0,
    remaining: totalBudget,
    hardStop: 95, // Stop at 95% of budget by default
    iterations: 0,
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    spendHistory: [],
    status: "ACTIVE",
    source: "claude-cli",
  };

  await budgetManager.save(state);
  return state;
}

/**
 * Find budget level name from amount
 */
function findLevelName(amount: number): string {
  for (const [name, value] of Object.entries(BUDGET_LEVELS)) {
    if (value === amount) return name;
  }
  return "CUSTOM";
}

/**
 * Load current budget state
 */
async function loadState(): Promise<BudgetState | null> {
  if (!(await budgetManager.exists())) return null;
  try {
    return await budgetManager.load();
  } catch {
    return null;
  }
}

/**
 * Record spend from an iteration
 * Uses atomic update for budget safety
 */
async function addSpend(
  amount: number,
  source: string = "manual"
): Promise<{ allowed: boolean; state: BudgetState; message: string }> {
  const state = await loadState();
  if (!state) {
    const newState = await initBudget("STANDARD");
    return {
      allowed: false,
      state: newState,
      message: "No active budget session. Initialized with STANDARD budget.",
    };
  }

  // Use atomic update for budget safety with auto-rollback on error
  const updatedState = await budgetManager.update((s) => {
    s.spent += amount;
    s.remaining = s.totalBudget - s.spent;
    s.iterations += 1;
    s.lastUpdated = new Date().toISOString();
    s.spendHistory.push({
      iteration: s.iterations,
      amount,
      timestamp: new Date().toISOString(),
      source,
    });

    const percentUsed = (s.spent / s.totalBudget) * 100;

    // Check hard stop threshold
    if (percentUsed >= s.hardStop) {
      s.status = "STOPPED";
    }

    return s;
  });

  const percentUsed = (updatedState.spent / updatedState.totalBudget) * 100;

  // Check hard stop threshold
  if (percentUsed >= updatedState.hardStop) {
    return {
      allowed: false,
      state: updatedState,
      message: `HARD STOP: Budget ${percentUsed.toFixed(1)}% consumed ($${updatedState.spent.toFixed(2)}/$${updatedState.totalBudget}). Loop terminated.`,
    };
  }

  // Warning at 75% and 90%
  let message = `Iteration ${updatedState.iterations}: $${amount.toFixed(4)} spent. Total: $${updatedState.spent.toFixed(2)}/$${updatedState.totalBudget} (${percentUsed.toFixed(1)}%)`;
  if (percentUsed >= 90) {
    message += " WARNING: 90% budget consumed!";
  } else if (percentUsed >= 75) {
    message += " CAUTION: 75% budget consumed.";
  }

  return { allowed: true, state: updatedState, message };
}

/**
 * Check if budget allows continuation
 */
async function checkBudget(): Promise<{
  allowed: boolean;
  state: BudgetState | null;
  message: string;
}> {
  const state = await loadState();
  if (!state) {
    return {
      allowed: true,
      state: null,
      message: "No budget tracking active. Consider initializing with --init.",
    };
  }

  const percentUsed = (state.spent / state.totalBudget) * 100;

  if (state.status === "STOPPED") {
    return {
      allowed: false,
      state,
      message: `Budget tracking STOPPED. Spent: $${state.spent.toFixed(2)}/$${state.totalBudget}`,
    };
  }

  if (percentUsed >= state.hardStop) {
    return {
      allowed: false,
      state,
      message: `Budget exhausted (${percentUsed.toFixed(1)}%). Cannot continue.`,
    };
  }

  return {
    allowed: true,
    state,
    message: `Budget OK: $${state.remaining.toFixed(2)} remaining (${(100 - percentUsed).toFixed(1)}%)`,
  };
}

/**
 * Parse Claude CLI session output for cost information
 *
 * Claude CLI outputs cost info in various formats:
 * - Stream JSON: {"type":"result","cost":{"input_tokens":1234,"output_tokens":567,"total_cost":0.0123}}
 * - Summary: "Session cost: $0.0123"
 * - Token counts in verbose mode
 */
function parseSessionOutput(content: string): ParsedCost {
  const result: ParsedCost = {};

  // Try to parse stream-json format
  const lines = content.split("\n");
  for (const line of lines) {
    try {
      const json = JSON.parse(line);
      if (json.type === "result" && json.cost) {
        result.inputTokens = json.cost.input_tokens;
        result.outputTokens = json.cost.output_tokens;
        result.totalCost = json.cost.total_cost;
        break;
      }
      // Alternative format
      if (json.usage) {
        result.inputTokens = json.usage.input_tokens;
        result.outputTokens = json.usage.output_tokens;
      }
      if (json.cost !== undefined && typeof json.cost === "number") {
        result.totalCost = json.cost;
      }
    } catch {
      // Not JSON, try regex patterns
    }
  }

  // Fallback: regex patterns for text output
  if (result.totalCost === undefined) {
    // Match "Session cost: $0.0123" or "Cost: $0.0123" or "cost: 0.0123"
    const costMatch = content.match(
      /(?:session\s+)?cost[:\s]+\$?(\d+\.?\d*)/i
    );
    if (costMatch) {
      result.totalCost = parseFloat(costMatch[1]);
    }
  }

  // Parse token counts if available
  if (result.inputTokens === undefined) {
    const inputMatch = content.match(/input[_\s]?tokens[:\s]+(\d+)/i);
    if (inputMatch) {
      result.inputTokens = parseInt(inputMatch[1]);
    }
  }

  if (result.outputTokens === undefined) {
    const outputMatch = content.match(/output[_\s]?tokens[:\s]+(\d+)/i);
    if (outputMatch) {
      result.outputTokens = parseInt(outputMatch[1]);
    }
  }

  // Estimate cost from tokens if we have them but no cost
  // Using Sonnet pricing: $3/MTok input, $15/MTok output
  if (
    result.totalCost === undefined &&
    result.inputTokens &&
    result.outputTokens
  ) {
    result.totalCost =
      (result.inputTokens / 1_000_000) * 3 +
      (result.outputTokens / 1_000_000) * 15;
  }

  return result;
}

/**
 * Get formatted status display
 */
async function getStatus(): Promise<string> {
  const state = await loadState();
  if (!state) {
    return "No active budget tracking session.";
  }

  const percentUsed = (state.spent / state.totalBudget) * 100;
  const avgPerIteration =
    state.iterations > 0 ? state.spent / state.iterations : 0;
  const estimatedRemaining =
    avgPerIteration > 0
      ? Math.floor(state.remaining / avgPerIteration)
      : "unknown";

  return `
========================================
RALPH LOOP BUDGET STATUS
========================================
Level:           ${state.level} ($${state.totalBudget})
Status:          ${state.status}
Spent:           $${state.spent.toFixed(4)} (${percentUsed.toFixed(1)}%)
Remaining:       $${state.remaining.toFixed(4)}
Hard Stop At:    ${state.hardStop}%
Iterations:      ${state.iterations}
Avg/Iteration:   $${avgPerIteration.toFixed(4)}
Est. Remaining:  ${estimatedRemaining} iterations
Started:         ${state.startedAt}
Last Updated:    ${state.lastUpdated}
========================================
`;
}

/**
 * Reset/complete budget tracking
 */
async function resetBudget(): Promise<void> {
  const state = await loadState();
  if (state) {
    await budgetManager.update((s) => {
      s.status = "COMPLETED";
      return s;
    });
  }
}

// CLI handling
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
BudgetTracker - Ralph Loop Budget Management

Commands:
  --init <LEVEL>           Initialize budget (QUICK|STANDARD|THOROUGH|DETERMINED or dollar amount)
  --add-spend <amount>     Record spend from iteration
  --check                  Check if budget allows continuation (exit 0=yes, 1=no)
  --status                 Show current budget status
  --parse-session <file>   Parse Claude session output for cost
  --reset                  Mark budget tracking as complete

Budget Levels:
  QUICK      $1     Quick fixes, simple iterations
  STANDARD   $10    Typical development tasks
  THOROUGH   $50    Comprehensive implementations
  DETERMINED $200   Large-scale refactors

Examples:
  bun run BudgetTracker.ts --init STANDARD
  bun run BudgetTracker.ts --add-spend 0.15
  bun run BudgetTracker.ts --check && ./loop.sh 1
  bun run BudgetTracker.ts --parse-session iteration-1.log
`);
  process.exit(0);
}

if (args[0] === "--init") {
  const levelArg = args[1]?.toUpperCase() || "STANDARD";
  const level = BUDGET_LEVELS[levelArg as BudgetLevel]
    ? (levelArg as BudgetLevel)
    : parseFloat(args[1]) || "STANDARD";
  const state = await initBudget(level as BudgetLevel | number);
  console.log(
    `Budget initialized: $${state.totalBudget} (${state.level} level)`
  );
  process.exit(0);
}

if (args[0] === "--add-spend") {
  const amount = parseFloat(args[1]);
  if (isNaN(amount)) {
    console.error("Error: Invalid spend amount");
    process.exit(1);
  }
  const source = args[2] || "manual";
  const result = await addSpend(amount, source);
  console.log(result.message);
  process.exit(result.allowed ? 0 : 1);
}

if (args[0] === "--check") {
  const result = await checkBudget();
  console.log(result.message);
  process.exit(result.allowed ? 0 : 1);
}

if (args[0] === "--status") {
  console.log(await getStatus());
  process.exit(0);
}

if (args[0] === "--parse-session") {
  const file = args[1];
  if (!file) {
    console.error("Error: No file specified");
    process.exit(1);
  }
  try {
    const content = readFileSync(file, "utf-8");
    const parsed = parseSessionOutput(content);
    console.log(JSON.stringify(parsed, null, 2));
    if (parsed.totalCost !== undefined) {
      // Auto-add to budget if tracking is active
      const state = await loadState();
      if (state && state.status === "ACTIVE") {
        const result = await addSpend(parsed.totalCost, `parsed:${file}`);
        console.log(result.message);
        process.exit(result.allowed ? 0 : 1);
      }
    }
  } catch (e) {
    console.error(`Error reading file: ${e}`);
    process.exit(1);
  }
  process.exit(0);
}

if (args[0] === "--reset") {
  await resetBudget();
  console.log("Budget tracking completed/reset.");
  process.exit(0);
}

// Default: show status
console.log(await getStatus());
