#!/usr/bin/env bun
/**
 * ============================================================================
 * AGENT ORCHESTRATOR - Unified Agent Spawning and Result Aggregation
 * ============================================================================
 *
 * PURPOSE:
 * Formalizes parallel agent spawning, result aggregation, spotcheck patterns,
 * and debate workflows used across Kaya. Provides a single unified interface
 * for all multi-agent operations.
 *
 * PATTERNS IMPLEMENTED:
 * - Parallel spawning with concurrency limits
 * - Result aggregation (voting, synthesis, merge, first, best)
 * - Spotcheck verification pattern
 * - Council-style debate from Council skill
 * - Voice announcements for agent results
 *
 * USAGE:
 *   # CLI - Spawn agents
 *   bun run AgentOrchestrator.ts spawn --agents "ClaudeResearcher,GeminiResearcher" --task "Research AI safety"
 *
 *   # CLI - Spawn with aggregation
 *   bun run AgentOrchestrator.ts aggregate --agents "Intern:5" --task "Analyze company" --strategy synthesis
 *
 *   # CLI - Spotcheck work
 *   bun run AgentOrchestrator.ts spotcheck --work "implementation code" --criteria "No vulnerabilities,Tests pass"
 *
 *   # CLI - Debate
 *   bun run AgentOrchestrator.ts debate --topic "Microservices vs Monolith" --rounds 3
 *
 *   # Programmatic
 *   import { orchestrator, createOrchestrator } from './AgentOrchestrator.ts';
 *   const results = await orchestrator.spawn([...agents], task);
 *
 * BILLING: Uses Claude CLI (Task tool) with subscription
 *
 * ============================================================================
 */

import { spawn } from "child_process";
import { CLAUDE_PATH } from "./Inference.ts";
import { parseArgs } from "util";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { TeamsBridge } from "./TeamsBridge.ts";
import type { TeamConfig, TeamMemberSpec } from "./TeamsBridge.ts";
import { getOrCreateWorktree } from "./WorktreeManager.ts";

// ============================================================================
// Types
// ============================================================================

export type AggregationStrategy = 'voting' | 'synthesis' | 'merge' | 'first' | 'best';
export type AgentModel = 'haiku' | 'sonnet' | 'opus';

/**
 * Specification for an agent to spawn
 */
export interface AgentSpec {
  /** Task tool subagent_type (ClaudeResearcher, Intern, Engineer, etc.) */
  type: string;
  /** Display name for results (defaults to type) */
  name?: string;
  /** Number of agents of this type to spawn (default: 1) */
  count?: number;
  /** Model to use for this agent */
  model?: AgentModel;
  /** ElevenLabs voice ID for result announcements */
  voiceId?: string;
  /** Timeout in milliseconds (default: from orchestrator options) */
  timeout?: number;
  /** Traits for AgentFactory composition (if using dynamic agents) */
  traits?: string[];
  /** Custom prompt prefix to inject before task */
  promptPrefix?: string;
  /** Working directory for this agent (repo root for worktree creation) */
  workingDir?: string;
  /** Branch to work on — triggers worktree creation when paired with workingDir */
  branch?: string;
}

/**
 * Result from a single agent execution
 */
export interface AgentResult {
  /** Unique ID for this agent execution */
  agentId: string;
  /** The subagent_type used */
  agentType: string;
  /** Display name */
  agentName: string;
  /** Whether execution succeeded */
  success: boolean;
  /** The agent's output (if successful) */
  result?: string;
  /** Error message (if failed) */
  error?: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Model used */
  model: AgentModel;
  /** Voice ID for announcements */
  voiceId?: string;
}

/**
 * Result from spotcheck verification
 */
export interface SpotcheckResult {
  /** Whether work passed all criteria */
  passed: boolean;
  /** Overall score 0-100 */
  score: number;
  /** Issues found */
  issues: string[];
  /** Recommendations for improvement */
  recommendations: string[];
  /** Per-criterion results */
  criteriaResults: Array<{
    criterion: string;
    passed: boolean;
    notes: string;
  }>;
}

/**
 * Single round in a debate
 */
export interface DebateRound {
  round: number;
  arguments: Array<{
    agent: string;
    position: string;
    argument: string;
  }>;
}

/**
 * Full debate result
 */
export interface DebateResult {
  topic: string;
  rounds: DebateRound[];
  conclusion: string;
  convergencePoints: string[];
  disagreements: string[];
}

/**
 * Options for orchestrator operations
 */
export interface OrchestratorOptions {
  /** Run agents in parallel (default: true) */
  parallel?: boolean;
  /** Maximum concurrent agents (default: 5) */
  maxConcurrent?: number;
  /** Default model for agents without explicit model */
  defaultModel?: AgentModel;
  /** Default timeout in ms (default: 60000) */
  defaultTimeout?: number;
  /** Progress callback */
  onProgress?: (completed: number, total: number, result: AgentResult) => void;
  /** Announce results via voice server */
  announceResults?: boolean;
  /** Voice ID for announcements (uses agent voiceId if available) */
  voiceId?: string;
}

/**
 * Main orchestrator interface
 */
export interface AgentOrchestrator {
  /**
   * Spawn multiple agents to work on a task
   */
  spawn(
    agents: AgentSpec[],
    task: string,
    options?: OrchestratorOptions
  ): Promise<AgentResult[]>;

  /**
   * Spawn agents and aggregate their results
   */
  spawnWithAggregation(
    agents: AgentSpec[],
    task: string,
    strategy: AggregationStrategy,
    options?: OrchestratorOptions
  ): Promise<{ results: AgentResult[]; aggregated: string }>;

  /**
   * Verify work against criteria (spotcheck pattern)
   */
  spotcheck(
    work: string,
    criteria: string[],
    options?: { model?: AgentModel; strict?: boolean }
  ): Promise<SpotcheckResult>;

  /**
   * Run a structured debate between agents
   */
  debate(
    topic: string,
    positions: Array<{ agent: AgentSpec; position: string }>,
    rounds?: number
  ): Promise<DebateResult>;

  /**
   * Spawn agents as a coordinated team using TeamsBridge.
   * Each agent runs in its own Claude Code process with P2P messaging.
   * Falls back to regular spawn() when Agent Teams is unavailable.
   */
  spawnAsTeam(
    agents: AgentSpec[],
    task: string,
    teamConfig?: Partial<TeamConfig>
  ): Promise<AgentResult[]>;

  /**
   * Cancel a running agent
   */
  cancel(agentId: string): Promise<void>;

  /**
   * Cancel all running agents
   */
  cancelAll(): Promise<void>;

  /**
   * Get currently running agents
   */
  getRunning(): AgentResult[];
}

// ============================================================================
// Constants
// ============================================================================

const HOME = homedir();
const KAYA_DIR = process.env.KAYA_DIR || join(HOME, '.claude');
const VOICE_SERVER_URL = 'http://localhost:8888/notify';
const AGENT_FACTORY_PATH = join(KAYA_DIR, 'skills/Agents/Tools/AgentFactory.ts');
const INFERENCE_PATH = join(KAYA_DIR, 'lib/core/Inference.ts');

// Model timeout defaults
const MODEL_TIMEOUTS: Record<AgentModel, number> = {
  haiku: 30000,
  sonnet: 60000,
  opus: 120000,
};

// ============================================================================
// Utilities
// ============================================================================

/**
 * Generate unique agent ID
 */
function generateAgentId(): string {
  return `agent_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

/**
 * Send voice notification (fire and forget)
 */
async function announceVoice(
  message: string,
  voiceId?: string,
  title?: string
): Promise<void> {
  try {
    const body: Record<string, string> = { message };
    if (voiceId) body.voice_id = voiceId;
    if (title) body.title = title;

    // Fire and forget - don't await
    fetch(VOICE_SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {
      // Silently ignore voice server errors
    });
  } catch {
    // Silently ignore
  }
}

/**
 * Run inference using the Inference tool
 */
async function runInference(
  systemPrompt: string,
  userPrompt: string,
  level: 'fast' | 'standard' | 'smart' = 'standard',
  expectJson = false
): Promise<{ success: boolean; output: string; parsed?: unknown }> {
  return new Promise((resolve) => {
    const args = [
      'run',
      INFERENCE_PATH,
      '--level', level,
    ];
    if (expectJson) args.push('--json');
    args.push(systemPrompt, userPrompt);

    let stdout = '';
    let stderr = '';

    const proc = spawn('bun', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({
          success: false,
          output: stderr || `Inference failed with code ${code}`,
        });
        return;
      }

      const output = stdout.trim();
      if (expectJson) {
        try {
          const parsed = JSON.parse(output);
          resolve({ success: true, output, parsed });
        } catch {
          resolve({ success: false, output, parsed: undefined });
        }
      } else {
        resolve({ success: true, output });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, output: err.message });
    });
  });
}

/**
 * Compose dynamic agent prompt using AgentFactory
 */
async function composeAgentPrompt(
  traits: string[],
  task: string
): Promise<{ prompt: string; voiceId?: string }> {
  return new Promise((resolve) => {
    const args = [
      'run',
      AGENT_FACTORY_PATH,
      '--traits', traits.join(','),
      '--task', task,
      '--output', 'json',
    ];

    let stdout = '';

    const proc = spawn('bun', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ prompt: task });
        return;
      }

      try {
        const result = JSON.parse(stdout);
        resolve({
          prompt: result.prompt || task,
          voiceId: result.voice_id,
        });
      } catch {
        resolve({ prompt: task });
      }
    });

    proc.on('error', () => {
      resolve({ prompt: task });
    });
  });
}

// ============================================================================
// Agent Execution Engine
// ============================================================================

// Track running agents for cancellation
const runningAgents = new Map<string, { proc: ReturnType<typeof spawn>; result: Partial<AgentResult> }>();

/**
 * Execute a single agent using the Task tool pattern
 *
 * Uses claude -p for non-interactive execution with proper model selection.
 */
async function executeAgent(
  spec: AgentSpec,
  task: string,
  options: OrchestratorOptions
): Promise<AgentResult> {
  const agentId = generateAgentId();
  const model = spec.model || options.defaultModel || 'sonnet';
  const timeout = spec.timeout || options.defaultTimeout || MODEL_TIMEOUTS[model];
  const agentName = spec.name || spec.type;
  const startTime = Date.now();

  // Build the prompt
  let prompt = task;
  if (spec.promptPrefix) {
    prompt = `${spec.promptPrefix}\n\n${task}`;
  }

  // If using traits, compose via AgentFactory
  let voiceId = spec.voiceId;
  if (spec.traits && spec.traits.length > 0) {
    const composed = await composeAgentPrompt(spec.traits, task);
    prompt = composed.prompt;
    voiceId = voiceId || composed.voiceId;
  }

  return new Promise((resolve) => {
    // Build environment WITHOUT ANTHROPIC_API_KEY to force subscription auth
    // Also strip CLAUDECODE and CLAUDE_CODE_* vars to prevent nested-session detection
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDECODE;
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE_CODE_') && key !== 'CLAUDE_CODE_OAUTH_TOKEN') {
        delete env[key];
      }
    }

    // FIXED: Use -p flag (not --print) for proper execution
    const args = [
      '-p',
      '--model', model,
      '--tools', '',  // Disable tools for agent response
      '--output-format', 'text',
      '--setting-sources', '',  // Disable hooks to prevent recursion
      '--system-prompt', `You are a ${spec.type} agent. Complete the following task thoroughly and return your findings.`,
      prompt,
    ];

    let stdout = '';
    let stderr = '';

    const proc = spawn(CLAUDE_PATH, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Track for cancellation
    runningAgents.set(agentId, {
      proc,
      result: { agentId, agentType: spec.type, agentName, model },
    });

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Handle timeout
    const timeoutId = setTimeout(() => {
      proc.kill('SIGTERM');
      runningAgents.delete(agentId);
      resolve({
        agentId,
        agentType: spec.type,
        agentName,
        success: false,
        error: `Timeout after ${timeout}ms`,
        durationMs: Date.now() - startTime,
        model,
        voiceId,
      });
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      runningAgents.delete(agentId);
      const durationMs = Date.now() - startTime;

      if (code !== 0 && !stdout) {
        resolve({
          agentId,
          agentType: spec.type,
          agentName,
          success: false,
          error: stderr || `Process exited with code ${code}`,
          durationMs,
          model,
          voiceId,
        });
        return;
      }

      resolve({
        agentId,
        agentType: spec.type,
        agentName,
        success: true,
        result: stdout.trim(),
        durationMs,
        model,
        voiceId,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      runningAgents.delete(agentId);
      resolve({
        agentId,
        agentType: spec.type,
        agentName,
        success: false,
        error: err.message,
        durationMs: Date.now() - startTime,
        model,
        voiceId,
      });
    });
  });
}

// ============================================================================
// Aggregation Strategies
// ============================================================================

/**
 * Voting aggregation - find most common conclusion
 */
async function aggregateVoting(results: AgentResult[]): Promise<string> {
  const successful = results.filter(r => r.success && r.result);
  if (successful.length === 0) {
    return 'No successful results to aggregate';
  }

  // Use inference to find common themes
  const summaryPrompt = `Analyze these ${successful.length} agent responses and identify the most common conclusion or consensus:

${successful.map((r, i) => `--- Agent ${i + 1} (${r.agentName}) ---\n${r.result}`).join('\n\n')}

Return the consensus conclusion that most agents agree on. If there's no clear consensus, summarize the range of opinions.`;

  const inference = await runInference(
    'You are a voting aggregator. Find the most common conclusion.',
    summaryPrompt,
    'fast'
  );

  return inference.success ? inference.output : 'Failed to aggregate votes';
}

/**
 * Synthesis aggregation - combine all results into unified response
 */
async function aggregateSynthesis(results: AgentResult[]): Promise<string> {
  const successful = results.filter(r => r.success && r.result);
  if (successful.length === 0) {
    return 'No successful results to synthesize';
  }

  const synthesisPrompt = `Synthesize these ${successful.length} agent responses into a comprehensive unified analysis:

${successful.map((r, i) => `--- Agent ${i + 1} (${r.agentName}) ---\n${r.result}`).join('\n\n')}

Create a synthesis that:
1. Combines unique insights from each agent
2. Resolves any contradictions
3. Presents a complete, unified picture
4. Notes where agents disagreed (if applicable)`;

  const inference = await runInference(
    'You are a synthesis expert. Combine multiple perspectives into one unified analysis.',
    synthesisPrompt,
    'standard'
  );

  return inference.success ? inference.output : 'Failed to synthesize results';
}

/**
 * Merge aggregation - concatenate all results
 */
function aggregateMerge(results: AgentResult[]): string {
  const successful = results.filter(r => r.success && r.result);
  if (successful.length === 0) {
    return 'No successful results to merge';
  }

  return successful
    .map(r => `## ${r.agentName}\n\n${r.result}`)
    .join('\n\n---\n\n');
}

/**
 * First aggregation - return first successful result
 */
function aggregateFirst(results: AgentResult[]): string {
  const first = results.find(r => r.success && r.result);
  return first?.result || 'No successful results';
}

/**
 * Best aggregation - use judge to pick best result
 */
async function aggregateBest(results: AgentResult[]): Promise<string> {
  const successful = results.filter(r => r.success && r.result);
  if (successful.length === 0) {
    return 'No successful results to judge';
  }

  if (successful.length === 1) {
    return successful[0].result!;
  }

  const judgePrompt = `You are a quality judge. Evaluate these ${successful.length} agent responses and select the BEST one:

${successful.map((r, i) => `--- Response ${i + 1} (${r.agentName}) ---\n${r.result}`).join('\n\n')}

Criteria:
1. Completeness - covers all aspects
2. Accuracy - factually correct
3. Clarity - well-organized and clear
4. Actionability - provides useful insights

Return ONLY the number of the best response (1, 2, 3, etc.), followed by a brief explanation.`;

  const inference = await runInference(
    'You are a quality judge. Select the best response.',
    judgePrompt,
    'fast'
  );

  if (!inference.success) {
    return successful[0].result!; // Fallback to first
  }

  // Parse the judge's choice
  const match = inference.output.match(/^(\d+)/);
  if (match) {
    const index = parseInt(match[1], 10) - 1;
    if (index >= 0 && index < successful.length) {
      return `**Selected: ${successful[index].agentName}**\n\n${successful[index].result}`;
    }
  }

  return successful[0].result!;
}

/**
 * Apply aggregation strategy
 */
async function aggregate(
  results: AgentResult[],
  strategy: AggregationStrategy
): Promise<string> {
  switch (strategy) {
    case 'voting':
      return aggregateVoting(results);
    case 'synthesis':
      return aggregateSynthesis(results);
    case 'merge':
      return aggregateMerge(results);
    case 'first':
      return aggregateFirst(results);
    case 'best':
      return aggregateBest(results);
    default:
      return aggregateMerge(results);
  }
}

// ============================================================================
// Orchestrator Implementation
// ============================================================================

/**
 * Create an orchestrator instance with custom options
 */
export function createOrchestrator(baseOptions: OrchestratorOptions = {}): AgentOrchestrator {
  const defaultOptions: OrchestratorOptions = {
    parallel: true,
    maxConcurrent: 5,
    defaultModel: 'sonnet',
    defaultTimeout: 60000,
    announceResults: false,
    ...baseOptions,
  };

  return {
    /**
     * Spawn multiple agents to work on a task
     */
    async spawn(
      agents: AgentSpec[],
      task: string,
      options: OrchestratorOptions = {}
    ): Promise<AgentResult[]> {
      const opts = { ...defaultOptions, ...options };

      // Expand count into individual specs
      const expandedAgents: AgentSpec[] = [];
      for (const spec of agents) {
        const count = spec.count || 1;
        for (let i = 0; i < count; i++) {
          expandedAgents.push({
            ...spec,
            name: count > 1 ? `${spec.name || spec.type} ${i + 1}` : spec.name,
          });
        }
      }

      // Execute agents
      const results: AgentResult[] = [];
      let completed = 0;

      if (opts.parallel) {
        // Parallel execution with concurrency limit
        const chunks: AgentSpec[][] = [];
        for (let i = 0; i < expandedAgents.length; i += opts.maxConcurrent!) {
          chunks.push(expandedAgents.slice(i, i + opts.maxConcurrent!));
        }

        for (const chunk of chunks) {
          const chunkResults = await Promise.all(
            chunk.map(async (spec) => {
              const result = await executeAgent(spec, task, opts);
              completed++;
              opts.onProgress?.(completed, expandedAgents.length, result);
              return result;
            })
          );
          results.push(...chunkResults);
        }
      } else {
        // Sequential execution
        for (const spec of expandedAgents) {
          const result = await executeAgent(spec, task, opts);
          results.push(result);
          completed++;
          opts.onProgress?.(completed, expandedAgents.length, result);
        }
      }

      // Announce results if requested
      if (opts.announceResults) {
        const successCount = results.filter(r => r.success).length;
        const message = `${successCount} of ${results.length} agents completed successfully`;
        await announceVoice(message, opts.voiceId);
      }

      return results;
    },

    /**
     * Spawn agents and aggregate their results
     */
    async spawnWithAggregation(
      agents: AgentSpec[],
      task: string,
      strategy: AggregationStrategy,
      options: OrchestratorOptions = {}
    ): Promise<{ results: AgentResult[]; aggregated: string }> {
      const results = await this.spawn(agents, task, options);
      const aggregated = await aggregate(results, strategy);

      // Announce aggregated result if requested
      if (options.announceResults) {
        const summary = aggregated.substring(0, 100);
        await announceVoice(
          `Aggregated ${results.length} agent results using ${strategy} strategy`,
          options.voiceId
        );
      }

      return { results, aggregated };
    },

    /**
     * Verify work against criteria (spotcheck pattern)
     */
    async spotcheck(
      work: string,
      criteria: string[],
      options: { model?: AgentModel; strict?: boolean } = {}
    ): Promise<SpotcheckResult> {
      const model = options.model || 'sonnet';
      const strict = options.strict ?? true;

      const spotcheckPrompt = `You are a meticulous code reviewer and quality verifier. Evaluate the following work against each criterion.

## WORK TO VERIFY:
${work}

## CRITERIA TO CHECK:
${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## INSTRUCTIONS:
For each criterion, determine if it PASSES or FAILS. Be ${strict ? 'strict' : 'lenient'} in your evaluation.

Respond in this exact JSON format:
{
  "criteriaResults": [
    { "criterion": "criterion text", "passed": true/false, "notes": "explanation" }
  ],
  "issues": ["list of issues found"],
  "recommendations": ["list of recommendations"],
  "score": 0-100
}`;

      const inference = await runInference(
        'You are a quality verification agent. Be thorough and accurate.',
        spotcheckPrompt,
        model === 'haiku' ? 'fast' : model === 'sonnet' ? 'standard' : 'smart',
        true
      );

      if (!inference.success || !inference.parsed) {
        return {
          passed: false,
          score: 0,
          issues: ['Spotcheck verification failed'],
          recommendations: ['Retry verification'],
          criteriaResults: criteria.map(c => ({
            criterion: c,
            passed: false,
            notes: 'Verification failed',
          })),
        };
      }

      const parsed = inference.parsed as {
        criteriaResults: Array<{ criterion: string; passed: boolean; notes: string }>;
        issues: string[];
        recommendations: string[];
        score: number;
      };

      const passed = strict
        ? parsed.criteriaResults.every(c => c.passed)
        : parsed.criteriaResults.filter(c => c.passed).length >= criteria.length * 0.7;

      return {
        passed,
        score: parsed.score || (parsed.criteriaResults.filter(c => c.passed).length / criteria.length) * 100,
        issues: parsed.issues || [],
        recommendations: parsed.recommendations || [],
        criteriaResults: parsed.criteriaResults || [],
      };
    },

    /**
     * Run a structured debate between agents
     */
    async debate(
      topic: string,
      positions: Array<{ agent: AgentSpec; position: string }>,
      rounds: number = 3
    ): Promise<DebateResult> {
      const debateRounds: DebateRound[] = [];
      let transcript = '';

      for (let round = 1; round <= rounds; round++) {
        const roundArguments: Array<{ agent: string; position: string; argument: string }> = [];

        // Round 1: Initial positions
        // Round 2+: Respond to previous round
        const roundPromptSuffix = round === 1
          ? 'Give your initial position on this topic (50-150 words).'
          : `Respond to the other positions from the previous round. Challenge or build on their points (50-150 words).

Previous round transcript:
${transcript}`;

        // Execute all agents in parallel for this round
        const roundResults = await Promise.all(
          positions.map(async ({ agent, position }) => {
            const prompt = `DEBATE ROUND ${round}

Topic: ${topic}
Your Position: ${position}

${roundPromptSuffix}`;

            const result = await executeAgent(
              { ...agent, name: position },
              prompt,
              { defaultModel: 'sonnet', defaultTimeout: 60000 }
            );

            return {
              agent: agent.name || agent.type,
              position,
              argument: result.success ? result.result! : `[Failed: ${result.error}]`,
            };
          })
        );

        roundArguments.push(...roundResults);
        debateRounds.push({ round, arguments: roundArguments });

        // Build transcript for next round
        transcript = roundArguments
          .map(a => `**${a.agent} (${a.position}):** ${a.argument}`)
          .join('\n\n');
      }

      // Synthesize conclusion
      const conclusionPrompt = `Analyze this debate and provide:
1. Areas of convergence (where agents agreed)
2. Remaining disagreements
3. A recommended path forward

DEBATE TOPIC: ${topic}

FULL DEBATE:
${debateRounds.map(r =>
  `--- ROUND ${r.round} ---\n${r.arguments.map(a => `${a.agent} (${a.position}): ${a.argument}`).join('\n\n')}`
).join('\n\n')}`;

      const synthesis = await runInference(
        'You are a debate moderator synthesizing the discussion.',
        conclusionPrompt,
        'standard'
      );

      // Parse convergence and disagreements
      const conclusion = synthesis.success ? synthesis.output : 'Failed to synthesize debate';

      return {
        topic,
        rounds: debateRounds,
        conclusion,
        convergencePoints: [],  // Would need more parsing
        disagreements: [],      // Would need more parsing
      };
    },

    /**
     * Spawn agents as a coordinated team using TeamsBridge.
     * Each agent runs in its own Claude Code process with P2P messaging.
     * Falls back to regular spawn() when Agent Teams is unavailable.
     */
    async spawnAsTeam(
      agents: AgentSpec[],
      task: string,
      teamConfig?: Partial<TeamConfig>
    ): Promise<AgentResult[]> {
      // Fall back to regular spawn if Teams is unavailable
      if (!TeamsBridge.isAvailable()) {
        return this.spawn(agents, task);
      }

      const teamName = teamConfig?.teamName || `orch-${Date.now()}`;
      const team = await TeamsBridge.create({
        teamName,
        defaultModel: (teamConfig?.defaultModel as 'haiku' | 'sonnet' | 'opus') || defaultOptions.defaultModel || 'sonnet',
        defaultTimeoutMs: teamConfig?.defaultTimeoutMs || defaultOptions.defaultTimeout || 300000,
        ...teamConfig,
      });

      if (!team) {
        // TeamsBridge.create returned null (feature unavailable at runtime)
        return this.spawn(agents, task);
      }

      try {
        // Expand agent specs into team member specs
        const memberSpecs: TeamMemberSpec[] = [];
        for (const spec of agents) {
          const count = spec.count || 1;
          for (let i = 0; i < count; i++) {
            const roleName = count > 1
              ? `${(spec.name || spec.type).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i + 1}`
              : (spec.name || spec.type).toLowerCase().replace(/[^a-z0-9]+/g, '-');

            // Build system prompt from traits if available
            let systemPrompt: string | undefined;
            if (spec.traits && spec.traits.length > 0) {
              const composed = await composeAgentPrompt(spec.traits, task);
              systemPrompt = composed.prompt;
            } else if (spec.promptPrefix) {
              systemPrompt = spec.promptPrefix;
            }

            // Resolve working directory: create worktree if branch specified
            let workingDir: string | undefined;
            if (spec.branch && spec.workingDir) {
              try {
                const entry = await getOrCreateWorktree({
                  repoRoot: spec.workingDir,
                  branch: spec.branch,
                  createdBy: `orchestrator:${roleName}`,
                });
                workingDir = entry.path;
              } catch {
                // Fallback to original workingDir
                workingDir = spec.workingDir;
              }
            } else {
              workingDir = spec.workingDir;
            }

            memberSpecs.push({
              role: roleName,
              task: spec.promptPrefix ? `${spec.promptPrefix}\n\n${task}` : task,
              workingDir,
              model: spec.model || (defaultOptions.defaultModel as 'haiku' | 'sonnet' | 'opus') || 'sonnet',
              timeoutMs: spec.timeout || defaultOptions.defaultTimeout,
              systemPrompt,
              voiceId: spec.voiceId,
            });
          }
        }

        // Spawn all members as a team
        const teamResults = await team.spawn(memberSpecs);

        // Announce if requested
        if (defaultOptions.announceResults) {
          const successCount = teamResults.filter(r => r.status === 'completed').length;
          await announceVoice(
            `Team ${teamName}: ${successCount} of ${teamResults.length} members completed`,
            defaultOptions.voiceId
          );
        }

        // Convert TeamMemberResult[] to AgentResult[]
        const agentResults: AgentResult[] = teamResults.map((tr, idx) => {
          const originalSpec = agents[Math.min(idx, agents.length - 1)];
          return {
            agentId: `${team.teamId}_${tr.role}`,
            agentType: originalSpec.type,
            agentName: tr.role,
            success: tr.status === 'completed',
            result: tr.output,
            error: tr.error,
            durationMs: tr.durationMs,
            model: tr.model as AgentModel,
            voiceId: originalSpec.voiceId,
          };
        });

        // Cleanup team resources
        await team.cleanup();

        return agentResults;
      } catch (error) {
        // On team failure, attempt cleanup and fall back
        try { await team.cleanup(); } catch { /* ignore cleanup errors */ }
        return this.spawn(agents, task);
      }
    },

    /**
     * Cancel a running agent
     */
    async cancel(agentId: string): Promise<void> {
      const agent = runningAgents.get(agentId);
      if (agent) {
        agent.proc.kill('SIGTERM');
        runningAgents.delete(agentId);
      }
    },

    /**
     * Cancel all running agents
     */
    async cancelAll(): Promise<void> {
      for (const [id, agent] of runningAgents) {
        agent.proc.kill('SIGTERM');
        runningAgents.delete(id);
      }
    },

    /**
     * Get currently running agents
     */
    getRunning(): AgentResult[] {
      return Array.from(runningAgents.values()).map(a => ({
        agentId: a.result.agentId!,
        agentType: a.result.agentType!,
        agentName: a.result.agentName || a.result.agentType!,
        success: false,
        durationMs: 0,
        model: a.result.model!,
      }));
    },
  };
}

// Default orchestrator instance
export const orchestrator = createOrchestrator();

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      agents: { type: 'string', short: 'a' },
      task: { type: 'string', short: 't' },
      strategy: { type: 'string', short: 's', default: 'synthesis' },
      work: { type: 'string', short: 'w' },
      criteria: { type: 'string', short: 'c' },
      topic: { type: 'string' },
      rounds: { type: 'string', short: 'r', default: '3' },
      model: { type: 'string', short: 'm', default: 'sonnet' },
      parallel: { type: 'boolean', default: true },
      concurrent: { type: 'string', default: '5' },
      announce: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  const command = positionals[0];

  if (values.help || !command) {
    console.log(`
AgentOrchestrator - Unified agent spawning and result aggregation

USAGE:
  bun run AgentOrchestrator.ts <command> [options]

COMMANDS:
  spawn       Spawn multiple agents on a task
  aggregate   Spawn agents and aggregate results
  spotcheck   Verify work against criteria
  debate      Run structured debate between agents

OPTIONS:
  -a, --agents <specs>    Agent specs (e.g., "ClaudeResearcher,Intern:5")
  -t, --task <task>       Task for agents to work on
  -s, --strategy <type>   Aggregation strategy: voting|synthesis|merge|first|best
  -w, --work <content>    Work to verify (for spotcheck)
  -c, --criteria <list>   Comma-separated criteria (for spotcheck)
  --topic <topic>         Debate topic
  -r, --rounds <num>      Debate rounds (default: 3)
  -m, --model <model>     Default model: haiku|sonnet|opus
  --parallel              Run in parallel (default: true)
  --concurrent <num>      Max concurrent agents (default: 5)
  --announce              Voice announce results
  -h, --help              Show this help

EXAMPLES:
  # Spawn researchers in parallel
  bun run AgentOrchestrator.ts spawn -a "ClaudeResearcher,GeminiResearcher" -t "Research AI safety"

  # Spawn 5 interns with synthesis
  bun run AgentOrchestrator.ts aggregate -a "Intern:5" -t "Analyze this company" -s synthesis

  # Spotcheck code
  bun run AgentOrchestrator.ts spotcheck -w "$(cat code.ts)" -c "No vulnerabilities,Tests pass"

  # Run debate
  bun run AgentOrchestrator.ts debate --topic "Microservices vs Monolith"
`);
    return;
  }

  // Parse agent specs
  function parseAgentSpecs(specStr: string): AgentSpec[] {
    if (!specStr) return [];
    return specStr.split(',').map(s => {
      const [type, countStr] = s.trim().split(':');
      return {
        type,
        count: countStr ? parseInt(countStr, 10) : 1,
      };
    });
  }

  const opts: OrchestratorOptions = {
    parallel: values.parallel,
    maxConcurrent: parseInt(values.concurrent as string, 10),
    defaultModel: values.model as AgentModel,
    announceResults: values.announce,
    onProgress: (completed, total, result) => {
      console.log(`[${completed}/${total}] ${result.agentName}: ${result.success ? 'done' : 'failed'}`);
    },
  };

  switch (command) {
    case 'spawn': {
      if (!values.agents || !values.task) {
        console.error('Error: --agents and --task are required for spawn');
        process.exit(1);
      }
      const specs = parseAgentSpecs(values.agents as string);
      const results = await orchestrator.spawn(specs, values.task as string, opts);

      console.log('\n=== RESULTS ===');
      for (const r of results) {
        console.log(`\n--- ${r.agentName} (${r.success ? 'SUCCESS' : 'FAILED'}) ---`);
        console.log(r.success ? r.result : r.error);
      }
      break;
    }

    case 'aggregate': {
      if (!values.agents || !values.task) {
        console.error('Error: --agents and --task are required for aggregate');
        process.exit(1);
      }
      const specs = parseAgentSpecs(values.agents as string);
      const { results, aggregated } = await orchestrator.spawnWithAggregation(
        specs,
        values.task as string,
        values.strategy as AggregationStrategy,
        opts
      );

      console.log('\n=== AGGREGATED RESULT ===');
      console.log(aggregated);
      break;
    }

    case 'spotcheck': {
      if (!values.work || !values.criteria) {
        console.error('Error: --work and --criteria are required for spotcheck');
        process.exit(1);
      }
      const criteria = (values.criteria as string).split(',').map(c => c.trim());
      const result = await orchestrator.spotcheck(
        values.work as string,
        criteria,
        { model: values.model as AgentModel }
      );

      console.log('\n=== SPOTCHECK RESULT ===');
      console.log(`Passed: ${result.passed}`);
      console.log(`Score: ${result.score}/100`);
      console.log('\nCriteria:');
      for (const c of result.criteriaResults) {
        console.log(`  ${c.passed ? '✓' : '✗'} ${c.criterion}`);
        if (c.notes) console.log(`    ${c.notes}`);
      }
      if (result.issues.length > 0) {
        console.log('\nIssues:');
        for (const issue of result.issues) {
          console.log(`  - ${issue}`);
        }
      }
      if (result.recommendations.length > 0) {
        console.log('\nRecommendations:');
        for (const rec of result.recommendations) {
          console.log(`  - ${rec}`);
        }
      }
      break;
    }

    case 'debate': {
      const topic = values.topic || positionals[1];
      if (!topic) {
        console.error('Error: --topic is required for debate');
        process.exit(1);
      }

      // Default positions if not specified
      const positions: Array<{ agent: AgentSpec; position: string }> = [
        { agent: { type: 'Architect', name: 'Architect' }, position: 'Architecture perspective' },
        { agent: { type: 'Engineer', name: 'Engineer' }, position: 'Implementation perspective' },
        { agent: { type: 'Designer', name: 'Designer' }, position: 'User experience perspective' },
      ];

      const result = await orchestrator.debate(
        topic as string,
        positions,
        parseInt(values.rounds as string, 10)
      );

      console.log(`\n=== DEBATE: ${result.topic} ===`);
      for (const round of result.rounds) {
        console.log(`\n--- Round ${round.round} ---`);
        for (const arg of round.arguments) {
          console.log(`\n**${arg.agent} (${arg.position}):**`);
          console.log(arg.argument);
        }
      }
      console.log('\n=== CONCLUSION ===');
      console.log(result.conclusion);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
