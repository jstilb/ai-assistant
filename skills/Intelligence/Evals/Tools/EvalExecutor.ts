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

import type { Task, Transcript, EvalRun, GraderConfig, GraderType } from '../Types/index.ts';
import { TaskSchema } from '../Types/schemas.ts';
import { TranscriptCapture, parseClaudeCodeTranscript } from './TranscriptCapture.ts';
import { TrialRunner, formatEvalResults, matchKnownInfraSignature, type TaskExecutor } from './TrialRunner.ts';
import { anyGraderReadsOutput, listGradersByCategory } from '../Graders/Base.ts';
import { loadSuite } from './SuiteManager.ts';
import { findTaskFile } from './shared/TaskUtils.ts';
import {
  scanForDestructiveScenario,
  resolveSandboxPathMappings,
  formatRefusalMessage,
  redactInfraSignatures,
} from './DestructiveScenarioGuard.ts';
import { persistSuiteResults, type EvalResult as PersistEvalResult } from './ResultsPersistence.ts';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { parse as parseYaml } from 'yaml';
import {
  buildHardenedClaudeEnv,
  stripDangerousClaudeEnvKeys,
} from '../../../../lib/core/Inference.ts';

/**
 * Build the env for an eval's `claude -p` subprocess.
 *
 * Starts from buildHardenedClaudeEnv() (OAuth token inject + ~/.claude/bin
 * PATH fix), layers the eval's own env sources on top, then strips dangerous
 * keys AGAIN after the merge: task/config env_vars are semi-trusted YAML —
 * a config must not be able to smuggle in ANTHROPIC_API_KEY or
 * CLAUDE_CODE_* nesting vars. Exported pure for unit testing.
 */
export function buildEvalEnv(
  taskEnv: Record<string, string> | undefined,
  configEnv: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...buildHardenedClaudeEnv(),
    ...taskEnv,
    ...configEnv,
  };
  stripDangerousClaudeEnvKeys(env);
  return env;
}
import { parseArgs } from 'util';
import { tmpdir } from 'os';
import { $ } from 'bun';
import { getKayaHome } from '../../../../lib/core/KayaHome.ts';

const EVALS_DIR = join(import.meta.dir, '..');
const RESULTS_DIR = join(EVALS_DIR, 'Results');
const DOMAIN_PATTERNS_PATH = join(EVALS_DIR, 'Data', 'DomainPatterns.yaml');

// Default working directory for claude -p execution.
// This ensures CLAUDE.md and project-level settings are loaded.
const CLAUDE_HOME = getKayaHome();

// System prompt appended to eval runs to ensure the agent treats the
// prompt as a real user message rather than a meta-description.
const EVAL_SYSTEM_PROMPT = [
  'Treat the following as a real user request.',
  'Use your configured response format, personality, and skill routing.',
  'Do NOT describe what you would do - actually do it.',
].join(' ');

// Placeholder output for tasks whose live agent spawn was skipped (see
// executeTask()). Historically had to be non-empty/non-whitespace because
// TrialRunner's old detectInfraFailure() keyword-scanned agent output text
// and treated an empty string as an 'empty_response' infra failure. That
// output-scanning classifier was deleted (evals-rebuild slice A2 — see
// MEMORY/SkillAudits/evals-infra-audit-2026-07-09); TrialRunner now
// classifies infra failures from exitCode/stderr/result-event fields only,
// so an empty string here would no longer misclassify. Left descriptive and
// non-empty anyway — it's useful debugging signal in transcripts/logs.
const AGENT_RUN_SKIPPED_OUTPUT =
  '[eval: live agent spawn skipped — no grader on this task reads agent output/transcript; ' +
  'setup_commands already produced the record these graders read]';

// ============================================================================
// Types
// ============================================================================

export interface ExecutionResult {
  output: string;
  transcript: Transcript;
  exitCode: number;
  error?: string;
  /** Subprocess stderr, if any. TrialRunner matches narrow known infra
   *  signatures ONLY against this field — never against `output` (the
   *  agent's own answer). */
  stderr?: string;
  /** From the claude CLI's stream-json `result` event — true when the CLI
   *  itself reported an error. Machine-authored structured field, not free
   *  text scanned from the agent's answer. */
  resultIsError?: boolean;
  /** The `result` event's `subtype` field (e.g. "error_during_execution"),
   *  present when resultIsError is true. */
  resultErrorSubtype?: string;
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
  /** `--model` for the spawned `claude -p` (alias like `sonnet` or a full
   *  model id). Omitted = whatever the config dir's settings.json / default
   *  resolves to. Setup-ablation runs (Tools/Ablation/) set this per cell. */
  model?: string;
  /** Pass `--no-session-persistence` so eval turns never land in the config
   *  dir's projects/ session history. Setup-ablation runs set this. */
  noSessionPersistence?: boolean;
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
const LEGACY_CONTEXT_CONFIG_PATH = join(EVALS_DIR, 'Config', 'legacy-context-files.yaml');

function loadLegacyContextFiles(): string[] {
  if (!existsSync(LEGACY_CONTEXT_CONFIG_PATH)) {
    // Non-fatal: baseline comparison will work without legacy context
    process.stderr.write(
      `[Evals] Warning: legacy-context-files.yaml not found at ${LEGACY_CONTEXT_CONFIG_PATH}. ` +
      `Baseline comparison will use no legacy context.\n`
    );
    return [];
  }
  try {
    const config = parseYaml(readFileSync(LEGACY_CONTEXT_CONFIG_PATH, 'utf-8')) as { files: string[] };
    return config.files || [];
  } catch {
    return [];
  }
}

const LEGACY_CONTEXT_FILES = loadLegacyContextFiles();

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
        const settingsRaw = readFileSync(settingsPath, 'utf-8');
        const settings = JSON.parse(settingsRaw);
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

  const timeout = config.timeout ?? task.setup?.timeout_ms ?? 300000; // 5 min default

  // Trial isolation: create temp working directory
  const isolation = task.setup?.isolation ?? 'sandbox';
  let workingDir = config.workingDir ?? task.setup?.working_dir ?? CLAUDE_HOME;
  let tempDir: string | null = null;

  if (isolation === 'sandbox') {
    tempDir = mkdtempSync(join(tmpdir(), `eval-${task.id}-`));
    workingDir = tempDir;
  } else if (!existsSync(workingDir)) {
    // isolation: none/shared with a declared working_dir that doesn't exist
    // yet (fixture dirs the task's own setup_commands populate): create it,
    // otherwise the setup_commands spawn below fails on cwd before the
    // commands that would have created it ever run.
    mkdirSync(workingDir, { recursive: true });
  }

  try {
    // B6 destructive-scenario guard (evals-rebuild) — runs BEFORE
    // setup_commands execute and BEFORE any agent spawn. Apply
    // setup.sandbox_paths mappings first (materializes a sandbox copy of
    // each declared real path and rewrites literal occurrences in
    // scenario_prompt/setup_commands to point at the copy), then scan the
    // resulting (possibly rewritten) text for a destructive verb combined
    // with a real absolute path still outside `workingDir` (this trial's
    // sandbox — either the freshly created mkdtemp dir above, or the task's
    // declared/default working_dir for isolation:'shared'/'none').
    //
    // A hit REFUSES the task by throwing here — deliberately NOT a normal
    // `return { exitCode: 1, ... }` (that path, further below, is caught by
    // TrialRunner's classifyInfraFailure(), whose `exitCode !== 0` catch-all
    // would launder a real refusal into a transient-looking 'exec_error'
    // infra failure — excluded from pass_rate, invisible in the suite
    // summary). Thrown here (before the inner try/catch below, which only
    // wraps the agent-spawn section), this propagates past this function
    // entirely to TrialRunner.run()'s own try/catch, which — since the
    // refusal message matches no known infra signature (see
    // formatRefusalMessage's doc comment) — lands the trial at
    // status:'error': a real, countable failure, visible in results/summary,
    // not silently skipped or infra-excluded. See DestructiveScenarioGuard.ts
    // and MEMORY/SkillAudits/evals-infra-audit-2026-07-09/liverun.md finding 4
    // for the incident this guards against.
    const { scenarioPrompt: effectiveScenarioPrompt, setupCommands: effectiveSetupCommands } =
      resolveSandboxPathMappings(task, workingDir);

    const guardResult = scanForDestructiveScenario(
      { scenarioPrompt: effectiveScenarioPrompt, setupCommands: effectiveSetupCommands },
      workingDir,
    );
    if (guardResult.blocked) {
      throw new Error(formatRefusalMessage(task.id, guardResult));
    }

    // Build the prompt for the agent (uses the post-sandbox_paths-rewrite
    // scenario_prompt, if any mapping applied).
    const prompt = buildTaskPrompt(task, effectiveScenarioPrompt);
    capture.addTurn('user', prompt);

    // Run setup commands in the working directory before task execution
    // (also post-rewrite — see sandbox_paths handling above).
    //
    // remediation-p1p5 E2/F2 (2026-07-21): this spawnSync was the ONLY
    // subprocess link in the evals chain with no timeout — a stuck setup
    // command blocked here FOREVER (spawnSync is fully synchronous; nothing
    // above or below this loop, including the per-task `timeout` budget used
    // for the agent spawn below, gets a chance to bound it), which could
    // starve the entire suite and burn the whole evals-nightly cron job's
    // own timeout (see JobSpawner.ts's isSleepInflated/ABSOLUTE_SLOP_MS —
    // that's the OTHER half of this incident's fix, at the cron layer; this
    // is the task layer). `timeout` here reuses the same per-task budget
    // already resolved above (config.timeout ?? task.setup?.timeout_ms ??
    // 300000) rather than a second, independent constant.
    //
    // A timeout throws — deliberately NOT a normal `return { exitCode: 1 }`
    // — for the exact reason documented on the destructive-scenario guard's
    // throw above: thrown here, before the inner try/catch (which only
    // wraps the agent-spawn section), this propagates past this function to
    // TrialRunner.run()'s own try/catch, which classifies the caught
    // message via matchKnownInfraSignature() (see TrialRunner.ts:247) before
    // deciding status:'error' (real, countable, visible in pass_rate/summary)
    // vs. status:'infra_failure' (excluded from both). The pre-existing
    // non-zero-exit branch below IS still logged-and-continued — deliberately
    // out of scope here, a stuck command and a fast-failing one are different
    // problems; only the timeout gets the fail-loud treatment this slice
    // fixes.
    //
    // CLASSIFIER-EVASION GUARD: the message must contain NONE of
    // TrialRunner.ts's INFRA_SIGNATURE_GROUPS substrings (notably neither
    // "timeout" nor "timed out" — the word this incident is literally
    // about), or it gets misclassified as an excluded infra_failure instead
    // of a countable error — the EXACT hazard DestructiveScenarioGuard.ts's
    // redactInfraSignatures()/formatRefusalMessage() 30 lines away already
    // defends against for its own thrown-message call site. Reused here
    // rather than re-implemented: `cmd`/`stderr` are untrusted task-author/
    // subprocess text (same class of risk as that guard's path/snippet
    // fields), so they're redacted before interpolation, and the fully
    // assembled message gets the same belt-and-suspenders final check +
    // fallback.
    if (effectiveSetupCommands?.length) {
      for (const cmd of effectiveSetupCommands) {
        const proc = Bun.spawnSync(['sh', '-c', cmd], { cwd: workingDir, env: process.env, timeout });
        if (proc.exitedDueToTimeout) {
          const stderr = proc.stderr.toString().slice(0, 200);
          const safeTaskId = redactInfraSignatures(task.id);
          const safeCmd = redactInfraSignatures(cmd);
          const safeStderr = stderr ? redactInfraSignatures(stderr) : '';
          const message =
            `Task ${safeTaskId}: setup command exceeded its ${timeout}ms budget and was killed: ${safeCmd}` +
            (safeStderr ? ` — ${safeStderr}` : '');
          if (matchKnownInfraSignature(message) === null) {
            throw new Error(message);
          }
          // Layer 2 fallback — should never be reached given the redaction
          // above, but fail SAFE rather than ship a message that risks
          // laundering a real setup-command budget-exceeded failure into an
          // excluded infra_failure.
          throw new Error(
            `Task ${safeTaskId}: a setup command exceeded its execution budget and was killed ` +
            `(command and output withheld — contained infra-signature text)`
          );
        }
        if (proc.exitCode !== 0) {
          const stderr = proc.stderr.toString().slice(0, 200);
          console.log(`  [setup] Command failed (${proc.exitCode}): ${cmd} — ${stderr}`);
        }
      }
    }

    // Warn if task has no scenario_prompt (description may be grader-oriented, not user-facing)
    if (!effectiveScenarioPrompt) {
      console.log(`  [warn] Task ${task.id} has no scenario_prompt — using description as prompt`);
    }

    // Inner try/catch: wraps ONLY the agent-spawn section below. Errors
    // here (a genuinely failed/crashed run) become a normal
    // `{ exitCode: 1, error }` return, which TrialRunner's
    // classifyInfraFailure() treats as an infra failure ('exec_error') —
    // correct for THIS section (a real subprocess execution problem), but
    // NOT for the guard refusal above, which throws OUTSIDE this inner
    // try/catch specifically so it is never caught and downgraded here.
    try {
      // Skip the live agent spawn entirely when no grader configured on this
      // task ever reads context.output/context.transcript — e.g. the
      // fixture_accuracy/nightly_judge "static input" nets, whose real work
      // already happened in setup_commands above and whose grader only reads
      // the record it wrote. Decision is grader-registry-derived (see
      // Graders/Base.ts's anyGraderReadsOutput()) — never a hand-maintained
      // list of task ids or grader-type names here.
      const needsAgentRun = anyGraderReadsOutput(task.graders ?? []);

      let result: {
        output: string;
        exitCode: number;
        toolCalls?: { name: string; params: Record<string, unknown>; result?: unknown; error?: string }[];
        outcome?: unknown;
        stderr?: string;
        resultIsError?: boolean;
        resultErrorSubtype?: string;
      };

      if (needsAgentRun) {
        // Use claude CLI to execute the task
        // This gives us real agent behavior with tool calls
        // Hardened + post-merge-scrubbed env — see buildEvalEnv() above.
        const env = buildEvalEnv(task.setup?.env_vars, config.env);
        result = await executeWithClaude(prompt, {
          timeout,
          workingDir,
          env,
          systemContext: config.systemContext,
          model: config.model,
          noSessionPersistence: config.noSessionPersistence,
        });
      } else {
        console.log(`  [skip] Task ${task.id}: no grader reads agent output/transcript (readsOutput=false for all ${task.graders?.length ?? 0} grader(s)) — skipping the live agent spawn; setup_commands already produced everything the grader(s) will read.`);
        result = {
          output: AGENT_RUN_SKIPPED_OUTPUT,
          exitCode: 0,
          outcome: { agentRunSkipped: true, reason: 'no configured grader declares readsOutput=true' },
        };
      }

      capture.addTurn('assistant', result.output);

      // Parse any tool calls from the output
      if (result.toolCalls) {
        for (const tc of result.toolCalls) {
          const id = capture.startToolCall(tc.name, tc.params);
          capture.completeToolCall(id, tc.result, tc.error);
        }
      }

      const transcript = capture.finalize(result.outcome);

      return {
        output: result.output,
        transcript,
        exitCode: result.exitCode,
        stderr: result.stderr,
        resultIsError: result.resultIsError,
        resultErrorSubtype: result.resultErrorSubtype,
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
    }
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
 *
 * `scenarioPromptOverride` — pass the (possibly sandbox_paths-rewritten)
 * scenario_prompt resolved by resolveSandboxPathMappings() in executeTask()
 * rather than reading task.setup.scenario_prompt directly, so the agent
 * only ever sees the rewritten/sandboxed text, never a real out-of-sandbox
 * path a sandbox_paths mapping was declared to replace.
 */
function buildTaskPrompt(task: Task, scenarioPromptOverride?: string): string {
  let prompt = scenarioPromptOverride || task.description;

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
  /** From the `result` event's `is_error` field — true when the claude CLI
   *  itself reported an error. Machine-authored structured field; threaded
   *  to TrialRunner for infra-failure classification (never derived from
   *  `output` text). */
  isError?: boolean;
  /** The `result` event's `subtype` field (e.g. "error_during_execution"),
   *  present alongside isError. */
  resultSubtype?: string;
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
  let isError: boolean | undefined;
  let resultSubtype: string | undefined;

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
          // Structured error fields — machine-authored, not free text.
          if (typeof event.is_error === 'boolean') isError = event.is_error;
          if (typeof event.subtype === 'string') resultSubtype = event.subtype;
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
    isError,
    resultSubtype,
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
/**
 * Build the argv for an eval's `claude -p` spawn. Pure — exported so the
 * flag wiring (`--model`, `--no-session-persistence`) is unit-testable
 * without a live spawn. `--verbose` is required when using
 * `--output-format stream-json` with `--print`.
 */
export function buildClaudeArgs(options: {
  prompt: string;
  systemPrompt: string;
  model?: string;
  noSessionPersistence?: boolean;
}): string[] {
  const args = [
    'claude',
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
    '--append-system-prompt', options.systemPrompt,
  ];
  if (options.model) args.push('--model', options.model);
  if (options.noSessionPersistence) args.push('--no-session-persistence');
  args.push(options.prompt);
  return args;
}

async function executeWithClaude(
  prompt: string,
  options: {
    timeout: number;
    workingDir: string;
    env: NodeJS.ProcessEnv;
    systemContext?: string;
    model?: string;
    noSessionPersistence?: boolean;
  }
): Promise<{
  output: string;
  exitCode: number;
  toolCalls?: { name: string; params: Record<string, unknown>; result?: unknown; error?: string }[];
  outcome?: unknown;
  stderr?: string;
  resultIsError?: boolean;
  resultErrorSubtype?: string;
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

    // Build the command args for claude -p (see buildClaudeArgs()).
    const args = buildClaudeArgs({
      prompt,
      systemPrompt: fullSystemPrompt,
      model: options.model,
      noSessionPersistence: options.noSessionPersistence,
    });

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
          stderr: stderr || undefined,
          resultIsError: parsed.isError,
          resultErrorSubtype: parsed.resultSubtype,
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
        stderr: stderr || undefined,
      };
    } catch {
      // Plain text output
      return {
        output: rawOutput,
        exitCode: exitCode as number,
        stderr: stderr || undefined,
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

// ============================================================================
// Task Config Schema Validation
// ============================================================================

/**
 * Load and validate a task YAML against the shared TaskSchema
 * (Types/schemas.ts) — the single source of truth for Task shape, also used
 * by TaskValidator.ts. Previously this function had its own independently
 * hand-maintained, much looser inline schema (domain/type/graders all
 * optional, arbitrary passthrough fields) that could silently accept a task
 * TaskValidator.ts would reject, and vice versa — see evals-rebuild slice A5
 * / MEMORY/SkillAudits/evals-infra-audit-2026-07-09/engine.md REDESIGN
 * OPPORTUNITIES #1. On invalid: loud, actionable error naming the task file
 * path and every zod issue — never a silent partial acceptance.
 */
export function loadTaskConfig(taskPath: string): Task {
  if (!existsSync(taskPath)) {
    throw new Error(`Task config not found: ${taskPath}`);
  }
  const raw = parseYaml(readFileSync(taskPath, 'utf-8'));
  const result = TaskSchema.safeParse(raw);
  if (!result.success) {
    const formatted = result.error.issues
      .map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid task config at ${taskPath}:\n${formatted}`);
  }
  return result.data;
}

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
    /** Override the trial executor entirely — bypasses the real `claude -p`
     *  agent spawn. Test-only injection point (S5 circuit-breaker hermetic
     *  tests exercise the REAL runSuite()/runTask() loop with a simulated
     *  executor instead of re-implementing the loop's logic in the test);
     *  production callers never set this. */
    executor?: TaskExecutor;
    /** Extra env for the spawned agent (merged AFTER task env_vars, then
     *  scrubbed by buildEvalEnv()). Setup-ablation runs pass
     *  CLAUDE_CONFIG_DIR here so the agent boots from a materialized
     *  profile dir instead of the live ~/.claude. */
    env?: Record<string, string>;
    /** `--model` for the spawned agent; recorded on EvalRun.model. */
    model?: string;
    /** `--no-session-persistence` for the spawned agent. */
    noSessionPersistence?: boolean;
  } = {}
): Promise<EvalRun> {
  // Load task
  const task = loadTaskConfig(taskPath);

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
    executor: options.executor ?? (async (t, trialNum) => {
      const result = await executeTask(t, trialNum, {
        timeout: options.timeout,
        systemContext: options.systemContext,
        env: options.env,
        model: options.model,
        noSessionPersistence: options.noSessionPersistence,
      });
      return {
        output: result.output,
        transcript: result.transcript,
        outcome: result.exitCode === 0 ? 'success' : 'failure',
        exitCode: result.exitCode,
        stderr: result.stderr,
        resultIsError: result.resultIsError,
        resultErrorSubtype: result.resultErrorSubtype,
      };
    }),
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
  if (options.model) run.model = options.model;

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
/**
 * Code-based grader types (`--quick` filter: run only tasks whose every
 * grader is code-based, i.e. no model call at grade-time).
 *
 * evals-rebuild slice A6: derived from the grader registry's own declared
 * `.category` (Graders/Base.ts's listGradersByCategory()) instead of a
 * hand-maintained set of grader-type strings — see the audit finding this
 * class of drift produced (the smoke command's separate hand-list only knew
 * 2 of the 4 model-based types and miscategorized nightly_judge as "code").
 *
 * BEHAVIOR NOTE: this now includes 'fixture_accuracy', which the old
 * hand-list deliberately excluded even though the grader class itself
 * declares category: 'code_based' — its record_path is produced by a LIVE
 * fixture-runner in setup_commands (real classify()/inference() calls per
 * fixture), so a task using it is not "fast" in the sense --quick promises.
 * `.category` answers "does grade() itself call a model", not "is this task
 * cheap to run" — those are genuinely different questions, and the registry
 * has no field for the second one. Flagged for Jm: if --quick's "fast"
 * guarantee needs to keep excluding fixture_accuracy specifically, that
 * wants a new per-grader signal (e.g. a `fast` field), not a hand-list
 * reintroduced here.
 */
export function codeBasedGraderTypes(): Set<GraderType> {
  return new Set(listGradersByCategory().code_based);
}

/**
 * A task run whose EVERY trial was an infra failure (transient inference
 * timeout, econnreset, etc.) carries NO behavioral signal. This is the
 * single shared exclusion rule used both by summarizeSuiteRuns() (the
 * console "Tasks passed: X/Y" summary) and by runSuite()'s persistPayload
 * (the MEMORY/VALIDATION/evals/ JSONL) — previously they disagreed on the
 * denominator for the same run (5/5 console vs 5/6 persisted), because only
 * the console path excluded infra-failed tasks. See
 * MEMORY/SkillAudits/evals-infra-audit-2026-07-09/gap.md verification 2.
 */
export function isInfraSkippedRun(run: EvalRun): boolean {
  return run.infra_failures >= run.n_trials;
}

/**
 * A task run whose zero score is entirely explained by the JUDGE's OWN
 * nested inference() call failing (S5, 2026-07-15 401 auth-storm) — not by
 * the agent-under-test's behavior. Distinct from isInfraSkippedRun() above:
 * that classifier only sees the TOP-LEVEL agent spawn's signals
 * (TrialRunner's classifyInfraFailure(), fed by executeTask()'s exitCode/
 * stderr/resultIsError). It cannot see a judge-based grader's SEPARATE
 * nested `claude -p` spawn inside runGraders() — the agent spawn can exit 0
 * (or even be skipped entirely, e.g. fixture_accuracy/nightly_judge "static
 * input" tasks) while that second, judge-scoring spawn 401s, landing a real
 * `score: 0` with no infra_failure_type at all.
 *
 * Every judge-based grader that wraps Graders/JudgeProtocol.ts's
 * judgeInference() (LLMRubric, NaturalLanguageAssert, NightlyJudge) sets
 * GraderResult.details.judge_error ONLY on that judge call's own failure
 * path — never on a real, successfully-judged verdict (see NightlyJudge.ts
 * grade(): "details.judge_error — never a silent score-0-with-empty-reasoning").
 * That's a STRUCTURED, machine-authored marker (a field's mere presence),
 * not agent output/answer text — checking it is NOT the keyword-sniffing
 * anti-pattern the evals-rebuild spine eliminated (see classifyInfraFailure's
 * own doc comment): a real judge verdict whose reasoning happens to discuss
 * "authentication" (very plausible in Kaya's own domain right now) never
 * sets `details.judge_error`, so it can never false-positive here.
 * matchKnownInfraSignature() (TrialRunner.ts, reused not duplicated) then
 * classifies the machine-authored judge_error TEXT itself — safe because
 * that field only ever exists on the judge's own inference-failure path
 * (never on the agent's answer, never on a real verdict's reasoning).
 *
 * Verified against MEMORY/VALIDATION/evals/2026-07-14/kaya-pipeline-nightly-results.jsonl:
 * the 9 hard-`0` nightly_judge tasks that night are exactly this shape; the
 * 3 non-zero tasks that same run (0.5/0.35/1.0) are fixture_accuracy —
 * code-based, no judgeInference() call, unaffected — confirming this isn't
 * "every task scored 0" but specifically "every JUDGE-graded task did."
 */
export function isAuthShapedJudgeFailureRun(run: EvalRun): boolean {
  // Defensive: summarizeSuiteRuns()'s own tests construct minimal EvalRun
  // fixtures that intentionally omit `trials` (its documented contract is
  // "only reads 4 fields": n_trials/infra_failures/pass_rate/mean_score) —
  // an absent/malformed trials array is never auth-shaped, never a throw.
  if (!Array.isArray(run.trials) || run.trials.length === 0) return false;
  const behavioralTrials = run.trials.filter(t => t.status !== 'infra_failure');
  if (behavioralTrials.length === 0) return false;
  return behavioralTrials.every(trial => {
    if (trial.grader_results.length === 0) return false;
    return trial.grader_results.every(g => {
      const judgeError = g.details?.['judge_error'];
      return typeof judgeError === 'string' && matchKnownInfraSignature(judgeError) === 'auth_error';
    });
  });
}

/**
 * A fixture_accuracy task run whose score is error-fallback noise, not
 * judgment (S5 residual, 401-storm 2026-07-16). The two guards above can't
 * see this shape: the runner's per-fixture live inference() calls fail
 * inside setup_commands (agent spawn is skipped for these tasks, so no
 * infra_failure_type; no judge grader, so no judge_error), and the runner's
 * catch-block fallback `actual` can coincidentally match negative-class
 * fixtures' expected values — a misleading NON-zero partial score
 * (kaya_prompt_classification 0.353, kaya_learning_capture 0.5 on
 * 07-14/07-15) with 0% genuine judgment, which sailed past the zero-only
 * auth-shaped guard and poisoned the rolling regression baselines.
 *
 * Classification keys on GraderResult.details.fixture_infra_error — a
 * STRUCTURED, machine-authored marker FixtureAccuracy.ts emits ONLY when a
 * strict majority of the record's fixtures carry the runner's own
 * `infra_error` field (set exclusively in the runner's catch block, never on
 * a judged fixture). Same doctrine as details.judge_error: a field's
 * presence, not output-text sniffing, so a real fixture answer discussing
 * errors can never false-positive. A minority of errored fixtures does NOT
 * trip this — each already counts incorrect in the record, a real (if
 * depressed) behavioral signal.
 */
export function isErrorFallbackFixtureRun(run: EvalRun): boolean {
  // Same defensive shape as isAuthShapedJudgeFailureRun — minimal EvalRun
  // fixtures without `trials` are never error-fallback, never a throw.
  if (!Array.isArray(run.trials) || run.trials.length === 0) return false;
  const behavioralTrials = run.trials.filter(t => t.status !== 'infra_failure');
  if (behavioralTrials.length === 0) return false;
  return behavioralTrials.every(trial => {
    if (trial.grader_results.length === 0) return false;
    return trial.grader_results.every(g => g.details?.['fixture_infra_error'] !== undefined);
  });
}

/**
 * THE single authoritative check for "did this task pass" at SUITE-reporting
 * granularity (console summary, persisted eval payload, suite exit code) —
 * evals-rebuild slice B1.
 *
 * Task.pass_threshold (YAML default 0.75, commonly 0.80-0.90 in the live
 * corpus) is applied EXACTLY ONCE, upstream, inside runGraders()
 * (Graders/Base.ts) — it gates whether each individual TRIAL's `passed`
 * field is true. By the time an EvalRun reaches here, every one of its
 * trials has ALREADY been scored against the task's real configured bar.
 * This function then asks a DIFFERENT question — not "was any one trial's
 * score good enough" (already answered per-trial) but "were ALL trials of
 * this task consistent" — so it requires unanimity (`pass_rate === 1`)
 * rather than re-applying a SECOND, independent score threshold.
 *
 * This replaces two previously-duplicated (and one outright dead/buggy)
 * hardcoded `>= 0.75` checks:
 *   - summarizeSuiteRuns() and the persistPayload builder both hardcoded
 *     `run.pass_rate >= 0.75` independently (drift risk: two literals that
 *     could silently diverge).
 *   - The persistPayload builder ALSO read `run.pass_threshold ?? 0.75` —
 *     but `EvalRun` (Types/index.ts) never had a `pass_threshold` field,
 *     so that read was always `undefined` and ALWAYS silently fell back to
 *     0.75, completely disconnected from the task's real configured value.
 *     `bun build` doesn't type-check (no tsc gate), so this dead property
 *     read shipped silently — see
 *     MEMORY/SkillAudits/evals-infra-audit-2026-07-09/graders.md.
 *
 * Behavior for the ENTIRE live corpus (trials ∈ {1,2,3} — confirmed via
 * `grep -rn "^trials:" UseCases/ Suites/`) is IDENTICAL to the old
 * `pass_rate >= 0.75` check: the only pass_rate fractions reachable below
 * 1.0 at those trial counts are 0, 0.33/0.5, 0.67 — all < 0.75 regardless,
 * so requiring `=== 1` changes nothing observable today. It only matters
 * (deliberately, by design) for a hypothetical future task with 4+ trials,
 * where it now demands ALL trials pass rather than merely "at least 75%".
 */
export function taskPassedInSuite(run: EvalRun): boolean {
  return run.pass_rate >= 1;
}

/**
 * Suite-level summary, computed purely from completed task runs.
 *
 * A task whose EVERY trial was an infra failure (transient inference timeout,
 * econnreset, empty response) carries NO behavioral signal — TrialRunner already
 * excludes infra trials from per-task pass_rate; this mirrors that at the suite
 * level so one transient timeout can't flip a healthy suite to FAILED. The
 * `ok` flag requires real signal (`scored > 0`) so an all-infra suite still FAILs
 * (no `0 === 0` false-pass). Genuine `error`-status trials (e.g. a code crash) are
 * NOT infra failures and stay counted.
 *
 * S5 (401 auth-storm): a task whose zero score is entirely explained by the
 * JUDGE's own nested inference() call failing (isAuthShapedJudgeFailureRun —
 * a DIFFERENT no-behavioral-signal shape than isInfraSkippedRun, see that
 * function's doc comment) is excluded the SAME way, through the SAME
 * counter — one funnel, so this console summary and runSuite()'s persisted
 * payload can never disagree on the denominator (the exact bug class
 * MEMORY/SkillAudits/evals-infra-audit-2026-07-09/gap.md finding 2 named).
 */
export function summarizeSuiteRuns(runs: EvalRun[]): {
  passed: number;
  failed: number;
  total: number;
  meanScore: number;
  infraSkipped: number;
  ok: boolean;
} {
  let passed = 0;
  let totalScore = 0;
  let scored = 0;
  let infraSkipped = 0;
  for (const run of runs) {
    if (isInfraSkippedRun(run) || isAuthShapedJudgeFailureRun(run) || isErrorFallbackFixtureRun(run)) {
      infraSkipped++;
      continue;
    }
    scored++;
    if (taskPassedInSuite(run)) passed++;
    totalScore += run.mean_score;
  }
  return {
    passed,
    failed: scored - passed,
    total: scored,
    meanScore: scored > 0 ? totalScore / scored : 0,
    infraSkipped,
    ok: scored > 0 && passed === scored,
  };
}

/**
 * Structured "latest suite run" handoff — evals-rebuild slice A7.
 *
 * Before this, bin/kaya-evals-nightly.ts regexed EvalExecutor's console
 * stdout/stderr (`Tasks: N`, `Running task: <id>`, `Trial N: ✅ (score: X)`,
 * `Error running`) to decide pass/fail and to guard the 2026-06-19 Zod-4
 * "0 useful evals" incident (see MEMORY/SkillAudits/evals-infra-audit-2026-07-09/
 * nightly.md) — brittle free-text sniffing of our own machine output.
 * EvalExecutor and kaya-evals-nightly are both Kaya-owned, so this boundary
 * should carry structured data (framework category B), not console prose.
 *
 * Every `suite` run now overwrites ONE JSON "latest" pointer per suite name
 * at getSuiteSummaryPath(). It is NOT the store of record — the append-only
 * MEMORY/VALIDATION/evals/<date>/<suite>-results.jsonl (ResultsPersistence.ts,
 * written just above in runSuite()) keeps that role for history/trend. This
 * file exists purely for same-box, same-invocation machine-to-machine
 * handoff: "what did the suite I just shelled out to actually do."
 */
export interface SuiteSummaryTask {
  task_id: string;
  status: 'passed' | 'failed' | 'infra_skipped' | 'error' | 'not_found';
  mean_score: number;
  pass: boolean;
  pass_rate: number;
  infra_failures: number;
  n_trials: number;
  /** Present only for status:'error' — the caught exception's message. */
  error?: string;
}

export interface SuiteSummaryFile {
  suite: string;
  tasks: SuiteSummaryTask[];
  summary: {
    /** Tasks registered to run (post --quick/--sample filtering), BEFORE any
     *  exclusion — matches the old console "Tasks: N" header. */
    total: number;
    /** Tasks that produced real behavioral signal — excludes infra_skipped,
     *  error, and not_found tasks. Same "scored" vocabulary summarizeSuiteRuns
     *  already uses internally. */
    scored: number;
    passed: number;
    failed: number;
    infra_skipped: number;
    mean_score: number;
    started_at: string;
    finished_at: string;
    wall_ms: number;
  };
}

/**
 * Path for the suite-summary JSON handoff file. Exported so consumers (e.g.
 * bin/kaya-evals-nightly.ts) resolve the EXACT same path this writer uses —
 * one source of truth, no drift between producer and consumer. Resolved
 * LAZILY at call time (never frozen at import — see CLAUDE_HOME's own comment
 * above for the anti-pattern this avoids) so KAYA_HOME overrides set by tests
 * after this module loads still land the file under the pinned tmpdir, never
 * the live tree. Mirrors ResultsPersistence.ts's validationDir() convention.
 */
export function getSuiteSummaryPath(suiteName: string): string {
  return join(getKayaHome(), 'MEMORY', 'VALIDATION', 'evals', 'last-suite-run', `${suiteName}.json`);
}

/**
 * Atomically write the suite summary (tmp file in the same dir, then rename
 * — matches the tmp+rename convention used elsewhere, e.g.
 * lib/core/MemoryPaths.ts's defineFileAccessor.write() and
 * lib/core/FailureLog.ts's atomic rewrite). Throws on failure — NO silent
 * containment: a consumer relies on this file to make a page/no-page
 * decision, so a write failure must surface loudly (the caller's own
 * try/catch — or lack of one — decides what happens next), never be
 * swallowed here.
 */
export function writeSuiteSummaryFile(file: SuiteSummaryFile): string {
  const path = getSuiteSummaryPath(file.suite);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(file, null, 2), 'utf-8');
  renameSync(tmpPath, path);
  return path;
}

// Circuit breaker (S5, 401 auth-storm remediation): 3 consecutive hard
// task-run failures (isInfraSkippedRun — every trial's underlying
// `claude -p` spawn itself failed, exit≠0/empty output — or a thrown
// execution error) mean the outage is systemic (e.g. a dead auth token), not
// one flaky task. Burning through the rest of the suite one task at a time
// just piles up the identical failure with zero chance of a real result.
const SUITE_CIRCUIT_BREAKER_THRESHOLD = 3;

export async function runSuite(
  suiteName: string,
  options: {
    trials?: number;
    timeout?: number;
    systemContext?: string;
    quick?: boolean;
    sample?: number;
    /** Test-only executor override, forwarded to every runTask() call this
     *  suite run makes. See runTask()'s doc comment. */
    executor?: TaskExecutor;
    /** Forwarded to every runTask() call — see runTask()'s doc comment. */
    env?: Record<string, string>;
    model?: string;
    noSessionPersistence?: boolean;
    /** Restrict the run to these task ids (subset of the suite's list; ids
     *  not in the suite are reported and skipped). */
    taskFilter?: string[];
    /** Default true. `false` skips BOTH the MEMORY/VALIDATION/evals/ JSONL
     *  append and the last-suite-run summary file — for runs that must not
     *  feed RegressionAlert's rolling baselines or EvalHealthDigest (setup
     *  ablation cells run the same suite under a deliberately degraded
     *  config; persisting them would poison the baseline for that suite).
     *  The per-task Results/<task>/run_<id>.json dumps still happen. */
    persist?: boolean;
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
  const suiteStartedAt = new Date();
  const suiteStartPerf = performance.now();

  const suite = loadSuite(suiteName);
  if (!suite) {
    throw new Error(`Suite not found: ${suiteName}`);
  }

  let taskIds = [...suite.tasks];

  if (options.taskFilter?.length) {
    const wanted = new Set(options.taskFilter);
    const unknown = options.taskFilter.filter(id => !suite.tasks.includes(id));
    if (unknown.length) {
      console.log(`  [filter] Not in suite ${suite.name}, skipped: ${unknown.join(', ')}`);
    }
    taskIds = taskIds.filter(id => wanted.has(id));
    console.log(`  [filter] Restricted to ${taskIds.length}/${suite.tasks.length} task(s)`);
  }

  // --quick: filter to only code-based grader tasks
  if (options.quick) {
    const codeBased = codeBasedGraderTypes();
    const filtered: string[] = [];
    for (const taskId of taskIds) {
      const taskPath = findTaskFile(taskId);
      if (!taskPath) continue;
      try {
        const task = loadTaskConfig(taskPath);
        const allCodeBased = task.graders?.every(g => codeBased.has(g.type)) ?? true;
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
  // Per-task records for the structured suite-summary handoff (getSuiteSummaryPath) —
  // built alongside `results` so every taskId's fate (not just the ones that
  // completed a run) is captured: not-found and thrown-exception tasks never
  // get pushed to `results` but still need a status here for consumers.
  const taskRecords: SuiteSummaryTask[] = [];

  let consecutiveHardFailures = 0;

  for (let idx = 0; idx < taskIds.length; idx++) {
    const taskId = taskIds[idx]!;
    const taskPath = findTaskFile(taskId);
    if (!taskPath) {
      console.log(`  ⚠️  Task not found: ${taskId}`);
      taskRecords.push({
        task_id: taskId, status: 'not_found', mean_score: 0, pass: false,
        pass_rate: 0, infra_failures: 0, n_trials: 0,
      });
      // A missing task FILE is a config/registry issue, never attempted a
      // spawn — doesn't feed (and isn't reset by) the hard-failure streak.
      continue;
    }

    let hardFailure = false;
    try {
      const run = await runTask(taskPath, {
        trials: options.trials,
        timeout: options.timeout,
        systemContext: options.systemContext,
        executor: options.executor,
        env: options.env,
        model: options.model,
        noSessionPersistence: options.noSessionPersistence,
      });
      results.push(run);

      // A task whose EVERY trial was an infra failure (e.g. a transient inference
      // timeout on the heavy meta-eval) carries no behavioral signal. summarizeSuiteRuns
      // excludes it from the suite pass/mean (mirroring TrialRunner's per-task pass_rate).
      // Logged here for per-task visibility (no silent containment).
      const infraSkipped = isInfraSkippedRun(run);
      hardFailure = infraSkipped;
      if (infraSkipped) {
        console.log(`  ⚠️  ${taskId}: all ${run.infra_failures}/${run.n_trials} trial(s) infra-failed — excluded from suite pass/mean (transient infra, not a behavioral result)`);
        taskRecords.push({
          task_id: taskId, status: 'infra_skipped', mean_score: run.mean_score, pass: false,
          pass_rate: run.pass_rate, infra_failures: run.infra_failures, n_trials: run.n_trials,
        });
      } else if (isAuthShapedJudgeFailureRun(run)) {
        // Agent spawn succeeded; the JUDGE's own nested inference call
        // 401'd — see isAuthShapedJudgeFailureRun()'s doc comment. Same
        // "no behavioral signal" treatment as an infra-skipped run, but
        // NOT a spawn failure itself (the agent spawn worked), so it does
        // not feed the circuit breaker's streak.
        console.log(`  🚨 ${taskId}: zero score from an auth-shaped JUDGE inference failure (structured GraderResult.details.judge_error, not agent behavior) — excluded from the results store and regression detection`);
        taskRecords.push({
          task_id: taskId, status: 'infra_skipped', mean_score: run.mean_score, pass: false,
          pass_rate: run.pass_rate, infra_failures: run.infra_failures, n_trials: run.n_trials,
        });
      } else if (isErrorFallbackFixtureRun(run)) {
        // The fixture-runner's per-fixture live calls majority-failed and
        // the score is error-fallback noise — see isErrorFallbackFixtureRun()'s
        // doc comment. Same "no behavioral signal" treatment; like the
        // auth-shaped branch, not a spawn failure (fixture tasks skip the
        // agent spawn entirely), so it does not feed the circuit breaker.
        console.log(`  🚨 ${taskId}: fixture-runner infra failure (structured GraderResult.details.fixture_infra_error — majority of fixtures errored, results are fallback defaults not judgments) — excluded from the results store and regression detection`);
        taskRecords.push({
          task_id: taskId, status: 'infra_skipped', mean_score: run.mean_score, pass: false,
          pass_rate: run.pass_rate, infra_failures: run.infra_failures, n_trials: run.n_trials,
        });
      } else {
        // Single authoritative check — see taskPassedInSuite()'s doc comment.
        const pass = taskPassedInSuite(run);
        taskRecords.push({
          task_id: taskId, status: pass ? 'passed' : 'failed', mean_score: run.mean_score, pass,
          pass_rate: run.pass_rate, infra_failures: run.infra_failures, n_trials: run.n_trials,
        });
      }
    } catch (e) {
      console.error(`  ❌ Error running ${taskId}: ${e}`);
      taskRecords.push({
        task_id: taskId, status: 'error', mean_score: 0, pass: false,
        pass_rate: 0, infra_failures: 0, n_trials: 0, error: String(e),
      });
      hardFailure = true;
    }

    consecutiveHardFailures = hardFailure ? consecutiveHardFailures + 1 : 0;

    // Circuit breaker (S5): 3 consecutive hard spawn failures — abort the
    // remaining tasks and report exactly what was skipped, once. No silent
    // cap: every skipped task still gets a taskRecord naming the reason.
    if (consecutiveHardFailures >= SUITE_CIRCUIT_BREAKER_THRESHOLD) {
      const skipped = taskIds.slice(idx + 1);
      if (skipped.length > 0) {
        console.error(
          `  🚨 CIRCUIT BREAKER: ${consecutiveHardFailures} consecutive hard spawn failures — ` +
          `aborting suite run. ${skipped.length} remaining task(s) skipped, never attempted: ${skipped.join(', ')}`
        );
        for (const skippedId of skipped) {
          taskRecords.push({
            task_id: skippedId, status: 'error', mean_score: 0, pass: false,
            pass_rate: 0, infra_failures: 0, n_trials: 0,
            error: `skipped: circuit breaker tripped after ${consecutiveHardFailures} consecutive hard spawn failures`,
          });
        }
      }
      break;
    }
  }

  const summary = summarizeSuiteRuns(results);

  // Print summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Suite Summary: ${suiteName}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Tasks passed: ${summary.passed}/${summary.total}`);
  console.log(`  Mean score: ${(summary.meanScore * 100).toFixed(1)}%`);
  if (summary.infraSkipped > 0) {
    console.log(`  Infra-skipped: ${summary.infraSkipped} task(s) (all trials infra-failed — excluded from pass/mean)`);
  }
  if (summary.total === 0 && results.length > 0) {
    console.log(`  ⚠️  NO BEHAVIORAL SIGNAL: every task infra-failed — suite FAILED (not a pass)`);
  }
  console.log(`  Status: ${summary.ok ? '✅ PASSED' : '❌ FAILED'}`);

  // Persist results to MEMORY/VALIDATION/evals/ for Learning & Memory tracking.
  // Uses the SAME exclusion rule as the console summary above
  // (isInfraSkippedRun + isAuthShapedJudgeFailureRun, S5) so total_evals/
  // passed_evals in the persisted JSONL always match "Tasks passed: X/Y"
  // here — previously they disagreed (5/5 vs 5/6 for one run) because only
  // the console path excluded all-infra-failed tasks. A run whose zero score
  // is entirely a 401 auth-storm judge-inference failure (structured
  // GraderResult.details.judge_error, not agent behavior) writes NOTHING to
  // the store and therefore can never trip RegressionAlert's pass-rate-zero
  // tripwire or a delta-vs-baseline false regression for that task.
  const scoredResults = results.filter(run =>
    !isInfraSkippedRun(run) && !isAuthShapedJudgeFailureRun(run) && !isErrorFallbackFixtureRun(run));
  const persistPayload = scoredResults.map(run => ({
    eval: {
      eval_name: run.task_id,
      category: run.task_id.split('_')[0] ?? 'general',
      scores: [run.mean_score],
      passed: [taskPassedInSuite(run)],
      grader_details: [],
    } satisfies PersistEvalResult,
    metrics: {
      pass_rate: run.pass_rate,
      pass_at_k: run.pass_at_k ?? run.pass_rate,
      pass_all_k: run.pass_all_k ?? run.pass_rate,
    },
  }));
  const persist = options.persist ?? true;
  if (persist) {
    const persistPath = persistSuiteResults(suiteName, persistPayload);
    console.log(`  Results persisted: ${persistPath}`);
  } else {
    console.log(`  Results NOT persisted (persist:false — ${persistPayload.length} scored task(s) kept out of the regression store)`);
  }

  // Structured machine-to-machine handoff (evals-rebuild A7) — see
  // SuiteSummaryFile's doc comment above. Written LAST, after every other
  // side effect has succeeded, so consumers polling for freshness never see
  // a summary whose console/persisted counterparts are still in flight.
  // No try/catch: a write failure here must propagate loudly (the whole
  // point is that a consumer trusting a missing/stale file fails loud too —
  // silently swallowing the write error would defeat that).
  const finishedAt = new Date();
  const summaryFile: SuiteSummaryFile = {
    suite: suiteName,
    tasks: taskRecords,
    summary: {
      total: taskIds.length,
      scored: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      infra_skipped: summary.infraSkipped,
      mean_score: summary.meanScore,
      started_at: suiteStartedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      wall_ms: Math.round(performance.now() - suiteStartPerf),
    },
  };
  if (persist) {
    const summaryPath = writeSuiteSummaryFile(summaryFile);
    console.log(`  Suite summary written: ${summaryPath}`);
  }

  return { results, summary };
}

// findTaskFile is imported from ./shared/TaskUtils.ts (evals-rebuild slice
// A6) — this file previously carried its own private, un-imported duplicate
// of findTaskFile/collectSearchDirs (filename-GUESSING, not id-resolving)
// that SuiteManager.ts's copy of the same logic had already been extracted
// away from in slice A5. Deleted; see TaskUtils.ts for the real id->path
// index every resolution call site (here, and SuiteManager.ts) now shares.

// ============================================================================
// CLI Interface
// ============================================================================

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      task: { type: 'string', short: 't' },
      name: { type: 'string', short: 'n' },
      // No default here: an omitted --trials must stay undefined so the task
      // yaml's `trials:` wins (precedence: --trials flag > task yaml > 1).
      // A default of '1' silently clamped every yaml `trials: N` down to 1.
      trials: { type: 'string' },
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
  bun run EvalExecutor.ts run -t UseCases/QueueRouter/kaya_router_disposition_golden.yaml

  # Smoke test a suite (validate configs only)
  bun run EvalExecutor.ts smoke --name kaya-pipeline-nightly

  # Run only fast code-based tasks
  bun run EvalExecutor.ts suite --name kaya-pipeline-nightly --quick

  # Run a random sample of 5 tasks
  bun run EvalExecutor.ts suite --name kaya-pipeline-nightly --sample 5

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
          process.exit(taskPassedInSuite(run) ? 0 : 1);
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
          process.exit(summary.ok ? 0 : 1);
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

      // Grader registry: type resolution + categorization both derive from
      // here (evals-rebuild slice A6) — never a hand-maintained list.
      const { listGraders, categoryOf } = await import('../Graders/Base.ts');
      const registeredGraders = new Set(listGraders());

      let issues = 0;
      let valid = 0;
      const graderTypeCounts: Partial<Record<GraderType, number>> = {};

      for (const taskId of suite.tasks) {
        // id->path resolution via the real index (Tools/shared/TaskUtils.ts)
        // — never a filename guess.
        const taskPath = findTaskFile(taskId);
        if (!taskPath) {
          console.log(`  ❌ ${taskId}: unknown task id — no UseCases/**/*.yaml file declares id: ${taskId}`);
          issues++;
          continue;
        }

        // Shared TaskSchema validation (Types/schemas.ts) — the same schema
        // runTask()/TaskValidator.ts use — replaces the old hand-rolled
        // "missing id/description/graders" + "pass_threshold in [0,1]"
        // checks below, which independently re-implemented a subset of what
        // TaskSchema already enforces.
        let task: Task;
        try {
          task = loadTaskConfig(taskPath);
        } catch (e) {
          console.log(`  ❌ ${taskId}: ${e instanceof Error ? e.message : String(e)}`);
          issues++;
          continue;
        }

        // Defense-in-depth: TaskSchema's GraderTypeSchema enum already
        // rejects any grader.type outside its static list at parse time —
        // this catches the OPPOSITE drift direction, a type the enum still
        // lists but whose class was deregistered (see TaskValidator.ts's
        // identical check / evals audit finding #3).
        const unknownGraders = task.graders.filter(g => !registeredGraders.has(g.type));
        if (unknownGraders.length > 0) {
          console.log(`  ⚠️  ${taskId}: unknown graders: ${unknownGraders.map(g => g.type).join(', ')}`);
          issues++;
          continue;
        }

        for (const g of task.graders) {
          graderTypeCounts[g.type] = (graderTypeCounts[g.type] ?? 0) + 1;
        }

        valid++;
      }

      console.log(`\n${'='.repeat(50)}`);
      console.log(`Smoke Test Results: ${suite.name}`);
      console.log(`${'='.repeat(50)}`);
      console.log(`  Valid: ${valid}/${suite.tasks.length}`);
      console.log(`  Issues: ${issues}`);
      console.log(`\n  Grader distribution:`);
      for (const [type, count] of Object.entries(graderTypeCounts).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))) {
        const category = categoryOf(type as GraderType) === 'model_based' ? 'model' : 'code';
        console.log(`    ${type}: ${count} (${category})`);
      }
      console.log(`\n  Status: ${issues === 0 ? '✅ ALL CONFIGS VALID' : `⚠️  ${issues} ISSUES FOUND`}`);
      process.exit(issues === 0 ? 0 : 1);
    }

    case 'list-graders': {
      // Derived from the live registry (evals-rebuild slice A6) — never a
      // hand-maintained list. Descriptions below are cosmetic display text
      // keyed by type (a lookup miss just omits the description, never
      // hides or miscategorizes a grader), not a categorization decision.
      const { listGradersByCategory } = await import('../Graders/Base.ts');
      const buckets = listGradersByCategory();
      const descriptions: Partial<Record<GraderType, string>> = {
        string_match: 'Exact substring matching',
        regex_match: 'Pattern matching',
        binary_tests: 'Run test files',
        state_check: 'Verify system state after execution',
        tool_calls: 'Verify specific tools were called',
        fixture_accuracy: "Grade a live fixture-runner's accuracy record (see setup_commands)",
        llm_rubric: 'Score against detailed rubric',
        natural_language_assert: 'Check assertions are true',
        ensemble_label: 'Consensus labeling via parallel fast/standard/smart inference; divergence flagged',
        nightly_judge: 'Static-input grader: scores a pre-existing decision record against a golden label',
      };
      const printBucket = (types: GraderType[]) => {
        for (const type of types) {
          const desc = descriptions[type];
          console.log(desc ? `  - ${type}    ${desc}` : `  - ${type}`);
        }
      };

      console.log('\nAvailable Graders:\n');
      console.log('Code-Based (fast, deterministic):');
      printBucket(buckets.code_based);
      console.log('\nModel-Based (nuanced):');
      printBucket(buckets.model_based);
      if (buckets.human.length > 0) {
        console.log('\nHuman (gold standard):');
        printBucket(buckets.human);
      }
      console.log('');
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}
