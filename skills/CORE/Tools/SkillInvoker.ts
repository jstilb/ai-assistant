#!/usr/bin/env bun
/**
 * ============================================================================
 * SkillInvoker - Unified skill invocation with validation
 * ============================================================================
 *
 * PURPOSE:
 * Provides programmatic skill invocation for automated workflows with
 * skill-index.json validation for case correction and existence checking.
 *
 * USAGE:
 *   # CLI - invoke a skill
 *   bun run SkillInvoker.ts --skill System --args "integrity"
 *
 *   # CLI - check if skill exists
 *   bun run SkillInvoker.ts --exists System
 *
 *   # CLI - list all skills
 *   bun run SkillInvoker.ts --list
 *
 *   # Programmatic
 *   import { invokeSkill, invokeSkillAsync } from './SkillInvoker.ts';
 *   const result = await invokeSkill({ skill: 'System', args: 'integrity' });
 *
 * ============================================================================
 */

import { parseArgs } from "util";
import { spawn } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

// ============================================================================
// Types
// ============================================================================

export interface SkillInvocation {
  /** Skill name to invoke (e.g., 'System', 'SkillAudit') */
  skill: string;
  /** Arguments to pass to the skill */
  args?: string;
  /** Timeout in milliseconds (default: 300000 = 5 minutes) */
  timeout?: number;
  /** Working directory for execution */
  cwd?: string;
}

export interface SkillResult {
  /** Whether the skill completed successfully */
  success: boolean;
  /** Skill output (stdout) */
  output?: string;
  /** Error message if failed */
  error?: string;
  /** Exit code */
  exitCode?: number;
  /** Execution duration in milliseconds */
  durationMs: number;
}

interface SkillIndexEntry {
  name: string;
  path: string;
  fullDescription: string;
  triggers: string[];
  workflows: string[];
  tier: "always" | "deferred";
}

interface SkillIndex {
  generated: string;
  totalSkills: number;
  alwaysLoadedCount: number;
  deferredCount: number;
  skills: Record<string, SkillIndexEntry>;
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(homedir(), ".claude");
const INDEX_PATH = join(KAYA_HOME, "skills", "skill-index.json");
const DEFAULT_TIMEOUT = 300000; // 5 minutes

// ============================================================================
// Skill Index Functions
// ============================================================================

/**
 * Load the skill-index.json file
 * Returns null if index doesn't exist or can't be parsed
 */
function loadSkillIndex(): SkillIndex | null {
  try {
    if (!existsSync(INDEX_PATH)) {
      return null;
    }
    return JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Get the case-corrected skill name from the index
 * Returns the correct-case name if found, null if not found
 * Returns original name if no index exists (graceful fallback)
 */
export function getSkillCaseCorrected(name: string): string | null {
  const index = loadSkillIndex();
  if (!index) {
    // No index available - fallback: allow invocation with original name
    return name;
  }

  const key = name.toLowerCase();
  const entry = index.skills[key];
  return entry?.name ?? null;
}

/**
 * Check if a skill exists in the index
 */
export function skillExists(name: string): boolean {
  const corrected = getSkillCaseCorrected(name);
  return corrected !== null;
}

/**
 * List all skills in the index
 */
export function listSkills(): SkillIndexEntry[] {
  const index = loadSkillIndex();
  if (!index) {
    return [];
  }
  return Object.values(index.skills);
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Invoke a skill and wait for completion
 *
 * Validates skill exists in skill-index.json and uses correct case.
 * If no index exists, falls back to using the provided name as-is.
 */
export async function invokeSkill(
  invocation: SkillInvocation
): Promise<SkillResult> {
  const { skill, args, timeout = DEFAULT_TIMEOUT, cwd = KAYA_HOME } = invocation;
  const startTime = Date.now();

  // Validate and case-correct the skill name
  const correctedName = getSkillCaseCorrected(skill);
  if (!correctedName) {
    return {
      success: false,
      error: `Skill '${skill}' not found in skill-index.json. Run GenerateSkillIndex.ts to update.`,
      durationMs: Date.now() - startTime,
    };
  }

  // Build the prompt with corrected case
  const prompt = args ? `/${correctedName} ${args}` : `/${correctedName}`;

  return new Promise((resolve) => {
    // Build environment without ANTHROPIC_API_KEY to force subscription auth
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    // Use -p flag (not --print) for skill execution
    const cmdArgs = ["-p", "--model", "haiku", prompt];

    let stdout = "";
    let stderr = "";

    const proc = spawn("claude", cmdArgs, {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    // Handle timeout
    const timeoutId = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({
        success: false,
        error: `Skill invocation timed out after ${timeout}ms`,
        durationMs: Date.now() - startTime,
      });
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;

      if (code !== 0 && !stdout) {
        resolve({
          success: false,
          error: stderr || `Skill exited with code ${code}`,
          exitCode: code ?? undefined,
          durationMs,
        });
        return;
      }

      resolve({
        success: true,
        output: stdout.trim(),
        exitCode: code ?? 0,
        durationMs,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      resolve({
        success: false,
        error: err.message,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

/**
 * Invoke a skill without waiting (fire and forget)
 */
export function invokeSkillAsync(invocation: SkillInvocation): void {
  invokeSkill(invocation).catch(() => {
    // Silent fail for async invocations
  });
}

/**
 * Invoke multiple skills in sequence
 * Stops on first failure
 */
export async function invokeSkillsSequential(
  invocations: SkillInvocation[]
): Promise<SkillResult[]> {
  const results: SkillResult[] = [];

  for (const invocation of invocations) {
    const result = await invokeSkill(invocation);
    results.push(result);

    // Stop on first failure
    if (!result.success) {
      break;
    }
  }

  return results;
}

/**
 * Invoke multiple skills in parallel with chunked concurrency
 */
export async function invokeSkillsParallel(
  invocations: SkillInvocation[],
  maxConcurrent: number = 3
): Promise<SkillResult[]> {
  const results: SkillResult[] = new Array(invocations.length);

  // Process in chunks
  for (let i = 0; i < invocations.length; i += maxConcurrent) {
    const chunk = invocations.slice(i, i + maxConcurrent);
    const chunkResults = await Promise.all(
      chunk.map((inv) => invokeSkill(inv))
    );

    chunkResults.forEach((result, j) => {
      results[i + j] = result;
    });
  }

  return results;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      skill: { type: "string", short: "s" },
      args: { type: "string", short: "a" },
      timeout: { type: "string", short: "t" },
      exists: { type: "string", short: "e" },
      list: { type: "boolean", short: "l" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
SkillInvoker - Unified skill invocation with validation

USAGE:
  bun run SkillInvoker.ts --skill <name> [options]
  bun run SkillInvoker.ts --exists <name>
  bun run SkillInvoker.ts --list

OPTIONS:
  -s, --skill <name>     Skill name to invoke
  -a, --args <args>      Arguments to pass to the skill
  -t, --timeout <ms>     Timeout in milliseconds (default: 300000)
  -e, --exists <name>    Check if a skill exists (returns 0 if exists, 1 if not)
  -l, --list             List all available skills
  -h, --help             Show this help message

EXAMPLES:
  # Invoke System skill integrity check
  bun run SkillInvoker.ts --skill System --args "integrity"

  # Check if a skill exists (case-insensitive)
  bun run SkillInvoker.ts --exists system
  bun run SkillInvoker.ts --exists FakeSkill

  # List all skills
  bun run SkillInvoker.ts --list

PROGRAMMATIC USAGE:
  import { invokeSkill, skillExists } from './SkillInvoker.ts';

  // Check existence
  if (skillExists('System')) {
    const result = await invokeSkill({
      skill: 'System',
      args: 'integrity',
      timeout: 300000,
    });
  }

NOTES:
  - Skill names are case-corrected automatically using skill-index.json
  - If skill-index.json doesn't exist, falls back to using provided name
  - Run GenerateSkillIndex.ts to update the skill index after adding skills
`);
    return;
  }

  // Handle --list
  if (values.list) {
    const skills = listSkills();
    if (skills.length === 0) {
      console.log(
        "No skills found. Run GenerateSkillIndex.ts to generate the index."
      );
      process.exit(1);
    }

    console.log(`Available skills (${skills.length}):\n`);
    for (const skill of skills.sort((a, b) => a.name.localeCompare(b.name))) {
      const tier = skill.tier === "always" ? "🔒" : "📦";
      const workflows = skill.workflows.length
        ? `(${skill.workflows.length} workflows)`
        : "";
      console.log(`  ${tier} ${skill.name} ${workflows}`);
    }
    return;
  }

  // Handle --exists
  if (values.exists) {
    const corrected = getSkillCaseCorrected(values.exists);
    if (corrected) {
      console.log(`✅ Skill exists: ${corrected}`);
      if (corrected !== values.exists) {
        console.log(`   (case-corrected from: ${values.exists})`);
      }
      process.exit(0);
    } else {
      console.log(`❌ Skill not found: ${values.exists}`);
      process.exit(1);
    }
  }

  // Handle --skill invocation
  if (!values.skill) {
    console.error("Error: --skill, --exists, or --list is required");
    console.error("Use --help for usage information");
    process.exit(1);
  }

  const result = await invokeSkill({
    skill: values.skill,
    args: values.args,
    timeout: values.timeout ? parseInt(values.timeout, 10) : DEFAULT_TIMEOUT,
  });

  if (result.success) {
    console.log(result.output);
    console.error(`\n[SkillInvoker] Completed in ${result.durationMs}ms`);
  } else {
    console.error(`[SkillInvoker] Failed: ${result.error}`);
    process.exit(1);
  }
}

// Run CLI if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
