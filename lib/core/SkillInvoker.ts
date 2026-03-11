#!/usr/bin/env bun
/**
 * ============================================================================
 * SkillInvoker - Unified skill invocation with filesystem-based validation
 * ============================================================================
 *
 * PURPOSE:
 * Provides programmatic skill invocation for automated workflows with
 * filesystem-based validation (scans skills/[name]/SKILL.md) for case correction
 * and existence checking. No index file required.
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
import { CLAUDE_PATH } from "./Inference.ts";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readdirSync } from "fs";

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

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(homedir(), ".claude");
const SKILLS_DIR = join(KAYA_HOME, "skills");
const DEFAULT_TIMEOUT = 300000; // 5 minutes

// ============================================================================
// Filesystem-Based Skill Discovery
// ============================================================================

/**
 * Build a map of lowercase skill name -> actual directory path (relative to SKILLS_DIR)
 * Scans two levels:
 *   Level 1: skills/[name]/SKILL.md — flat skills or category routers
 *   Level 2: skills/[category]/[name]/SKILL.md — nested sub-skills within categories
 *
 * Sub-skill entries are registered by their own name (e.g., "research" -> "Intelligence/Research")
 * so that invokeSkill({ skill: 'Research' }) correctly resolves to the nested path.
 *
 * If a sub-skill name conflicts with a top-level entry, the top-level entry wins (for backward compat).
 */
function buildSkillMap(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const topLevelSkillMd = join(SKILLS_DIR, entry.name, "SKILL.md");
      if (existsSync(topLevelSkillMd)) {
        // Register this entry (could be a flat skill or a category router)
        map.set(entry.name.toLowerCase(), entry.name);
      }

      // Also scan one level deeper for nested sub-skills within category directories
      try {
        const subEntries = readdirSync(join(SKILLS_DIR, entry.name), { withFileTypes: true });
        for (const subEntry of subEntries) {
          if (!subEntry.isDirectory()) continue;
          const subSkillMd = join(SKILLS_DIR, entry.name, subEntry.name, "SKILL.md");
          if (existsSync(subSkillMd)) {
            const subKey = subEntry.name.toLowerCase();
            // Only register sub-skill if not already registered at top level
            // (preserves backward compat for flat skills that weren't migrated)
            if (!map.has(subKey)) {
              map.set(subKey, join(entry.name, subEntry.name));
            }
          }
        }
      } catch {
        // Sub-directory scan failed — non-fatal
      }
    }
  } catch {
    // Skills directory doesn't exist or isn't readable
  }
  return map;
}

/**
 * Get the case-corrected skill name from the filesystem
 * Returns the correct-case name if found, null if not found
 */
export function getSkillCaseCorrected(name: string): string | null {
  const skillMap = buildSkillMap();
  return skillMap.get(name.toLowerCase()) ?? null;
}

/**
 * Check if a skill exists on the filesystem
 */
export function skillExists(name: string): boolean {
  const corrected = getSkillCaseCorrected(name);
  return corrected !== null;
}

/**
 * List all skill names discovered from the filesystem.
 * Returns leaf names for sub-skills (e.g., "Research" not "Intelligence/Research").
 * For top-level skills/categories, returns the directory name.
 */
export function listSkills(): string[] {
  const skillMap = buildSkillMap();
  const leafNames = new Set<string>();
  for (const [, path] of skillMap) {
    // For nested paths like "Intelligence/Research", use the leaf "Research"
    const leaf = path.includes("/") ? path.split("/").pop()! : path;
    leafNames.add(leaf);
  }
  return Array.from(leafNames).sort();
}

/**
 * Get the full relative path for a skill (e.g., "Intelligence/Research" for "Research").
 * Returns null if skill not found.
 */
export function getSkillPath(name: string): string | null {
  const skillMap = buildSkillMap();
  return skillMap.get(name.toLowerCase()) ?? null;
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
      error: `Skill '${skill}' not found. No skills/${skill}/SKILL.md exists.`,
      durationMs: Date.now() - startTime,
    };
  }

  // Build the prompt with corrected case.
  // For nested sub-skills (e.g., "Intelligence/Research"), use the base name
  // as the slash command since Claude Code's skill tool uses the leaf directory name.
  const leafName = correctedName.includes("/")
    ? correctedName.split("/").pop()!
    : correctedName;
  const prompt = args ? `/${leafName} ${args}` : `/${leafName}`;

  return new Promise((resolve) => {
    // Build environment without ANTHROPIC_API_KEY to force subscription auth
    // Also strip CLAUDECODE and CLAUDE_CODE_* vars to prevent nested-session detection
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDECODE;
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE_CODE_') && key !== 'CLAUDE_CODE_OAUTH_TOKEN') {
        delete env[key];
      }
    }

    // Use -p flag (not --print) for skill execution
    const cmdArgs = ["-p", "--model", "haiku", prompt];

    let stdout = "";
    let stderr = "";

    const proc = spawn(CLAUDE_PATH, cmdArgs, {
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
SkillInvoker - Unified skill invocation with filesystem-based validation

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
  - Discovers skills by scanning skills/[name]/SKILL.md on the filesystem
  - Skill names are case-corrected automatically
  - New skills are discovered immediately — no index regeneration required
`);
    return;
  }

  // Handle --list
  if (values.list) {
    const skills = listSkills();
    if (skills.length === 0) {
      console.log("No skills found in skills/ directory.");
      process.exit(1);
    }

    console.log(`Available skills (${skills.length}):\n`);
    for (const skill of skills) {
      console.log(`  ${skill}`);
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
