#!/usr/bin/env bun
/**
 * spawnAgent.ts — Headless claude -p subprocess launcher for the autonomous executor.
 *
 * THIN WRAPPER over lib/core/AgentSpawner.spawnAgentSync (the shared hardened-env,
 * rate-limit-aware spawn substrate introduced in slice B1). External signature is
 * UNCHANGED — sole call site is executor.ts's spawnBuilderAgent() (used by runTask()),
 * which calls spawnAgent(prompt, { model, timeoutMs, cwd }) with model "opus" and,
 * on an infra-unavailable result, once more with model "sonnet", reading back
 * { success, stdout, stderr, exitCode, timedOut, infraUnavailable, infraReason }.
 *
 * This wrapper supplies the executor's own fixed configuration, since AgentSpawner
 * requires every caller to make these choices explicit rather than inherit a default:
 *   - model defaults to "opus" when the caller omits it (spawnAgentSync itself has
 *     no default — every substrate caller must choose).
 *   - allowedTools is the executor's fixed reversible-action boundary (Bash, Read,
 *     Write, Edit, Glob, Grep, WebFetch, WebSearch, Agent, Skill). Outward MCP tools
 *     (gmail/telegram/calendar/instacart) are withheld by omission.
 *   - KAYA_AUTONOMOUS=1 so downstream tooling can detect the executor context (the
 *     substrate re-strips ANTHROPIC_API_KEY/CLAUDECODE/CLAUDE_CODE_* from the merged
 *     env afterward — see lib/core/Inference.ts's stripDangerousClaudeEnvKeys — so
 *     this extra env cannot un-harden the spawn).
 *   - maxBuffer 64MB, matching the previous hand-rolled spawnSync call.
 *   - skipRateLimitGate: true — executor.ts's poll() ALREADY gates at the batch
 *     level (its own isRateLimited() check with alerting + deferred-task
 *     bookkeeping, see executor.ts poll()). The substrate's built-in pre-spawn gate
 *     exists precisely for callers like this one (see AgentSpawnOptions.skipRateLimitGate);
 *     enabling it here would add a second, silent gate that never existed before and
 *     bypass the executor's alerting — out of scope for a thin wrapper.
 *
 * The prompt is passed as a positional argument (the substrate's last CLI arg), NOT
 * via stdin — unchanged from the original hand-rolled implementation.
 *
 * SLICE S13: `infraUnavailable`/`preSpawnGated` are now forwarded verbatim from
 * spawnAgentSync's result (previously dropped at this wrapper boundary) so executor.ts can
 * consume AgentSpawner's OWN infra-vs-failure classification directly instead of maintaining a
 * second copy of the same rate/usage/credit-pool regex — see AgentSpawner.isInfraUnavailable
 * for the canonical classifier and executor.ts's call site for how the forwarded field is used.
 * This is a deliberate behavior change from the pre-S13 split: AgentSpawner's classifier treats
 * ANY timeout as infra-unavailable (defer/retry), whereas the old executor-local copy did not
 * check timedOut at all — a timeout with no rate-limit wording used to fall through to a plain
 * task failure. Folding timeouts into the infra-unavailable/retry path is judged more correct
 * (a 90-minute agent timeout is a retryable infra condition, not evidence the TASK itself is
 * bad) and removes the exact drift risk (two hand-maintained copies of one classifier) flagged
 * going into this slice.
 *
 * NOT touched by this wrapper: executor.ts's OWN parseVerdict() (richer summary/artifacts
 * handling than AgentSpawner.parseVerdictBlock) — unifying that is still out of scope here.
 */

import { spawnAgentSync } from "../../../../../lib/core/AgentSpawner.ts";
import type { InfraReason } from "../../../../../lib/core/AgentSpawner.ts";

export interface SpawnAgentResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /** Forwarded from AgentSpawner's classification (slice S13) — see module docstring. */
  infraUnavailable: boolean;
  /** True only when AgentSpawner's pre-spawn rate-limit gate blocked the spawn entirely. */
  preSpawnGated: boolean;
  /**
   * WHY infraUnavailable is true (undefined when it's false, or for the
   * pre-spawn-gated case, which has no InfraReason of its own). Forwarded
   * verbatim from AgentSpawner — see AgentSpawner.classifyInfraReason for the
   * precedence order (timeout → network → rate-limit → quota → no-output).
   */
  infraReason?: InfraReason;
}

export interface SpawnAgentOpts {
  model?: string;
  timeoutMs?: number;
  cwd?: string;
}

/**
 * The executor's fixed reversible-action boundary —
 * Bash/Read/Write/Edit/Glob/Grep/WebFetch/WebSearch/Agent/Skill. The subagent
 * tool is named `Agent`, not `Task`, in Claude Code 2.1.263 — see
 * S-06 slice-3 probe 0d (jobs/6ee226c4/tmp/slice3/PROBES.md): both
 * `--tools Read,Task` and `--tools Read,Agent` made the spawned process
 * self-report its available tools as `Agent, Read`, and a `--tools Read`-only
 * control confirmed `Agent` is genuinely gated by the list, not always-on.
 */
const ALLOWED_TOOLS = "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Agent,Skill";

/** Matches the previous hand-rolled spawnSync call's maxBuffer. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Spawn a headless claude -p subprocess with the given prompt.
 * Returns a structured result; never throws.
 */
export function spawnAgent(prompt: string, opts: SpawnAgentOpts = {}): SpawnAgentResult {
  const result = spawnAgentSync({
    prompt,
    model: opts.model ?? "opus",
    allowedTools: ALLOWED_TOOLS,
    timeoutMs: opts.timeoutMs,
    cwd: opts.cwd,
    env: { KAYA_AUTONOMOUS: "1" },
    maxBuffer: MAX_BUFFER,
    skipRateLimitGate: true,
  });

  return {
    success: result.success,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    infraUnavailable: result.infraUnavailable,
    preSpawnGated: result.preSpawnGated,
    infraReason: result.infraReason,
  };
}
