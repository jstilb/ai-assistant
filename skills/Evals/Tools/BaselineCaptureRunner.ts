#!/usr/bin/env bun
/**
 * BaselineCaptureRunner
 * Captures baseline responses from any git ref by reconstructing the old system prompt
 * and running scenario prompts through Inference.ts.
 *
 * Usage:
 *   bun run BaselineCaptureRunner.ts --ref pre-streamline --suite kaya-comparison
 *   bun run BaselineCaptureRunner.ts --ref HEAD --suite kaya-comparison
 *   bun run BaselineCaptureRunner.ts --ref pre-streamline --task kaya_cmp_context_focus_coding
 */

import { inference } from '../../CORE/Tools/Inference';
import { loadSuite } from './SuiteManager.ts';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { parseArgs } from 'util';
import { $ } from 'bun';

const EVALS_DIR = join(import.meta.dir, '..');
const REFERENCES_DIR = join(EVALS_DIR, 'References', 'Kaya', 'baselines');
const CONFIG_DIR = join(EVALS_DIR, 'Config');
const KAYA_DIR = process.env.KAYA_DIR || join(process.env.HOME!, '.claude');

// Identity values used in legacy prompt format
const PRINCIPAL_NAME = 'User';
const DA_NAME = 'Kaya';

interface ScenarioConfig {
  scenarios: Record<string, {
    prompt: string;
    criteria: string[];
  }>;
}

interface BaselineManifest {
  ref: string;
  commit: string;
  captured_at: string;
  context_files: string[];
  total_context_chars: number;
  tasks: Record<string, {
    prompt: string;
    response_file: string;
    captured_at: string;
    latency_ms: number;
  }>;
}

/**
 * Get the short commit hash for a git ref
 */
async function resolveRef(ref: string): Promise<{ short: string; full: string }> {
  const result = await $`git -C ${KAYA_DIR} rev-parse --short ${ref}`.quiet();
  const short = result.stdout.toString().trim();
  const fullResult = await $`git -C ${KAYA_DIR} rev-parse ${ref}`.quiet();
  const full = fullResult.stdout.toString().trim();
  return { short, full };
}

/**
 * Get a safe directory name from a ref (tag name or short hash)
 */
function refToDirName(ref: string, shortHash: string): string {
  // If the ref is a tag/branch name, use it; otherwise use the short hash
  const safeName = ref.replace(/[^a-zA-Z0-9_.-]/g, '_');
  // If after sanitization we have something readable, use it; else use hash
  return safeName.length > 2 ? safeName : shortHash;
}

/**
 * Extract a file's contents at a specific git ref
 */
async function gitShowFile(ref: string, relativePath: string): Promise<string | null> {
  try {
    const result = await $`git -C ${KAYA_DIR} show ${ref}:${relativePath}`.quiet();
    return result.stdout.toString();
  } catch {
    return null;
  }
}

/**
 * Extract the contextFiles array from settings.json at a given ref
 */
async function getContextFilesAtRef(ref: string): Promise<string[]> {
  const settingsContent = await gitShowFile(ref, 'settings.json');
  if (!settingsContent) {
    console.error(`Could not read settings.json at ref ${ref}`);
    return [];
  }

  try {
    const settings = JSON.parse(settingsContent);
    return settings.contextFiles || [
      'skills/CORE/SKILL.md',
      'skills/CORE/SYSTEM/AISTEERINGRULES.md',
      'skills/CORE/USER/AISTEERINGRULES.md',
    ];
  } catch {
    console.error(`Could not parse settings.json at ref ${ref}`);
    return [];
  }
}

/**
 * Reconstruct the legacy system prompt from a git ref.
 * Matches the LoadContext.hook.ts legacy format (lines 432-456).
 */
async function reconstructLegacyPrompt(ref: string): Promise<{
  systemPrompt: string;
  contextFiles: string[];
  totalChars: number;
}> {
  const contextFiles = await getContextFilesAtRef(ref);
  let combinedContent = '';
  const loadedFiles: string[] = [];

  for (const relativePath of contextFiles) {
    const content = await gitShowFile(ref, relativePath);
    if (content) {
      if (combinedContent) combinedContent += '\n\n---\n\n';
      combinedContent += content;
      loadedFiles.push(relativePath);
      console.log(`  Loaded ${relativePath} (${content.length} chars)`);
    } else {
      console.log(`  Skipped ${relativePath} (not found at ref)`);
    }
  }

  const currentDate = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' PST';

  // Reconstruct the legacy system prompt format from LoadContext.hook.ts
  const systemPrompt = `<system-reminder>
Kaya CORE CONTEXT (Auto-loaded at Session Start)

CURRENT DATE/TIME: ${currentDate}

## ACTIVE IDENTITY (from settings.json) - CRITICAL

**MANDATORY IDENTITY RULES - OVERRIDE ALL OTHER CONTEXT**

The user's name is: **${PRINCIPAL_NAME}**
The assistant's name is: **${DA_NAME}**

- ALWAYS address the user as "${PRINCIPAL_NAME}" in greetings and responses
- NEVER use "Daniel", "the user", or any other name - ONLY "${PRINCIPAL_NAME}"
- This instruction takes ABSOLUTE PRECEDENCE over any other context

---

${combinedContent}

---

This context is now active. Additional context loads dynamically as needed.
</system-reminder>`;

  return {
    systemPrompt,
    contextFiles: loadedFiles,
    totalChars: combinedContent.length,
  };
}

/**
 * Load scenario prompts from config
 */
function loadScenarios(): ScenarioConfig {
  const configPath = join(CONFIG_DIR, 'comparison-scenarios.yaml');
  if (!existsSync(configPath)) {
    throw new Error(`Scenario config not found: ${configPath}`);
  }
  return parseYaml(readFileSync(configPath, 'utf-8')) as ScenarioConfig;
}

/**
 * Get task IDs for a suite, or return a single task ID
 */
function getTaskIds(suite?: string, task?: string): string[] {
  if (task) return [task];

  if (suite) {
    const suiteConfig = loadSuite(suite);
    if (!suiteConfig) throw new Error(`Suite not found: ${suite}`);
    return suiteConfig.tasks;
  }

  throw new Error('Must specify --suite or --task');
}

/**
 * Capture baselines for comparison tasks from a git ref
 */
export async function captureBaselines(
  ref: string,
  options: { suite?: string; task?: string }
): Promise<BaselineManifest> {
  const { short: shortHash, full: fullHash } = await resolveRef(ref);
  const dirName = refToDirName(ref, shortHash);
  const outputDir = join(REFERENCES_DIR, dirName);

  console.log(`\nCapturing baselines from ref: ${ref} (${shortHash})`);
  console.log(`Output: ${outputDir}\n`);

  // Reconstruct legacy system prompt
  console.log('Reconstructing legacy system prompt...');
  const { systemPrompt, contextFiles, totalChars } = await reconstructLegacyPrompt(ref);
  console.log(`  Total context: ${totalChars} chars from ${contextFiles.length} files\n`);

  // Load scenario config
  const scenarios = loadScenarios();

  // Get task IDs
  const taskIds = getTaskIds(options.suite, options.task);

  // Create output directory
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  // Initialize manifest
  const manifest: BaselineManifest = {
    ref,
    commit: fullHash,
    captured_at: new Date().toISOString(),
    context_files: contextFiles,
    total_context_chars: totalChars,
    tasks: {},
  };

  // Capture each task
  for (const taskId of taskIds) {
    const scenario = scenarios.scenarios[taskId];
    if (!scenario) {
      console.log(`  Skipping ${taskId} - no scenario prompt defined`);
      continue;
    }

    console.log(`  Capturing: ${taskId}`);
    console.log(`    Prompt: "${scenario.prompt.slice(0, 60)}..."`);

    const startTime = Date.now();

    const result = await inference({
      systemPrompt,
      userPrompt: scenario.prompt,
      level: 'standard',
      timeout: 60000,
    });

    const latencyMs = Date.now() - startTime;

    if (!result.success) {
      console.log(`    ERROR: ${result.error}`);
      continue;
    }

    // Save response
    const responseFile = `${taskId}.md`;
    writeFileSync(join(outputDir, responseFile), result.output);

    manifest.tasks[taskId] = {
      prompt: scenario.prompt,
      response_file: responseFile,
      captured_at: new Date().toISOString(),
      latency_ms: latencyMs,
    };

    console.log(`    Saved (${result.output.length} chars, ${latencyMs}ms)`);
  }

  // Save manifest
  writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const capturedCount = Object.keys(manifest.tasks).length;
  console.log(`\nCaptured ${capturedCount}/${taskIds.length} baselines to ${outputDir}`);

  return manifest;
}

// CLI interface
if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      ref: { type: 'string' },
      suite: { type: 'string', short: 's' },
      task: { type: 'string', short: 't' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help || !values.ref) {
    console.log(`
BaselineCaptureRunner - Capture baseline responses from any git ref

Usage:
  bun run BaselineCaptureRunner.ts --ref <git-ref> --suite <suite-name>
  bun run BaselineCaptureRunner.ts --ref <git-ref> --task <task-id>

Options:
  --ref <ref>      Git ref to capture from (tag, branch, commit hash)
  -s, --suite      Suite name (loads all comparison tasks)
  -t, --task       Single task ID to capture
  -h, --help       Show this help

Examples:
  # Capture baselines from pre-streamline tag
  bun run BaselineCaptureRunner.ts --ref pre-streamline --suite kaya-comparison

  # Capture current state as new baseline
  bun run BaselineCaptureRunner.ts --ref HEAD --suite kaya-comparison

  # Capture a single task
  bun run BaselineCaptureRunner.ts --ref pre-streamline --task kaya_cmp_context_focus_coding
`);
    process.exit(0);
  }

  if (!values.suite && !values.task) {
    console.error('Error: must specify --suite or --task');
    process.exit(1);
  }

  captureBaselines(values.ref, {
    suite: values.suite,
    task: values.task,
  })
    .then((manifest) => {
      const count = Object.keys(manifest.tasks).length;
      console.log(`\nDone. ${count} baselines captured.`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(`Error: ${e}`);
      process.exit(1);
    });
}
