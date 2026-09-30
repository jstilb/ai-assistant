/**
 * AgentSpawnArgs.ts — pure builder for the agent-mode `claude -p` spawn args.
 *
 * Extracted from bin/run-cron-job.ts (which top-level-executes main() and so
 * can't be imported by tests) so the tool-list/model wiring is unit-testable.
 * Direct-mode (execute:) jobs never come through here — their command/args
 * pass through verbatim.
 */

import { classifyInfraReason } from "../core/AgentSpawner.ts";
import type { JobSpec } from "./JobSpec.ts";
import type { SpawnJobResult } from "./JobSpawner.ts";

export const DEFAULT_AGENT_TOOLS = "Bash,Read,Write,Edit,Glob,Grep";

/**
 * Effort for agent-mode cron spawns when the job doesn't set `agentEffort`.
 * Scheduled upkeep/ingest work is routine; the CLI default (`high` on Fable
 * 5.1) over-deliberates it. Anthropic's Fable 5.1 guidance: `medium` roughly
 * matches Fable 5 output at lower cost.
 */
export const DEFAULT_AGENT_EFFORT = "medium";

/**
 * Model an agent-mode job re-spawns on after a rate-limit/quota failure on
 * the CLI-default (Fable) model. Mirrors the executor's fable→sonnet one-shot
 * fallback (skills/Productivity/LucidTasks/Tools/executor/executor.ts):
 * Sonnet's headless path is independent of the Fable pool.
 */
export const FALLBACK_AGENT_MODEL = "sonnet";

export interface AgentSpawnArgOptions {
  /** Replaces the job's model for this spawn (the post-fallback attempt). */
  modelOverride?: string;
}

export function buildAgentSpawnArgs(
  job: JobSpec,
  jobId: string,
  claudeBin: string,
  opts: AgentSpawnArgOptions = {},
): string[] {
  const args = [
    claudeBin,
    "-p",
    [
      "You are executing a scheduled Kaya cron job.",
      `Job ID: ${jobId}`,
      `Task: ${job.task}`,
      `Output mode: ${job.output}`,
      "Execute the task and provide a concise summary of what you accomplished.",
    ].join("\n"),
    "--allowedTools",
    job.agentTools ?? DEFAULT_AGENT_TOOLS,
    "--effort",
    job.agentEffort ?? DEFAULT_AGENT_EFFORT,
  ];
  // --model only when explicitly set — omitting the flag lets the claude CLI
  // use its own configured default, which is the right behavior for the
  // majority of jobs that don't care.
  const model = opts.modelOverride ?? job.agentModel;
  if (model) {
    args.push("--model", model);
  }
  return args;
}

/**
 * Decide whether a failed agent-mode attempt should re-spawn on
 * FALLBACK_AGENT_MODEL. Only rate-limit/quota infra reasons qualify — those
 * are pool-specific, so switching pools helps; timeout/network/no-output are
 * not fixed by a different model. Jobs pinned to a non-Fable model never fall
 * back (they are already off the Fable pool). Returns undefined when the
 * attempt should be retried as-is (or not at all — RetryPolicy decides that).
 *
 * 2026-08-29: 18 consecutive agent-mode failures on "You've reached your
 * Fable 5 limit. Switch to another model" with no model change between
 * attempts — the case this exists for.
 */
export function fallbackModelFor(job: JobSpec, result: SpawnJobResult): string | undefined {
  if (result.success) return undefined;
  if (job.agentModel && !/fable/i.test(job.agentModel)) return undefined;
  const reason = classifyInfraReason({
    success: result.success,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    preSpawnGated: false,
    errorCode: undefined,
  });
  return reason === "rate-limit" || reason === "quota" ? FALLBACK_AGENT_MODEL : undefined;
}
