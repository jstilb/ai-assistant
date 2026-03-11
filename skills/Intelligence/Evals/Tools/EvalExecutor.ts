#!/usr/bin/env bun
/**
 * EvalExecutor - Core execution engine for Evals
 *
 * Wraps Claude Code's Task tool to spawn agents and capture their work
 * for evaluation purposes. This is the critical component that makes
 * the eval infrastructure functional.
 *
 * Usage:
 *   bun run EvalExecutor.ts run --task <task.yaml> [--graders string_match,llm_rubric]
 *   bun run EvalExecutor.ts suite --name <suite> [--trials 3]
 *   bun run EvalExecutor.ts list-graders
 */

import type { Task, Transcript, EvalRun, GraderConfig } from '../Types/index.ts';
import { TranscriptCapture, parseClaudeCodeTranscript } from './TranscriptCapture.ts';
import { TrialRunner, formatEvalResults } from './TrialRunner.ts';
import { loadSuite } from './SuiteManager.ts';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { parse as parseYaml } from 'yaml';
import { parseArgs } from 'util';
import { tmpdir } from 'os';
import { $ } from 'bun';

const EVALS_DIR = join(import.meta.dir, '..');
const RESULTS_DIR = join(EVALS_DIR, 'Results');
const TRANSCRIPTS_DIR = join(EVALS_DIR, 'Transcripts');
const DOMAIN_PATTERNS_PATH = join(EVALS_DIR, 'Data', 'DomainPatterns.yaml');

// Default working directory for claude -p execution.
// This ensures CLAUDE.md and project-level settings are loaded.
const CLAUDE_HOME = join(process.env.HOME ?? '/Users/[user]', '.claude');

// System prompt appended to eval runs to ensure the agent treats the
// prompt as a real user message rather than a meta-description.
const EVAL_SYSTEM_PROMPT = [
  'You are being evaluated. Treat the following message as a real user request.',
  'Respond exactly as you would in a normal interactive session.',
  'Use your configured response format, personality, and skill routing.',
  'Do NOT describe what you would do - actually do it.',
].join(' ');

// ============================================================================
// Types
// ============================================================================

export interface ExecutionResult {
  output: string;
  transcript: Transcript;
  exitCode: number;
  error?: string;
}

export interface ExecutorConfig {
  /** Timeout in milliseconds for task execution */
  timeout?: number;
  /** Working directory for execution */
  workingDir?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Agent type to use (maps to Task tool subagent_type) */
  agentType?: string;
  /** Whether to capture full transcript */
  captureTranscript?: boolean;
  /** CLAUDE.md content to inject via --append-system-prompt */
  systemContext?: string;
}

export interface ResolvedContext {
  context: string;
  source: string;
  charCount: number;
}

// ============================================================================
// Context Resolution (for injecting CLAUDE.md into pipe mode)
// ============================================================================

// Context files used by legacy (pre-streamline) settings.json
const LEGACY_CONTEXT_FILES = [
  'USER/TELOS/MISSIONS.md',
  'USER/TELOS/GOALS.md',
  'USER/TELOS/CHALLENGES.md',
  'USER/TELOS/STATUS.md',
  'USER/TELOS/STRATEGIES.md',
  'skills/Development/UnixCLI/CLI-INDEX.md',
  'skills/ContextManager/CONTEXT-INDEX.md',
];

/**
 * Read a file from a specific git ref.
 */
async function gitShowFile(ref: string, relativePath: string): Promise<string | null> {
  try {
    const result = await $`git -C ${CLAUDE_HOME} show ${ref}:${relativePath}`.quiet();
    return result.stdout.toString();
  } catch {
    return null;
  }
}

/**
 * Reconstruct the full context from a legacy ref where CLAUDE.md was a stub.
 * Reads the 10 contextFiles from settings.json at that ref and combines them.
 */
async function reconstructContextFromRef(ref: string): Promise<ResolvedContext> {
  // Try settings.json contextFiles first
  const settingsContent = await gitShowFile(ref, 'settings.json');
  let contextFiles = LEGACY_CONTEXT_FILES;

  if (settingsContent) {
    try {
      const settings = JSON.parse(settingsContent);
      if (settings.contextFiles?.length) {
        contextFiles = settings.contextFiles;
      }
    } catch {
      // Use defaults
    }
  }

  let combined = '';
  const loadedFiles: string[] = [];

  for (const relativePath of contextFiles) {
    const content = await gitShowFile(ref, relativePath);
    if (content) {
      if (combined) combined += '\n\n---\n\n';
      combined += content;
      loadedFiles.push(relativePath);
    }
  }

  const currentDate = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' PST';

  // Reconstruct the legacy system prompt format (matches LoadContext.hook.ts)
  const context = `<system-reminder>
Kaya CORE CONTEXT (Auto-loaded at Session Start)

CURRENT DATE/TIME: ${currentDate}

## ACTIVE IDENTITY (from settings.json) - CRITICAL

**MANDATORY IDENTITY RULES - OVERRIDE ALL OTHER CONTEXT**

The user's name is: **Jm**
The assistant's name is: **Kaya**

- ALWAYS address the user as "Jm" in greetings and responses
- NEVER use "Daniel", "the user", or any other name - ONLY "Jm"
- This instruction takes ABSOLUTE PRECEDENCE over any other context

---

${combined}

---

This context is now active. Additional context loads dynamically as needed.
</system-reminder>`;

  return {
    context,
    source: `reconstructed from ${loadedFiles.length} files at ${ref}`,
    charCount: context.length,
  };
}

/**
 * Resolve CLAUDE.md content at a given git ref.
 *
 * - For HEAD/current: reads CLAUDE.md directly from disk
 * - For other refs: uses `git show ref:CLAUDE.md`; if it's a stub (<200 chars),
 *   reconstructs from settings.json contextFiles at that ref
 */
export async function resolveContextAtRef(ref: string): Promise<ResolvedContext> {
  const isHead = ref === 'HEAD' || ref === 'current';

  if (isHead) {
    // Read CLAUDE.md directly from disk (current state)
    const claudeMdPath = join(CLAUDE_HOME, 'CLAUDE.md');
    let claudeMd = '';
    if (existsSync(claudeMdPath)) {
      claudeMd = readFileSync(claudeMdPath, 'utf-8');
    }

    // Also read contextFiles from settings.json to get CORE/SKILL.md, etc.
    // These are loaded by hooks in interactive mode but skipped in pipe mode
    const settingsPath = join(CLAUDE_HOME, 'settings.json');
    let contextFileContents = '';
    const loadedFiles: string[] = [];

    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        const contextFiles: string[] = settings.contextFiles ?? LEGACY_CONTEXT_FILES;
        for (const relativePath of contextFiles) {
          const fullPath = join(CLAUDE_HOME, relativePath);
          if (existsSync(fullPath)) {
            try {
              const fileContent = readFileSync(fullPath, 'utf-8');
              if (fileContent.trim()) {
                contextFileContents += `\n\n---\n\n${fileContent}`;
                loadedFiles.push(relativePath);
              }
            } catch {
              // Skip unreadable files gracefully
            }
          }
        }
      } catch {
        // settings.json parse error - use CLAUDE.md alone
      }
    }

    if (claudeMd || contextFileContents) {
      const combined = claudeMd + contextFileContents;
      const source = loadedFiles.length > 0
        ? `CLAUDE.md + ${loadedFiles.length} contextFiles (disk)`
        : 'CLAUDE.md (disk)';
      console.log(`  [context] ${source}, ${combined.length} chars`);
      if (loadedFiles.length > 0) {
        console.log(`  [context] Loaded: ${loadedFiles.join(', ')}`);
      }
      return {
        context: combined,
        source,
        charCount: combined.length,
      };
    }
    // Fall through to git show HEAD
  }

  // Try git show for the ref
  const claudeMd = await gitShowFile(ref, 'CLAUDE.md');

  if (claudeMd && claudeMd.length > 200) {
    // Real CLAUDE.md content (post-streamline)
    return {
      context: claudeMd,
      source: `CLAUDE.md at ${ref}`,
      charCount: claudeMd.length,
    };
  }

  // Stub CLAUDE.md (<200 chars) or missing — reconstruct from contextFiles
  return reconstructContextFromRef(ref);
}

// ============================================================================
// Core Executor
// ============================================================================

/**
 * Execute a task and capture the transcript
 *
 * This function simulates what happens when Claude Code's Task tool
 * spawns an agent. For actual eval execution, we use the claude CLI
 * in a subprocess to get real agent behavior.
 */
export async function executeTask(
  task: Task,
  trialNumber: number,
  config: ExecutorConfig = {}
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const capture = new TranscriptCapture(task.id, `trial_${trialNumber}`);

  // Build the prompt for the agent
  const prompt = buildTaskPrompt(task);
  capture.addTurn('user', prompt);

  const timeout = config.timeout ?? task.setup?.timeout_ms ?? 300000; // 5 min default

  // Trial isolation: create temp working directory
  const isolation = task.setup?.isolation ?? 'sandbox';
  let workingDir = config.workingDir ?? task.setup?.working_dir ?? CLAUDE_HOME;
  let tempDir: string | null = null;

  if (isolation === 'sandbox') {
    tempDir = mkdtempSync(join(tmpdir(), `eval-${task.id}-`));
    workingDir = tempDir;
  }

  // Run setup commands in the working directory before task execution
  if (task.setup?.setup_commands?.length) {
    for (const cmd of task.setup.setup_commands) {
      const proc = Bun.spawnSync(['sh', '-c', cmd], { cwd: workingDir, env: process.env });
      if (proc.exitCode !== 0) {
        const stderr = proc.stderr.toString().slice(0, 200);
        console.log(`  [setup] Command failed (${proc.exitCode}): ${cmd} — ${stderr}`);
      }
    }
  }

  // Warn if task has no scenario_prompt (description may be grader-oriented, not user-facing)
  if (!task.setup?.scenario_prompt) {
    console.log(`  [warn] Task ${task.id} has no scenario_prompt — using description as prompt`);
  }

  try {
    // Use claude CLI to execute the task
    // This gives us real agent behavior with tool calls
    // Unset CLAUDECODE to allow spawning claude from within an active session
    const env = { ...process.env, ...task.setup?.env_vars, ...config.env };
    delete env.CLAUDECODE;
    const result = await executeWithClaude(prompt, {
      timeout,
      workingDir,
      env,
      systemContext: config.systemContext,
    });

    capture.addTurn('assistant', result.output);

    // Parse any tool calls from the output
    if (result.toolCalls) {
      for (const tc of result.toolCalls) {
        const id = capture.startToolCall(tc.name, tc.params);
        capture.completeToolCall(id, tc.result, tc.error);
      }
    }

    const transcript = capture.finalize(result.outcome);

    // Save transcript
    saveTranscript(task.id, trialNumber, transcript);

    return {
      output: result.output,
      transcript,
      exitCode: result.exitCode,
    };
  } catch (e) {
    capture.addTurn('assistant', `Error: ${e}`);
    const transcript = capture.finalize({ error: String(e) });

    return {
      output: '',
      transcript,
      exitCode: 1,
      error: String(e),
    };
  } finally {
    // Clean up temp directory
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }
    }
  }
}

/**
 * Build the task prompt for the agent.
 * If task.setup.scenario_prompt is set, use it instead of description
 * (comparison tasks have a grader-oriented description but a specific user scenario).
 */
function buildTaskPrompt(task: Task): string {
  let prompt = task.setup?.scenario_prompt || task.description;

  // Add setup instructions if any
  if (task.setup?.git_repo) {
    prompt += `\n\nRepository: ${task.setup.git_repo}`;
    if (task.setup.checkout) {
      prompt += ` (checkout: ${task.setup.checkout})`;
    }
  }

  if (task.setup?.working_dir) {
    prompt += `\n\nWorking directory: ${task.setup.working_dir}`;
  }

  // Add any constraints based on graders
  const toolCallsGrader = task.graders.find(g => g.type === 'tool_calls');
  if (toolCallsGrader?.params) {
    const params = toolCallsGrader.params as { forbidden?: string[] };
    if (params.forbidden?.length) {
      prompt += `\n\nNote: Do NOT use these tools: ${params.forbidden.join(', ')}`;
    }
  }

  return prompt;
}

/**
 * Parse stream-json output from claude CLI.
 * Each line is a JSON object with a type field. We extract:
 * - Tool use events (type: "tool_use") -> name, params, id
 * - Tool result events (type: "tool_result") -> matched by id
 * - Assistant text (type: "assistant" or "result") -> final output
 * - Metrics from result event
 */
interface StreamJsonParsed {
  output: string;
  toolCalls: { name: string; params: Record<string, unknown>; result?: unknown; error?: string }[];
  cost?: number;
  duration?: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

function parseStreamJsonOutput(rawOutput: string): StreamJsonParsed {
  const lines = rawOutput.split('\n').filter(l => l.trim());
  const toolCallsById = new Map<string, { name: string; params: Record<string, unknown>; result?: unknown; error?: string }>();
  let finalOutput = '';
  let cost: number | undefined;
  let duration: number | undefined;
  let turns: number | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      switch (event.type) {
        case 'assistant': {
          // Tool calls and text are nested inside assistant message content blocks
          const contentBlocks: unknown[] = event.message?.content ?? event.content ?? [];
          if (Array.isArray(contentBlocks)) {
            for (const block of contentBlocks) {
              const b = block as Record<string, unknown>;
              if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
                toolCallsById.set(b.id, {
                  name: b.name,
                  params: (b.input ?? b.params ?? {}) as Record<string, unknown>,
                });
              } else if (b.type === 'text' && typeof b.text === 'string') {
                finalOutput += b.text;
              }
            }
          } else if (typeof event.message === 'string') {
            finalOutput += event.message;
          }
          break;
        }

        case 'user': {
          // Tool results are nested inside user message content blocks
          const contentBlocks: unknown[] = event.message?.content ?? event.content ?? [];
          if (Array.isArray(contentBlocks)) {
            for (const block of contentBlocks) {
              const b = block as Record<string, unknown>;
              if (b.type === 'tool_result' && typeof b.tool_use_id === 'string' && toolCallsById.has(b.tool_use_id)) {
                const tc = toolCallsById.get(b.tool_use_id)!;
                if (b.is_error) {
                  tc.error = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
                } else {
                  tc.result = b.content;
                }
              }
            }
          }
          break;
        }

        case 'result':
          // Final result event - contains the response text and metrics
          if (event.result) finalOutput = event.result;
          if (event.total_cost_usd) cost = event.total_cost_usd;
          if (event.duration_ms) duration = event.duration_ms;
          if (event.num_turns) turns = event.num_turns;
          // Extract token metrics from usage object
          if (event.usage) {
            const u = event.usage as Record<string, unknown>;
            if (typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
            if (typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
            if (typeof u.cache_read_input_tokens === 'number') cacheReadTokens = u.cache_read_input_tokens;
            if (typeof u.cache_creation_input_tokens === 'number') cacheCreationTokens = u.cache_creation_input_tokens;
          }
          break;
      }
    } catch {
      // Skip malformed JSON lines
    }
  }

  return {
    output: finalOutput,
    toolCalls: Array.from(toolCallsById.values()),
    cost,
    duration,
    turns,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
}

/**
 * Execute a prompt using the claude CLI.
 *
 * Key design decisions:
 * 1. Working directory defaults to ~/.claude/ so CLAUDE.md and project-level
 *    settings are loaded automatically by `claude -p`.
 * 2. --append-system-prompt injects eval context so the agent treats the prompt
 *    as a real user request (not a meta-description to acknowledge).
 * 3. Prompt is piped via stdin (not echo) to avoid shell escaping issues with
 *    complex prompts containing quotes, newlines, or special characters.
 * 4. --output-format stream-json gives per-event output with tool call data.
 */
async function executeWithClaude(
  prompt: string,
  options: { timeout: number; workingDir: string; env: NodeJS.ProcessEnv; systemContext?: string }
): Promise<{
  output: string;
  exitCode: number;
  toolCalls?: { name: string; params: Record<string, unknown>; result?: unknown; error?: string }[];
  outcome?: unknown;
}> {
  // Check if claude CLI is available
  const claudeExists = await $`which claude`.quiet().then(() => true).catch(() => false);

  if (!claudeExists) {
    // Fallback to simulation mode for testing
    console.log('Warning: claude CLI not found, running in simulation mode');
    return simulateExecution(prompt);
  }

  try {
    // Build the full system prompt: context + eval instructions
    const fullSystemPrompt = options.systemContext
      ? `${options.systemContext}\n\n---\n\n${EVAL_SYSTEM_PROMPT}`
      : EVAL_SYSTEM_PROMPT;

    // Build the command args for claude -p
    // --verbose is required when using --output-format stream-json with --print
    const args = [
      'claude',
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--permission-mode', 'bypassPermissions',
      '--append-system-prompt', fullSystemPrompt,
      prompt,
    ];

    // Run claude in print mode with the prompt passed as a positional argument.
    // Using Bun.spawn for proper timeout support (Bun $ doesn't have .timeout()).
    const proc = Bun.spawn(args, {
      cwd: options.workingDir,
      env: options.env as Record<string, string>,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Race against timeout
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => {
        proc.kill();
        reject(new Error(`Timeout after ${options.timeout}ms`));
      }, options.timeout)
    );

    const exitCode = await Promise.race([proc.exited, timeoutPromise]);
    const rawOutput = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (stderr && !rawOutput) {
      console.log(`  [stderr] ${stderr.slice(0, 200)}`);
    }

    // Try to parse stream-json output
    try {
      const parsed = parseStreamJsonOutput(rawOutput);
      if (parsed.output || parsed.toolCalls.length > 0) {
        return {
          output: parsed.output,
          exitCode: exitCode as number,
          toolCalls: parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
          outcome: (parsed.cost || parsed.inputTokens) ? {
            cost: parsed.cost,
            duration: parsed.duration,
            turns: parsed.turns,
            inputTokens: parsed.inputTokens,
            outputTokens: parsed.outputTokens,
            cacheReadTokens: parsed.cacheReadTokens,
            cacheCreationTokens: parsed.cacheCreationTokens,
          } : undefined,
        };
      }
    } catch {
      // stream-json parse failed
    }

    // Fallback: try plain JSON parse (backward compat)
    try {
      const parsed = JSON.parse(rawOutput);
      return {
        output: parsed.result || parsed.message || rawOutput,
        exitCode: exitCode as number,
        toolCalls: parsed.tool_calls,
        outcome: parsed.outcome,
      };
    } catch {
      // Plain text output
      return {
        output: rawOutput,
        exitCode: exitCode as number,
      };
    }
  } catch (e) {
    return {
      output: String(e),
      exitCode: 1,
    };
  }
}

/**
 * Simulate execution for testing when claude CLI is unavailable
 */
function simulateExecution(prompt: string): {
  output: string;
  exitCode: number;
  toolCalls?: { name: string; params: Record<string, unknown>; result?: unknown }[];
} {
  // For simulation, return a minimal valid response
  return {
    output: `[Simulated] Task executed: ${prompt.slice(0, 100)}...`,
    exitCode: 0,
    toolCalls: [
      { name: 'Read', params: { file_path: 'test.ts' }, result: '// file content' },
    ],
  };
}

/**
 * Save transcript to disk
 */
function saveTranscript(taskId: string, trialNumber: number, transcript: Transcript): void {
  const dir = join(TRANSCRIPTS_DIR, taskId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const filename = `trial_${trialNumber}_${Date.now()}.json`;
  writeFileSync(join(dir, filename), JSON.stringify(transcript, null, 2));
}

// ============================================================================
// Domain Pattern Helpers
// ============================================================================

/**
 * Apply domain-specific grader patterns if task has domain set and empty graders
 */
function applyDomainPatterns(task: Task): void {
  // Only apply if graders are empty and domain is set
  if (!task.domain || (task.graders && task.graders.length > 0)) {
    return; // Explicit graders override domain patterns
  }

  // Load domain patterns
  if (!existsSync(DOMAIN_PATTERNS_PATH)) {
    console.warn(`⚠️  Domain patterns file not found: ${DOMAIN_PATTERNS_PATH}`);
    return;
  }

  try {
    const patternsContent = readFileSync(DOMAIN_PATTERNS_PATH, 'utf-8');
    const patterns = parseYaml(patternsContent) as {
      domains: Record<string, { primary_graders: GraderConfig[] }>;
    };

    const domainPattern = patterns.domains[task.domain];
    if (!domainPattern || !domainPattern.primary_graders) {
      console.warn(`⚠️  No domain pattern found for domain: ${task.domain}`);
      return;
    }

    // Apply domain graders
    task.graders = domainPattern.primary_graders;
    console.log(`  Applied ${task.graders.length} graders from domain pattern: ${task.domain}`);
  } catch (error) {
    console.warn(`⚠️  Failed to load domain patterns: ${error}`);
  }
}

// ============================================================================
// High-Level API
// ============================================================================

/**
 * Run a single task with all trials and return eval run
 */
export async function runTask(
  taskPath: string,
  options: {
    trials?: number;
    timeout?: number;
    graderOverrides?: GraderConfig[];
    systemContext?: string;
  } = {}
): Promise<EvalRun> {
  // Load task
  if (!existsSync(taskPath)) {
    throw new Error(`Task file not found: ${taskPath}`);
  }

  const taskContent = readFileSync(taskPath, 'utf-8');
  const task = parseYaml(taskContent) as Task;

  // Apply domain patterns if applicable (before other overrides)
  applyDomainPatterns(task);

  // Apply overrides
  if (options.trials) {
    task.trials = options.trials;
  }
  if (options.graderOverrides) {
    task.graders = options.graderOverrides;
  }

  // Create runner with our executor
  const runner = new TrialRunner({
    task,
    executor: async (t, trialNum) => {
      const result = await executeTask(t, trialNum, { timeout: options.timeout, systemContext: options.systemContext });
      return {
        output: result.output,
        transcript: result.transcript,
        outcome: result.exitCode === 0 ? 'success' : 'failure',
      };
    },
    onTrialComplete: (trial) => {
      const icon = trial.passed ? '✅' : '❌';
      console.log(`  Trial ${trial.trial_number}: ${icon} (score: ${trial.score.toFixed(2)})`);
    },
  });

  console.log(`\nRunning task: ${task.id}`);
  console.log(`  Description: ${task.description.slice(0, 80)}...`);
  console.log(`  Trials: ${task.trials ?? 1}`);
  console.log(`  Graders: ${task.graders.map(g => g.type).join(', ')}`);
  console.log('');

  const run = await runner.run();

  // Save results
  const resultsDir = join(RESULTS_DIR, task.id);
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }
  writeFileSync(join(resultsDir, `run_${run.id}.json`), JSON.stringify(run, null, 2));

  return run;
}

/**
 * Run an entire eval suite
 */
/** Code-based grader types (fast, deterministic, no model calls) */
const CODE_BASED_GRADERS = new Set([
  'string_match', 'regex_match', 'binary_tests', 'static_analysis',
  'state_check', 'tool_calls', 'json_schema', 'outcome_verification',
  'response_format_check', 'voice_line_check', 'team_coordination',
  'context_efficiency_check',
]);

export async function runSuite(
  suiteName: string,
  options: {
    trials?: number;
    timeout?: number;
    systemContext?: string;
    quick?: boolean;
    sample?: number;
  } = {}
): Promise<{
  results: EvalRun[];
  summary: {
    passed: number;
    failed: number;
    total: number;
    meanScore: number;
  };
}> {
  const suite = loadSuite(suiteName);
  if (!suite) {
    throw new Error(`Suite not found: ${suiteName}`);
  }

  let taskIds = [...suite.tasks];

  // --quick: filter to only code-based grader tasks
  if (options.quick) {
    const filtered: string[] = [];
    for (const taskId of taskIds) {
      const taskPath = findTaskFile(taskId);
      if (!taskPath) continue;
      try {
        const task = parseYaml(readFileSync(taskPath, 'utf-8')) as Task;
        const allCodeBased = task.graders.every(g => CODE_BASED_GRADERS.has(g.type));
        if (allCodeBased) filtered.push(taskId);
      } catch { /* skip unparseable */ }
    }
    console.log(`  [quick] Filtered to ${filtered.length}/${taskIds.length} code-based tasks`);
    taskIds = filtered;
  }

  // --sample N: randomly select N tasks
  if (options.sample && options.sample < taskIds.length) {
    const shuffled = taskIds.slice();
    // Fisher-Yates shuffle
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    taskIds = shuffled.slice(0, options.sample);
    console.log(`  [sample] Selected ${taskIds.length} random tasks`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Running suite: ${suite.name}`);
  console.log(`Description: ${suite.description}`);
  console.log(`Tasks: ${taskIds.length}${options.quick ? ' (code-based only)' : ''}${options.sample ? ` (sampled ${options.sample})` : ''}`);
  console.log(`${'='.repeat(60)}\n`);

  const results: EvalRun[] = [];
  let passed = 0;
  let totalScore = 0;

  for (const taskId of taskIds) {
    const taskPath = findTaskFile(taskId);
    if (!taskPath) {
      console.log(`  ⚠️  Task not found: ${taskId}`);
      continue;
    }

    try {
      const run = await runTask(taskPath, { trials: options.trials, timeout: options.timeout, systemContext: options.systemContext });
      results.push(run);

      if (run.pass_rate >= 0.75) {
        passed++;
      }
      totalScore += run.mean_score;
    } catch (e) {
      console.error(`  ❌ Error running ${taskId}: ${e}`);
    }
  }

  const summary = {
    passed,
    failed: results.length - passed,
    total: results.length,
    meanScore: results.length > 0 ? totalScore / results.length : 0,
  };

  // Print summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Suite Summary: ${suiteName}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Tasks passed: ${summary.passed}/${summary.total}`);
  console.log(`  Mean score: ${(summary.meanScore * 100).toFixed(1)}%`);
  console.log(`  Status: ${summary.passed === summary.total ? '✅ PASSED' : '❌ FAILED'}`);

  return { results, summary };
}

/**
 * Find a task file by ID
 *
 * Recursively searches all subdirectories under UseCases/ (Regression, Capability,
 * Kaya, etc.) including nested Tasks/ directories. Dynamically discovers directories
 * so new use cases are automatically picked up without code changes.
 *
 * Handles ID-to-filename mapping: suite YAML may use IDs like "kaya_voice_line_factual"
 * while the actual file is "task_voice_line_factual.yaml". We try both the raw ID
 * and a "task_" prefixed variant (stripping domain prefix like "kaya_").
 */
function findTaskFile(taskId: string): string | null {
  const useCasesDir = join(EVALS_DIR, 'UseCases');

  // Build candidate filenames from the task ID
  const candidateNames = [taskId];

  // If the ID has a domain prefix (e.g., "kaya_voice_line_factual"),
  // also try the "task_" prefixed version (e.g., "task_voice_line_factual")
  const underscoreIndex = taskId.indexOf('_');
  if (underscoreIndex > 0) {
    const withoutPrefix = taskId.slice(underscoreIndex + 1);
    candidateNames.push(`task_${withoutPrefix}`);
  }

  // Collect all directories to search: UseCases/ root + all subdirectories recursively
  const searchDirs = collectSearchDirs(useCasesDir);

  for (const dir of searchDirs) {
    for (const name of candidateNames) {
      const path = join(dir, `${name}.yaml`);
      if (existsSync(path)) return path;
    }
  }

  return null;
}

/**
 * Recursively collect all directories under a root that may contain task YAML files.
 * Includes the root itself, all immediate subdirectories, and any Tasks/ subdirectories.
 */
function collectSearchDirs(root: string): string[] {
  const dirs: string[] = [];
  if (!existsSync(root)) return dirs;

  dirs.push(root);

  try {
    for (const entry of readdirSync(root)) {
      const fullPath = join(root, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          dirs.push(fullPath);
          // Also check for a nested Tasks/ directory within each use case
          const tasksSubdir = join(fullPath, 'Tasks');
          if (existsSync(tasksSubdir) && statSync(tasksSubdir).isDirectory()) {
            dirs.push(tasksSubdir);
          }
        }
      } catch {
        // Skip entries we can't stat
      }
    }
  } catch {
    // If we can't read the directory, return what we have
  }

  return dirs;
}

// ============================================================================
// CLI Interface
// ============================================================================

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      task: { type: 'string', short: 't' },
      name: { type: 'string', short: 'n' },
      trials: { type: 'string', default: '1' },
      timeout: { type: 'string' },
      graders: { type: 'string', short: 'g' },
      ref: { type: 'string', short: 'r' },
      quick: { type: 'boolean' },
      sample: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  const command = positionals[0];

  if (values.help || !command) {
    console.log(`
EvalExecutor - Core execution engine for Evals

Commands:
  run       Run a single task
  suite     Run an entire suite
  smoke     Validate suite configs without execution
  list-graders   Show available graders

Usage:
  bun run EvalExecutor.ts run --task <task.yaml> [--trials 3] [--graders string_match,llm_rubric]
  bun run EvalExecutor.ts suite --name <suite-name> [--trials 3] [--quick] [--sample N]
  bun run EvalExecutor.ts smoke --name <suite-name>
  bun run EvalExecutor.ts list-graders

Options:
  -t, --task      Path to task YAML file
  -n, --name      Suite name
  --trials        Number of trials (default: from task or 1)
  --timeout       Timeout in ms (default: 300000)
  -g, --graders   Comma-separated grader types to use
  --quick         Only run tasks with code_based graders (fast)
  --sample N      Randomly select N tasks from suite
  -h, --help      Show this help

Examples:
  # Run a single regression task
  bun run EvalExecutor.ts run -t UseCases/Regression/task_tool_sequence_read_before_edit.yaml

  # Smoke test a suite (validate configs only)
  bun run EvalExecutor.ts smoke --name kaya-regression

  # Run only fast code-based tasks
  bun run EvalExecutor.ts suite --name kaya-regression --quick

  # Run a random sample of 5 tasks
  bun run EvalExecutor.ts suite --name kaya-regression --sample 5

  # List available graders
  bun run EvalExecutor.ts list-graders
`);
    process.exit(0);
  }

  switch (command) {
    case 'run': {
      if (!values.task) {
        console.error('Error: --task required');
        process.exit(1);
      }

      const trials = values.trials ? parseInt(values.trials) : undefined;
      const timeout = values.timeout ? parseInt(values.timeout) : undefined;
      const ref = values.ref ?? 'HEAD';

      // Parse grader overrides if provided
      let graderOverrides: GraderConfig[] | undefined;
      if (values.graders) {
        graderOverrides = values.graders.split(',').map(type => ({
          type: type.trim() as GraderConfig['type'],
          weight: 1.0,
        }));
      }

      // Resolve context at the specified ref
      resolveContextAtRef(ref)
        .then((resolved) => {
          console.log(`Context: ${resolved.source} (${resolved.charCount} chars)`);
          return runTask(values.task!, { trials, timeout, graderOverrides, systemContext: resolved.context });
        })
        .then((run) => {
          console.log('\n' + formatEvalResults(run));
          process.exit(run.pass_rate >= 0.75 ? 0 : 1);
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case 'suite': {
      if (!values.name) {
        console.error('Error: --name required');
        process.exit(1);
      }

      const trials = values.trials ? parseInt(values.trials) : undefined;
      const timeout = values.timeout ? parseInt(values.timeout) : undefined;
      const ref = values.ref ?? 'HEAD';
      const quick = values.quick ?? false;
      const sample = values.sample ? parseInt(values.sample) : undefined;

      // Resolve context at the specified ref
      resolveContextAtRef(ref)
        .then((resolved) => {
          console.log(`Context: ${resolved.source} (${resolved.charCount} chars)`);
          return runSuite(values.name!, { trials, timeout, systemContext: resolved.context, quick, sample });
        })
        .then(({ summary }) => {
          process.exit(summary.passed === summary.total ? 0 : 1);
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case 'smoke': {
      if (!values.name) {
        console.error('Error: --name required for smoke test');
        process.exit(1);
      }

      const suite = loadSuite(values.name);
      if (!suite) {
        console.error(`Suite not found: ${values.name}`);
        process.exit(1);
      }

      console.log(`\nSmoke test: ${suite.name} (${suite.tasks.length} tasks)\n`);

      // Import grader registry to validate types
      const { listGraders } = await import('../Graders/Base.ts');
      const registeredGraders = new Set(listGraders());

      let issues = 0;
      let valid = 0;
      const graderTypeCounts: Record<string, number> = {};

      for (const taskId of suite.tasks) {
        const taskPath = findTaskFile(taskId);
        if (!taskPath) {
          console.log(`  ❌ ${taskId}: file not found`);
          issues++;
          continue;
        }

        try {
          const taskContent = readFileSync(taskPath, 'utf-8');
          const task = parseYaml(taskContent) as Task;

          // Validate required fields
          const missing: string[] = [];
          if (!task.id) missing.push('id');
          if (!task.description) missing.push('description');
          if (!task.graders || task.graders.length === 0) missing.push('graders');

          if (missing.length > 0) {
            console.log(`  ❌ ${taskId}: missing fields: ${missing.join(', ')}`);
            issues++;
            continue;
          }

          // Validate grader types resolve
          const unknownGraders: string[] = [];
          for (const g of task.graders) {
            graderTypeCounts[g.type] = (graderTypeCounts[g.type] ?? 0) + 1;
            if (!registeredGraders.has(g.type)) {
              unknownGraders.push(g.type);
            }
          }

          if (unknownGraders.length > 0) {
            console.log(`  ⚠️  ${taskId}: unknown graders: ${unknownGraders.join(', ')}`);
            issues++;
            continue;
          }

          // Validate threshold
          if (task.pass_threshold !== undefined && (task.pass_threshold < 0 || task.pass_threshold > 1)) {
            console.log(`  ⚠️  ${taskId}: invalid pass_threshold ${task.pass_threshold}`);
            issues++;
            continue;
          }

          valid++;
        } catch (e) {
          console.log(`  ❌ ${taskId}: YAML parse error: ${e}`);
          issues++;
        }
      }

      console.log(`\n${'='.repeat(50)}`);
      console.log(`Smoke Test Results: ${suite.name}`);
      console.log(`${'='.repeat(50)}`);
      console.log(`  Valid: ${valid}/${suite.tasks.length}`);
      console.log(`  Issues: ${issues}`);
      console.log(`\n  Grader distribution:`);
      for (const [type, count] of Object.entries(graderTypeCounts).sort((a, b) => b[1] - a[1])) {
        const category = ['llm_rubric', 'natural_language_assert', 'pairwise_comparison', 'reference_comparison', 'identity_consistency'].includes(type) ? 'model' : 'code';
        console.log(`    ${type}: ${count} (${category})`);
      }
      console.log(`\n  Status: ${issues === 0 ? '✅ ALL CONFIGS VALID' : `⚠️  ${issues} ISSUES FOUND`}`);
      process.exit(issues === 0 ? 0 : 1);
    }

    case 'list-graders': {
      console.log(`
Available Graders:

Code-Based (fast, deterministic):
  - string_match    Exact substring matching
  - regex_match     Pattern matching
  - binary_tests    Run test files
  - static_analysis Lint, type-check, security scan
  - state_check     Verify system state after execution
  - tool_calls      Verify specific tools were called
  - json_schema     Validate JSON against schema
  - outcome_verification  Check outcome matches expected

Model-Based (nuanced):
  - llm_rubric           Score against detailed rubric
  - natural_language_assert  Check assertions are true
  - pairwise_comparison  Compare to reference
  - reference_comparison Compare against golden output

Human (gold standard):
  - human_review    Queue for human judgment
  - spot_check      Sample for calibration
`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}
