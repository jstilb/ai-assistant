#!/usr/bin/env bun
/**
 * BudgetManager.ts - Dual-scope budget management
 *
 * Manages both per-item budgets (effort-based) AND total queue budgets.
 * Warning thresholds at 75%, 90%, 95% (hard stop).
 * Iteration limits enforced per effort level.
 *
 * Usage:
 *   bun run BudgetManager.ts init --total 100                # Initialize queue budget
 *   bun run BudgetManager.ts item-init <id> --effort STANDARD # Initialize item budget
 *   bun run BudgetManager.ts spend <id> --amount 0.15        # Record spend for item
 *   bun run BudgetManager.ts check <id>                      # Check if item can continue
 *   bun run BudgetManager.ts check --queue                   # Check if queue can continue
 *   bun run BudgetManager.ts status                          # Show all budget status
 */

import { parseArgs } from "util";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { z } from "zod";
import type { EffortLevel } from "./WorkQueue.ts";

// ============================================================================
// Types
// ============================================================================

type BudgetStatus = "ok" | "yellow_warning" | "red_warning" | "hard_stop" | "exhausted";

/**
 * Per-item budget state
 */
interface ItemBudget {
  itemId: string;
  effort: EffortLevel;
  allocated: number;
  spent: number;
  /** Budget spent specifically on skeptical verification (Tier 2 + Tier 3) */
  verificationSpent: number;
  /** Max verification budget (10% of allocated) */
  verificationBudget: number;
  iterations: number;
  maxIterations: number;
  status: BudgetStatus;
  lastUpdated: string;
}

/**
 * Queue-level budget state
 */
interface QueueBudget {
  total: number;
  spent: number;
  status: BudgetStatus;
  itemBudgets: Record<string, ItemBudget>;
  warningThresholds: {
    yellow: number;  // 75%
    red: number;     // 90%
    hardStop: number; // 95%
  };
  startedAt: string;
  lastUpdated: string;
}

/**
 * Spend result
 */
interface SpendResult {
  allowed: boolean;
  status: BudgetStatus;
  message: string;
  remaining: {
    item?: number;
    queue: number;
  };
  percentUsed: {
    item?: number;
    queue: number;
  };
}

// ============================================================================
// Zod Schemas
// ============================================================================

const ItemBudgetSchema = z.object({
  itemId: z.string(),
  effort: z.enum(["TRIVIAL", "QUICK", "STANDARD", "THOROUGH", "DETERMINED"]),
  allocated: z.number(),
  spent: z.number(),
  verificationSpent: z.number().default(0),
  verificationBudget: z.number().default(0),
  iterations: z.number(),
  maxIterations: z.number(),
  status: z.enum(["ok", "yellow_warning", "red_warning", "hard_stop", "exhausted"]),
  lastUpdated: z.string(),
});

const QueueBudgetSchema = z.object({
  total: z.number(),
  spent: z.number(),
  status: z.enum(["ok", "yellow_warning", "red_warning", "hard_stop", "exhausted"]),
  itemBudgets: z.record(ItemBudgetSchema),
  warningThresholds: z.object({
    yellow: z.number(),
    red: z.number(),
    hardStop: z.number(),
  }),
  startedAt: z.string(),
  lastUpdated: z.string(),
});

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(process.env.HOME || "", ".claude");
const BUDGET_STATE_PATH = join(KAYA_HOME, "MEMORY/WORK/budget-state.json");

// Budget allocation by effort level (in dollars)
const EFFORT_BUDGETS: Record<EffortLevel, number> = {
  TRIVIAL: 0.1,
  QUICK: 1,
  STANDARD: 10,
  THOROUGH: 50,
  DETERMINED: 200,
};

// Iteration limits by effort level
const ITERATION_LIMITS: Record<EffortLevel, number> = {
  TRIVIAL: 1,
  QUICK: 3,
  STANDARD: 10,
  THOROUGH: 25,
  DETERMINED: 100,
};

// Default thresholds (percentages)
const DEFAULT_THRESHOLDS = {
  yellow: 0.75,   // 75%
  red: 0.90,      // 90%
  hardStop: 0.95, // 95%
};

// ============================================================================
// BudgetManager Class
// ============================================================================

export class BudgetManager {
  private state: QueueBudget;
  private statePath: string;

  constructor(statePath: string = BUDGET_STATE_PATH) {
    this.statePath = statePath;
    this.state = this.loadState();
  }

  // --------------------------------------------------------------------------
  // State Management
  // --------------------------------------------------------------------------

  private loadState(): QueueBudget {
    if (!existsSync(this.statePath)) {
      return this.createDefaultState();
    }

    try {
      const content = readFileSync(this.statePath, "utf-8");
      return QueueBudgetSchema.parse(JSON.parse(content));
    } catch {
      return this.createDefaultState();
    }
  }

  private createDefaultState(): QueueBudget {
    return {
      total: 100, // Default $100 queue budget
      spent: 0,
      status: "ok",
      itemBudgets: {},
      warningThresholds: DEFAULT_THRESHOLDS,
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };
  }

  private saveState(): void {
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.state.lastUpdated = new Date().toISOString();
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  /**
   * Initialize queue budget
   */
  initQueue(total: number, thresholds?: Partial<typeof DEFAULT_THRESHOLDS>): void {
    this.state.total = total;
    this.state.spent = 0;
    this.state.status = "ok";
    this.state.itemBudgets = {};
    this.state.startedAt = new Date().toISOString();

    if (thresholds) {
      this.state.warningThresholds = {
        ...DEFAULT_THRESHOLDS,
        ...thresholds,
      };
    }

    this.saveState();
  }

  /**
   * Initialize item budget
   */
  initItem(itemId: string, effort: EffortLevel): ItemBudget {
    const allocated = EFFORT_BUDGETS[effort];
    const maxIterations = ITERATION_LIMITS[effort];

    const verificationBudget = allocated * 0.10; // 10% of item allocation for verification
    const itemBudget: ItemBudget = {
      itemId,
      effort,
      allocated,
      spent: 0,
      verificationSpent: 0,
      verificationBudget,
      iterations: 0,
      maxIterations,
      status: "ok",
      lastUpdated: new Date().toISOString(),
    };

    this.state.itemBudgets[itemId] = itemBudget;
    this.saveState();

    return itemBudget;
  }

  // --------------------------------------------------------------------------
  // Budget Checking
  // --------------------------------------------------------------------------

  /**
   * Calculate status from percentage used
   */
  private calculateStatus(percentUsed: number): BudgetStatus {
    const { yellow, red, hardStop } = this.state.warningThresholds;

    if (percentUsed >= 1.0) return "exhausted";
    if (percentUsed >= hardStop) return "hard_stop";
    if (percentUsed >= red) return "red_warning";
    if (percentUsed >= yellow) return "yellow_warning";
    return "ok";
  }

  /**
   * Check if item can continue
   */
  checkItem(itemId: string): SpendResult {
    const itemBudget = this.state.itemBudgets[itemId];

    if (!itemBudget) {
      return {
        allowed: false,
        status: "exhausted",
        message: `Item ${itemId} has no budget initialized`,
        remaining: { queue: this.state.total - this.state.spent },
        percentUsed: { queue: this.state.spent / this.state.total },
      };
    }

    const itemPercentUsed = itemBudget.spent / itemBudget.allocated;
    const queuePercentUsed = this.state.spent / this.state.total;

    const itemStatus = this.calculateStatus(itemPercentUsed);
    const queueStatus = this.calculateStatus(queuePercentUsed);

    // Check iteration limit
    if (itemBudget.iterations >= itemBudget.maxIterations) {
      return {
        allowed: false,
        status: "hard_stop",
        message: `Item ${itemId} reached iteration limit (${itemBudget.iterations}/${itemBudget.maxIterations})`,
        remaining: {
          item: itemBudget.allocated - itemBudget.spent,
          queue: this.state.total - this.state.spent,
        },
        percentUsed: {
          item: itemPercentUsed * 100,
          queue: queuePercentUsed * 100,
        },
      };
    }

    // Use the more restrictive status
    const effectiveStatus = this.moreRestrictive(itemStatus, queueStatus);
    const allowed = effectiveStatus !== "hard_stop" && effectiveStatus !== "exhausted";

    let message = `Item budget: $${itemBudget.spent.toFixed(2)}/$${itemBudget.allocated} (${(itemPercentUsed * 100).toFixed(1)}%), `;
    message += `Queue: $${this.state.spent.toFixed(2)}/$${this.state.total} (${(queuePercentUsed * 100).toFixed(1)}%)`;

    if (effectiveStatus === "yellow_warning") {
      message += " - CAUTION: 75% budget consumed";
    } else if (effectiveStatus === "red_warning") {
      message += " - WARNING: 90% budget consumed!";
    } else if (effectiveStatus === "hard_stop") {
      message += " - HARD STOP: 95% budget exhausted";
    }

    return {
      allowed,
      status: effectiveStatus,
      message,
      remaining: {
        item: itemBudget.allocated - itemBudget.spent,
        queue: this.state.total - this.state.spent,
      },
      percentUsed: {
        item: itemPercentUsed * 100,
        queue: queuePercentUsed * 100,
      },
    };
  }

  /**
   * Check if queue can continue (overall)
   */
  checkQueue(): SpendResult {
    const queuePercentUsed = this.state.spent / this.state.total;
    const status = this.calculateStatus(queuePercentUsed);
    const allowed = status !== "hard_stop" && status !== "exhausted";

    let message = `Queue: $${this.state.spent.toFixed(2)}/$${this.state.total} (${(queuePercentUsed * 100).toFixed(1)}%)`;

    if (status === "yellow_warning") {
      message += " - CAUTION: 75% budget consumed";
    } else if (status === "red_warning") {
      message += " - WARNING: 90% budget consumed!";
    } else if (status === "hard_stop") {
      message += " - HARD STOP: 95% budget exhausted";
    }

    return {
      allowed,
      status,
      message,
      remaining: {
        queue: this.state.total - this.state.spent,
      },
      percentUsed: {
        queue: queuePercentUsed * 100,
      },
    };
  }

  /**
   * Get the more restrictive of two statuses
   */
  private moreRestrictive(a: BudgetStatus, b: BudgetStatus): BudgetStatus {
    const order: BudgetStatus[] = ["ok", "yellow_warning", "red_warning", "hard_stop", "exhausted"];
    return order.indexOf(a) > order.indexOf(b) ? a : b;
  }

  // --------------------------------------------------------------------------
  // Spending
  // --------------------------------------------------------------------------

  /**
   * Record spend for an item
   */
  spend(itemId: string, amount: number): SpendResult {
    let itemBudget = this.state.itemBudgets[itemId];

    // Auto-initialize with STANDARD if not found
    if (!itemBudget) {
      itemBudget = this.initItem(itemId, "STANDARD");
    }

    // Check before spending
    const preCheck = this.checkItem(itemId);
    if (!preCheck.allowed) {
      return preCheck;
    }

    // Record spend
    itemBudget.spent += amount;
    itemBudget.iterations++;
    itemBudget.lastUpdated = new Date().toISOString();

    // Update queue total
    this.state.spent += amount;

    // Recalculate statuses
    const itemPercentUsed = itemBudget.spent / itemBudget.allocated;
    const queuePercentUsed = this.state.spent / this.state.total;

    itemBudget.status = this.calculateStatus(itemPercentUsed);
    this.state.status = this.calculateStatus(queuePercentUsed);

    this.saveState();

    // Return updated check
    return this.checkItem(itemId);
  }

  /**
   * Record verification spend for an item (separate from execution budget).
   * Verification budget is 10% of item allocation and does not count against execution budget.
   * Returns whether the spend was allowed (within verification budget cap).
   */
  spendVerification(itemId: string, amount: number): { allowed: boolean; verificationRemaining: number } {
    let itemBudget = this.state.itemBudgets[itemId];
    if (!itemBudget) {
      itemBudget = this.initItem(itemId, "STANDARD");
    }

    const newTotal = itemBudget.verificationSpent + amount;
    if (newTotal > itemBudget.verificationBudget) {
      return {
        allowed: false,
        verificationRemaining: Math.max(0, itemBudget.verificationBudget - itemBudget.verificationSpent),
      };
    }

    itemBudget.verificationSpent = newTotal;
    itemBudget.lastUpdated = new Date().toISOString();

    // Verification spend also counts toward queue total (but not item execution budget)
    this.state.spent += amount;
    this.state.status = this.calculateStatus(this.state.spent / this.state.total);

    this.saveState();
    return {
      allowed: true,
      verificationRemaining: itemBudget.verificationBudget - newTotal,
    };
  }

  /**
   * Record iteration without specific cost (for tracking)
   */
  recordIteration(itemId: string): void {
    let itemBudget = this.state.itemBudgets[itemId];

    if (!itemBudget) {
      itemBudget = this.initItem(itemId, "STANDARD");
    }

    itemBudget.iterations++;
    itemBudget.lastUpdated = new Date().toISOString();
    this.saveState();
  }

  // --------------------------------------------------------------------------
  // Budget Info
  // --------------------------------------------------------------------------

  /**
   * Get budget for an effort level
   */
  getEffortBudget(effort: EffortLevel): { budget: number; iterations: number } {
    return {
      budget: EFFORT_BUDGETS[effort],
      iterations: ITERATION_LIMITS[effort],
    };
  }

  /**
   * Get item budget
   */
  getItemBudget(itemId: string): ItemBudget | null {
    return this.state.itemBudgets[itemId] || null;
  }

  /**
   * Get total queue spend
   */
  getQueueSpent(): number {
    return this.state.spent;
  }

  /**
   * Get queue state
   */
  getQueueState(): QueueBudget {
    return { ...this.state };
  }

  /**
   * Calculate estimated iterations remaining
   */
  getEstimatedRemaining(itemId: string): { iterations: number; dollars: number } {
    const itemBudget = this.state.itemBudgets[itemId];

    if (!itemBudget || itemBudget.iterations === 0) {
      return { iterations: 0, dollars: 0 };
    }

    const avgCostPerIteration = itemBudget.spent / itemBudget.iterations;
    const itemRemaining = itemBudget.allocated - itemBudget.spent;
    const queueRemaining = this.state.total - this.state.spent;

    const limitingRemaining = Math.min(itemRemaining, queueRemaining);
    const iterationsFromBudget = avgCostPerIteration > 0
      ? Math.floor(limitingRemaining / avgCostPerIteration)
      : 0;

    const iterationsFromLimit = itemBudget.maxIterations - itemBudget.iterations;

    return {
      iterations: Math.min(iterationsFromBudget, iterationsFromLimit),
      dollars: limitingRemaining,
    };
  }

  // --------------------------------------------------------------------------
  // Formatting
  // --------------------------------------------------------------------------

  formatStatus(): string {
    const queuePercentUsed = (this.state.spent / this.state.total) * 100;
    const itemCount = Object.keys(this.state.itemBudgets).length;

    let output = `
═══════════════════════════════════════════════════════════
BUDGET STATUS
═══════════════════════════════════════════════════════════
Queue Budget:
  Total:          $${this.state.total.toFixed(2)}
  Spent:          $${this.state.spent.toFixed(2)} (${queuePercentUsed.toFixed(1)}%)
  Remaining:      $${(this.state.total - this.state.spent).toFixed(2)}
  Status:         ${this.state.status.toUpperCase()}

Thresholds:
  Yellow Warning: ${(this.state.warningThresholds.yellow * 100).toFixed(0)}%
  Red Warning:    ${(this.state.warningThresholds.red * 100).toFixed(0)}%
  Hard Stop:      ${(this.state.warningThresholds.hardStop * 100).toFixed(0)}%

Items (${itemCount}):
`;

    for (const [id, budget] of Object.entries(this.state.itemBudgets)) {
      const percentUsed = (budget.spent / budget.allocated) * 100;
      const statusEmoji = {
        ok: "✅",
        yellow_warning: "⚠️",
        red_warning: "🔴",
        hard_stop: "🛑",
        exhausted: "💀",
      }[budget.status];

      output += `  ${statusEmoji} ${id} [${budget.effort}]\n`;
      output += `     $${budget.spent.toFixed(2)}/$${budget.allocated} (${percentUsed.toFixed(1)}%) `;
      output += `| ${budget.iterations}/${budget.maxIterations} iter`;
      if (budget.verificationSpent > 0) {
        output += ` | verify: $${budget.verificationSpent.toFixed(2)}/$${budget.verificationBudget.toFixed(2)}`;
      }
      output += `\n`;
    }

    output += `
Started:          ${this.state.startedAt}
Last Updated:     ${this.state.lastUpdated}
═══════════════════════════════════════════════════════════`;

    return output;
  }
}

// ============================================================================
// CLI Interface
// ============================================================================

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      output: { type: "string", short: "o", default: "text" },
      total: { type: "string" },
      effort: { type: "string", short: "e" },
      amount: { type: "string", short: "a" },
      queue: { type: "boolean", short: "q" },
      yellow: { type: "string" },
      red: { type: "string" },
      stop: { type: "string" },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
BudgetManager - Dual-scope budget management

Commands:
  init                    Initialize queue budget
  item-init <id>          Initialize item budget
  spend <id>              Record spend for item
  check <id>              Check if item can continue
  check --queue           Check if queue can continue
  estimate <id>           Estimate remaining iterations
  status                  Show all budget status
  reset                   Reset all budgets

Options:
  --total <n>             Queue total budget in dollars (default: 100)
  -e, --effort <level>    Effort level: TRIVIAL, QUICK, STANDARD, THOROUGH, DETERMINED
  -a, --amount <n>        Spend amount in dollars
  -q, --queue             Check queue-level budget
  --yellow <n>            Yellow warning threshold (0-1, default: 0.75)
  --red <n>               Red warning threshold (0-1, default: 0.90)
  --stop <n>              Hard stop threshold (0-1, default: 0.95)
  -o, --output <fmt>      Output format: text (default), json
  -h, --help              Show this help

Budget Levels by Effort:
  TRIVIAL     $0.10,   1 iteration
  QUICK       $1.00,   3 iterations
  STANDARD    $10.00,  10 iterations
  THOROUGH    $50.00,  25 iterations
  DETERMINED  $200.00, 100 iterations

Examples:
  bun run BudgetManager.ts init --total 200
  bun run BudgetManager.ts item-init abc123 --effort STANDARD
  bun run BudgetManager.ts spend abc123 --amount 0.15
  bun run BudgetManager.ts check abc123
  bun run BudgetManager.ts check --queue
  bun run BudgetManager.ts status
`);
    return;
  }

  const manager = new BudgetManager();
  const command = positionals[0];

  switch (command) {
    case "init": {
      const total = parseFloat(values.total || "100");
      const thresholds: Partial<typeof DEFAULT_THRESHOLDS> = {};
      if (values.yellow) thresholds.yellow = parseFloat(values.yellow);
      if (values.red) thresholds.red = parseFloat(values.red);
      if (values.stop) thresholds.hardStop = parseFloat(values.stop);

      manager.initQueue(total, thresholds);
      console.log(`Queue budget initialized: $${total}`);
      break;
    }

    case "item-init": {
      const itemId = positionals[1];
      if (!itemId) {
        console.error("Error: item-id required");
        process.exit(1);
      }

      const effort = (values.effort?.toUpperCase() || "STANDARD") as EffortLevel;
      const budget = manager.initItem(itemId, effort);

      if (values.output === "json") {
        console.log(JSON.stringify(budget, null, 2));
      } else {
        console.log(`Item budget initialized: ${itemId}`);
        console.log(`  Effort: ${budget.effort}`);
        console.log(`  Budget: $${budget.allocated}`);
        console.log(`  Max iterations: ${budget.maxIterations}`);
      }
      break;
    }

    case "spend": {
      const itemId = positionals[1];
      if (!itemId) {
        console.error("Error: item-id required");
        process.exit(1);
      }

      const amount = parseFloat(values.amount || "0");
      if (amount <= 0) {
        console.error("Error: --amount must be positive");
        process.exit(1);
      }

      const result = manager.spend(itemId, amount);

      if (values.output === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result.message);
      }

      process.exit(result.allowed ? 0 : 1);
      break;
    }

    case "check": {
      if (values.queue) {
        const result = manager.checkQueue();
        if (values.output === "json") {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result.message);
        }
        process.exit(result.allowed ? 0 : 1);
      } else {
        const itemId = positionals[1];
        if (!itemId) {
          console.error("Error: item-id required (or use --queue)");
          process.exit(1);
        }

        const result = manager.checkItem(itemId);
        if (values.output === "json") {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result.message);
        }
        process.exit(result.allowed ? 0 : 1);
      }
      break;
    }

    case "estimate": {
      const itemId = positionals[1];
      if (!itemId) {
        console.error("Error: item-id required");
        process.exit(1);
      }

      const estimate = manager.getEstimatedRemaining(itemId);
      if (values.output === "json") {
        console.log(JSON.stringify(estimate, null, 2));
      } else {
        console.log(`Estimated remaining for ${itemId}:`);
        console.log(`  Iterations: ${estimate.iterations}`);
        console.log(`  Budget: $${estimate.dollars.toFixed(2)}`);
      }
      break;
    }

    case "status": {
      if (values.output === "json") {
        console.log(JSON.stringify(manager.getQueueState(), null, 2));
      } else {
        console.log(manager.formatStatus());
      }
      break;
    }

    case "reset": {
      manager.initQueue(100);
      console.log("Budget reset to defaults.");
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Use --help for usage.");
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}

// Additional exports for programmatic use (BudgetManager exported inline via `export class`)
export { EFFORT_BUDGETS, ITERATION_LIMITS, DEFAULT_THRESHOLDS };
