#!/usr/bin/env bun
/**
 * ============================================================================
 * ErrorLogger.ts - Structured error logging for AutoInfoManager
 * ============================================================================
 *
 * PURPOSE:
 * Provides structured error logging to JSONL files with recovery tracking
 * and error aggregation capabilities.
 *
 * USAGE:
 *   import { logError, getRecentErrors, getErrorStats } from './ErrorLogger';
 *
 *   await logError({
 *     tier: 'daily',
 *     step: 'ProcessScratchPad',
 *     error: 'Connection timeout',
 *     recoveryAttempted: true,
 *     recoverySucceeded: false,
 *   });
 *
 *   const errors = await getRecentErrors(7); // Last 7 days
 *
 * ============================================================================
 */

import { join } from "path";
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";

// ============================================================================
// Types
// ============================================================================

export type Tier = "daily" | "weekly" | "monthly";

export interface ErrorEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Workflow tier */
  tier: Tier;
  /** Step that failed */
  step: string;
  /** Error message */
  error: string;
  /** Full stack trace (optional) */
  stack?: string;
  /** Whether recovery was attempted */
  recoveryAttempted: boolean;
  /** Whether recovery succeeded */
  recoverySucceeded: boolean;
  /** Additional context */
  context?: Record<string, unknown>;
}

export interface LogErrorOptions {
  tier: Tier;
  step: string;
  error: string;
  stack?: string;
  recoveryAttempted: boolean;
  recoverySucceeded: boolean;
  context?: Record<string, unknown>;
}

export interface ErrorStats {
  /** Total errors */
  total: number;
  /** Errors by tier */
  byTier: Record<Tier, number>;
  /** Errors by step */
  byStep: Record<string, number>;
  /** Recovery success rate */
  recoveryRate: number;
  /** Errors in last 24h */
  last24h: number;
  /** Errors in last 7 days */
  last7d: number;
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_DIR = process.env.KAYA_DIR || join(homedir(), ".claude");
const ERRORS_DIR = join(KAYA_DIR, "MEMORY/AUTOINFO/errors");

// ============================================================================
// Implementation
// ============================================================================

/**
 * Ensure errors directory exists
 */
function ensureDir(): void {
  if (!existsSync(ERRORS_DIR)) {
    mkdirSync(ERRORS_DIR, { recursive: true });
  }
}

/**
 * Get the error log file path for a given date
 */
function getLogPath(date: Date = new Date()): string {
  const dateStr = date.toISOString().split("T")[0];
  return join(ERRORS_DIR, `${dateStr}.jsonl`);
}

/**
 * Log an error entry
 */
export async function logError(options: LogErrorOptions): Promise<void> {
  ensureDir();

  const entry: ErrorEntry = {
    timestamp: new Date().toISOString(),
    tier: options.tier,
    step: options.step,
    error: options.error,
    stack: options.stack,
    recoveryAttempted: options.recoveryAttempted,
    recoverySucceeded: options.recoverySucceeded,
    context: options.context,
  };

  const logPath = getLogPath();
  const line = JSON.stringify(entry) + "\n";

  appendFileSync(logPath, line);
}

/**
 * Get errors from a specific date
 */
export function getErrorsForDate(date: Date): ErrorEntry[] {
  const logPath = getLogPath(date);

  if (!existsSync(logPath)) {
    return [];
  }

  const content = readFileSync(logPath, "utf-8");
  const lines = content.split("\n").filter(l => l.trim());

  return lines.map(line => {
    try {
      return JSON.parse(line) as ErrorEntry;
    } catch {
      return null;
    }
  }).filter((e): e is ErrorEntry => e !== null);
}

/**
 * Get recent errors from the last N days
 */
export function getRecentErrors(days: number = 7): ErrorEntry[] {
  ensureDir();

  const errors: ErrorEntry[] = [];
  const now = Date.now();
  const threshold = days * 24 * 60 * 60 * 1000;

  const files = readdirSync(ERRORS_DIR)
    .filter(f => f.endsWith(".jsonl"))
    .sort()
    .reverse();

  for (const file of files) {
    const datePart = file.replace(".jsonl", "");
    const fileDate = new Date(datePart);

    if (now - fileDate.getTime() > threshold) {
      break; // Stop reading older files
    }

    const filePath = join(ERRORS_DIR, file);
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ErrorEntry;
        errors.push(entry);
      } catch {
        // Skip malformed lines
      }
    }
  }

  // Sort by timestamp descending
  errors.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return errors;
}

/**
 * Get error statistics
 */
export function getErrorStats(days: number = 30): ErrorStats {
  const errors = getRecentErrors(days);

  const stats: ErrorStats = {
    total: errors.length,
    byTier: { daily: 0, weekly: 0, monthly: 0 },
    byStep: {},
    recoveryRate: 0,
    last24h: 0,
    last7d: 0,
  };

  if (errors.length === 0) {
    return stats;
  }

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  let recoveryAttempts = 0;
  let recoverySuccesses = 0;

  for (const error of errors) {
    // By tier
    stats.byTier[error.tier]++;

    // By step
    stats.byStep[error.step] = (stats.byStep[error.step] || 0) + 1;

    // Recovery tracking
    if (error.recoveryAttempted) {
      recoveryAttempts++;
      if (error.recoverySucceeded) {
        recoverySuccesses++;
      }
    }

    // Time-based
    const errorTime = new Date(error.timestamp).getTime();
    if (now - errorTime < day) {
      stats.last24h++;
    }
    if (now - errorTime < 7 * day) {
      stats.last7d++;
    }
  }

  stats.recoveryRate = recoveryAttempts > 0
    ? Math.round((recoverySuccesses / recoveryAttempts) * 100)
    : 0;

  return stats;
}

/**
 * Get errors for a specific tier
 */
export function getErrorsByTier(tier: Tier, days: number = 7): ErrorEntry[] {
  return getRecentErrors(days).filter(e => e.tier === tier);
}

/**
 * Get errors for a specific step
 */
export function getErrorsByStep(step: string, days: number = 7): ErrorEntry[] {
  return getRecentErrors(days).filter(e => e.step === step);
}

/**
 * Check if a step has recurring errors
 */
export function hasRecurringErrors(step: string, threshold: number = 3, days: number = 7): boolean {
  const errors = getErrorsByStep(step, days);
  return errors.length >= threshold;
}

/**
 * Format errors for display
 */
export function formatErrors(errors: ErrorEntry[]): string {
  if (errors.length === 0) {
    return "No errors found.";
  }

  const lines: string[] = [];

  for (const error of errors) {
    const date = new Date(error.timestamp);
    const dateStr = date.toLocaleDateString();
    const timeStr = date.toLocaleTimeString();
    const recovered = error.recoverySucceeded ? "(recovered)" : error.recoveryAttempted ? "(recovery failed)" : "";

    lines.push(`${dateStr} ${timeStr}: ${error.tier}/${error.step} - ${error.error} ${recovered}`);
  }

  return lines.join("\n");
}

// ============================================================================
// CLI Interface
// ============================================================================

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
ErrorLogger - View and manage AutoInfoManager errors

USAGE:
  bun ErrorLogger.ts [command] [options]

COMMANDS:
  list              List recent errors (default)
  stats             Show error statistics
  test              Log a test error

OPTIONS:
  --days <n>        Number of days to look back (default: 7)
  --tier <tier>     Filter by tier (daily, weekly, monthly)
  --step <step>     Filter by step name
  --json            Output as JSON
  --help, -h        Show this help

EXAMPLES:
  bun ErrorLogger.ts list --days 7
  bun ErrorLogger.ts stats
  bun ErrorLogger.ts list --tier daily
`);
    return;
  }

  const command = args[0] || "list";
  const daysIndex = args.indexOf("--days");
  const days = daysIndex !== -1 ? parseInt(args[daysIndex + 1]) : 7;
  const tierIndex = args.indexOf("--tier");
  const tier = tierIndex !== -1 ? args[tierIndex + 1] as Tier : undefined;
  const stepIndex = args.indexOf("--step");
  const step = stepIndex !== -1 ? args[stepIndex + 1] : undefined;
  const jsonOutput = args.includes("--json");

  switch (command) {
    case "list": {
      let errors = getRecentErrors(days);

      if (tier) {
        errors = errors.filter(e => e.tier === tier);
      }
      if (step) {
        errors = errors.filter(e => e.step === step);
      }

      if (jsonOutput) {
        console.log(JSON.stringify(errors, null, 2));
      } else {
        console.log(`\n=== Recent Errors (last ${days} days) ===\n`);
        console.log(formatErrors(errors));
      }
      break;
    }

    case "stats": {
      const stats = getErrorStats(days);

      if (jsonOutput) {
        console.log(JSON.stringify(stats, null, 2));
      } else {
        console.log(`\n=== Error Statistics (last ${days} days) ===\n`);
        console.log(`Total errors: ${stats.total}`);
        console.log(`Last 24h: ${stats.last24h}`);
        console.log(`Last 7 days: ${stats.last7d}`);
        console.log(`Recovery rate: ${stats.recoveryRate}%`);
        console.log(`\nBy tier:`);
        for (const [tier, count] of Object.entries(stats.byTier)) {
          if (count > 0) console.log(`  ${tier}: ${count}`);
        }
        console.log(`\nBy step:`);
        for (const [step, count] of Object.entries(stats.byStep)) {
          console.log(`  ${step}: ${count}`);
        }
      }
      break;
    }

    case "test": {
      await logError({
        tier: "daily",
        step: "TestStep",
        error: "This is a test error",
        recoveryAttempted: true,
        recoverySucceeded: false,
        context: { test: true },
      });
      console.log("Test error logged successfully.");
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
