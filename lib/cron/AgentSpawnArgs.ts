/**
 * AgentSpawnArgs.ts — pure builder for the agent-mode `claude -p` spawn args.
 *
 * Extracted from bin/run-cron-job.ts (which top-level-executes main() and so
 * can't be imported by tests) so the tool-list/model wiring is unit-testable.
 * Every agent-mode job gets DEFAULT_AGENT_TOOLS and the CLI-default model; the
 * per-job agentTools/agentModel overrides were removed 2026-11-08 (only the
 * deleted DailyBriefing jobs ever set them).
 * Direct-mode (execute:) jobs never come through here — their command/args
 * pass through verbatim.
 */

import { buildAgentArgs } from "../core/AgentSpawner.ts";
import { classifyRunEnd } from "../core/ClaudeRunEnd.ts";
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

interface AgentSpawnArgOptions {
  /** Replaces the job's model for this spawn (the post-fallback attempt). */
  modelOverride?: string;
}

export function buildAgentSpawnArgs(
  job: JobSpec,
  jobId: string,
  claudeBin: string,
  opts: AgentSpawnArgOptions = {},
): string[] {
  const prompt = [
    "You are executing a scheduled Kaya cron job.",
    `Job ID: ${jobId}`,
    `Task: ${job.task}`,
    `Output mode: ${job.output}`,
    "Execute the task and provide a concise summary of what you accomplished.",
  ].join("\n");
  // Cron agent jobs run slash commands (`task: /knowledge daily`), so they
  // load the user's settings (`kaya`). The model is omitted except on the
  // post-fallback attempt — `buildAgentArgs` then adds no `--model` and the
  // CLI default applies.
  return [
    claudeBin,
    ...buildAgentArgs({
      prompt,
      model: opts.modelOverride,
      effort: job.agentEffort ?? DEFAULT_AGENT_EFFORT,
      allowedTools: DEFAULT_AGENT_TOOLS,
      settings: "kaya",
    }),
  ];
}

/**
 * Decide whether a failed agent-mode attempt should re-spawn on
 * FALLBACK_AGENT_MODEL. Only rate-limit/quota infra reasons qualify — those
 * are pool-specific, so switching pools helps; timeout/network/no-output are
 * not fixed by a different model. Returns undefined when the
 * attempt should be retried as-is (or not at all — CronRun.ts's attempt loop decides that).
 *
 * 2026-08-29: 18 consecutive agent-mode failures on "You've reached your
 * Fable 5 limit. Switch to another model" with no model change between
 * attempts — the case this exists for.
 */
export function fallbackModelFor(result: SpawnJobResult): string | undefined {
  if (result.success) return undefined;
  const end = classifyRunEnd({
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  return end === "rate-limit" || end === "quota" ? FALLBACK_AGENT_MODEL : undefined;
}
