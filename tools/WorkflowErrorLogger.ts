#!/usr/bin/env bun
/**
 * ============================================================================
 * WorkflowErrorLogger - Capture and log workflow errors
 * ============================================================================
 *
 * PURPOSE:
 * Captures workflow errors and appends them to a centralized log file.
 * Called by WorkflowExecutor when a workflow fails or has errors.
 *
 * USAGE:
 *   # Direct invocation (by WorkflowExecutor)
 *   bun run WorkflowErrorLogger.ts --workflow "AutoMaintenance-daily" --step "integrity-check" --error "Path not found"
 *
 *   # Via stdin (JSON format)
 *   echo '{"workflow":"AutoMaintenance-daily","step":"integrity-check","errors":["Error 1","Error 2"]}' | bun run WorkflowErrorLogger.ts
 *
 * OUTPUT:
 *   Appends to: MEMORY/WORKFLOWS/errors.jsonl
 *
 * ============================================================================
 */

import { existsSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parseArgs } from "util";

// ============================================================================
// Types
// ============================================================================

interface WorkflowError {
  timestamp: string;
  workflow: string;
  step: string;
  error: string;
}

interface WorkflowErrorEvent {
  workflow?: string;
  workflowName?: string;
  step?: string;
  failedStep?: string;
  error?: string;
  errors?: string[];
  skillName?: string;
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(homedir(), ".claude");
const LOG_DIR = join(KAYA_HOME, "MEMORY", "WORKFLOWS");
const ERROR_LOG_PATH = join(LOG_DIR, "errors.jsonl");

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Ensure log directory exists
 */
function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * Log a workflow error
 */
function logWorkflowError(workflow: string, step: string, error: string): void {
  ensureLogDir();

  const entry: WorkflowError = {
    timestamp: new Date().toISOString(),
    workflow,
    step,
    error,
  };

  appendFileSync(ERROR_LOG_PATH, JSON.stringify(entry) + "\n");
}

/**
 * Process workflow error event
 */
function processErrorEvent(event: WorkflowErrorEvent): void {
  const workflowName = event.workflow || event.workflowName || "unknown";
  const step = event.step || event.failedStep || "unknown";

  // Handle single error
  if (event.error) {
    logWorkflowError(workflowName, step, event.error);
  }

  // Handle multiple errors
  if (event.errors && Array.isArray(event.errors)) {
    for (const error of event.errors) {
      logWorkflowError(workflowName, step, error);
    }
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      workflow: { type: "string", short: "w" },
      step: { type: "string", short: "s" },
      error: { type: "string", short: "e" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
WorkflowErrorLogger - Capture and log workflow errors

USAGE:
  bun run WorkflowErrorLogger.ts [options]
  echo '<json>' | bun run WorkflowErrorLogger.ts

OPTIONS:
  -w, --workflow <name>  Workflow name
  -s, --step <step>      Step that failed
  -e, --error <message>  Error message
  -h, --help             Show this help

EXAMPLES:
  # Log a single error
  bun run WorkflowErrorLogger.ts --workflow "AutoMaintenance-daily" --step "integrity-check" --error "Path not found"

  # Log via stdin
  echo '{"workflow":"AutoMaintenance-daily","step":"integrity-check","error":"Path not found"}' | bun run WorkflowErrorLogger.ts
`);
    return;
  }

  // Check for CLI args
  if (values.workflow && values.step && values.error) {
    logWorkflowError(values.workflow, values.step, values.error);
    console.log(`Logged error for ${values.workflow}:${values.step}`);
    return;
  }

  // Check for stdin (from hook system or piped input)
  const stdin = await Bun.stdin.text();
  if (stdin.trim()) {
    try {
      const event = JSON.parse(stdin) as WorkflowErrorEvent;
      processErrorEvent(event);
      console.log(`Logged ${event.errors?.length || 1} error(s)`);
    } catch {
      // Not JSON - might be raw error text
      const workflow = values.workflow || "unknown";
      const step = values.step || "unknown";
      logWorkflowError(workflow, step, stdin.trim());
      console.log(`Logged raw error for ${workflow}:${step}`);
    }
    return;
  }

  console.error("No error data provided. Use --help for usage.");
  process.exit(1);
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
