#!/usr/bin/env bun
/**
 * AgentSpawner.ts — Shared substrate for spawning headless agentic `claude -p` processes.
 *
 * Generalizes the pattern proven by
 * `skills/Productivity/LucidTasks/Tools/executor/spawnAgent.ts` (the autonomous
 * executor's Lane A spawner) and the Explorer runner in
 * `skills/Automation/AutonomousWork/Tools/LiveVerifier.ts` so every future caller
 * (executor Lane A, LiveVerifier explorer, SpecPipelineRunner research phase,
 * HeadlessWorkDriver builder/verifier turns) shares ONE hardened spawn path
 * instead of hand-rolling `spawnSync(CLAUDE_PATH, ...)` + env stripping + rate-limit
 * detection per call site.
 *
 * This module intentionally creates NO production dependents in this slice — it is
 * pure substrate. Migration of existing call sites happens in later slices (B2/B3).
 *
 * Design:
 *   - `spawnAgentSync()` is the core, synchronous spawn (mirrors the proven
 *     spawnSync-based shape of the reference `spawnAgent()` so a future thin
 *     wrapper can preserve an external synchronous signature).
 *   - `spawnAgent()` is a thin async convenience wrapper that additionally
 *     resolves an optional worktree-isolation cwd via WorktreeManager before
 *     delegating to `spawnAgentSync()`.
 *   - `model` and `allowedTools` are REQUIRED (no silently-guessed default):
 *     this is a shared substrate feeding call sites with very different
 *     reversible-action boundaries (a read-only Explorer vs. a
 *     Bash/Read/Write/Edit/Task-enabled executor), so every caller must make an
 *     explicit, informed choice rather than inherit an arbitrary default.
 *   - The rate-limit gate (pre-spawn `isRateLimited()`) and the post-spawn
 *     infra-vs-failure split (`classifyRunEnd` from ClaudeRunEnd.ts: stderr
 *     under the machine tier, stdout under the prose-safe tier) let callers
 *     distinguish "defer and retry" from "genuine task failure" without
 *     re-deriving the pattern-matching.
 *   - The process-spawn function is injectable (`deps.spawnFn`) so unit tests
 *     never spawn a real process or call a real LLM; worktree resolution is
 *     likewise injectable (`deps.getOrCreateWorktreeFn`).
 *   - `parseVerdictBlock()` generalizes
 *     `skills/Productivity/LucidTasks/Tools/executor/verdictParser.ts`: caller
 *     supplies start/end tag strings (and an optional Zod schema); returns null
 *     on ANY malformity — never a default, never a partial result.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import { CLAUDE_PATH, buildHardenedClaudeEnv, stripDangerousClaudeEnvKeys } from "./Inference.ts";
import { isRateLimited, DEFAULT_THRESHOLD } from "./RateLimitGuard.ts";
import { classifyRunEnd, type RunEnd } from "./ClaudeRunEnd.ts";
import { getKayaHome } from "./KayaHome.ts";
import { getOrCreateWorktree } from "./WorktreeManager.ts";
import type { CreateWorktreeOptions } from "./WorktreeManager.ts";
import { AGENT_RUN_ENV_KEY, reapAgentRun } from "./ProcessReaper.ts";

// ============================================================================
// Constants
// ============================================================================

/** Matches the reference implementations' proven timeout (executor Lane A). */
export const DEFAULT_TIMEOUT_MS = 90 * 60 * 1000;

/** Matches both reference implementations' spawnSync maxBuffer. */
export const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

// ============================================================================
// Types
// ============================================================================

/**
 * WHY a spawn result is infra-unavailable (undefined when it isn't): every
 * run end except "ok" and "failed". Precedence is `classifyRunEnd`'s
 * (lib/core/ClaudeRunEnd.ts).
 */
export type InfraReason = Exclude<RunEnd, "ok" | "failed">;

export interface AgentSpawnResult {
  /** True only when the process ran, exited 0, and did not time out. */
  success: boolean;
  stdout: string;
  stderr: string;
  /** -1 when the spawn was pre-spawn-gated (process never ran). */
  exitCode: number;
  timedOut: boolean;
  /**
   * True when the failure is attributable to infrastructure (rate/usage/session
   * limit, credit-pool pause, timeout, or a pre-spawn gate) rather than the
   * agent's own task outcome. Callers should defer/retry on true, and only
   * call their own recordFailure() when this is false.
   */
  infraUnavailable: boolean;
  /** True only when the pre-spawn rate-limit gate blocked the spawn entirely. */
  preSpawnGated: boolean;
  /**
   * WHY infraUnavailable is true (undefined when it's false, and undefined for
   * the pre-spawn-gated early return, which has no InfraReason value of its own).
   * See `classifyRunEnd` (ClaudeRunEnd.ts) for the precedence order.
   */
  infraReason?: InfraReason;
  /** Node.js errno code from a spawn-level error (e.g. "ENOTFOUND"), when present. */
  errorCode?: string;
  /**
   * Pids of processes the agent left running (e.g. a server started with `&`),
   * ended by the post-run sweep. Set only when non-empty. See ProcessReaper.ts.
   */
  reapedPids?: number[];
}

/** Reusing WorktreeManager's own option type — no duplicate shape to drift. */
export type WorktreeSpawnOptions = CreateWorktreeOptions;

export interface AgentSpawnOptions {
  /** Passed as the LAST positional CLI arg (never via stdin). */
  prompt: string;
  /** Required — every caller must make an explicit model choice. */
  model: string;
  /**
   * Claude Code `--effort` for the spawn (low..max). Omitted = the CLI default
   * (`high` on Fable 5.1 / Opus 5 / Sonnet 5). Set `medium` for routine
   * exploration/verification lanes; leave unset for builders.
   */
  effort?: AgentEffort;
  /** Comma-separated tool allowlist. Required — defines the reversible-action boundary. */
  allowedTools: string;
  /** Default: DEFAULT_TIMEOUT_MS (90 min, the proven executor Lane A default). */
  timeoutMs?: number;
  /** Explicit working directory. Mutually exclusive in intent with `worktree` (cwd wins if both set). */
  cwd?: string;
  /**
   * Optional worktree isolation: resolved via WorktreeManager.getOrCreateWorktree().
   * Only honored by the async `spawnAgent()` entry point — `spawnAgentSync()`
   * cannot resolve this itself (worktree creation is async) and throws if given
   * `worktree` without an already-resolved `cwd`.
   */
  worktree?: WorktreeSpawnOptions;
  /** Extra env vars merged over the hardened base env (e.g. KAYA_AUTONOMOUS=1 is set by default; pass to override). */
  env?: Record<string, string>;
  /** Default: DEFAULT_MAX_BUFFER (64MB). */
  maxBuffer?: number;
  /** Skip the pre-spawn isRateLimited() gate — for callers that already gate at the batch/poll level. */
  skipRateLimitGate?: boolean;
  /** Default: DEFAULT_THRESHOLD (90) from RateLimitGuard. */
  rateLimitThreshold?: number;
  /**
   * Load the SecurityValidator + PromptInjectionDefender guard hooks (S-06)
   * into this headless spawn via `--settings <inline JSON>` (see
   * `buildGuardHookSettings`), while keeping `--setting-sources ""` (that is
   * what keeps the recursion-prone SessionStart/UserPromptSubmit/Stop/
   * SessionEnd hooks off — see module doc).
   *
   * Resolution order: this option (when set) → env `KAYA_HEADLESS_GUARD_HOOKS`
   * ("1" on / "0" off) → default OFF. Default stays off because turning it on
   * for every headless agent is an architecture call for Jm, not something
   * this slice should flip silently — see PROGRESS ledger. Flip the default
   * by exporting `KAYA_HEADLESS_GUARD_HOOKS=1` in the calling environment, or
   * pass `guardHooks: true` per call site.
   */
  guardHooks?: boolean;
  /**
   * Pass `--tools opts.allowedTools` alongside `--allowedTools` (S-06 slice-3
   * probe 0b: under `--dangerously-skip-permissions`, `--allowedTools` is an
   * inert permission-system allow-list, while `--tools` is the flag that
   * actually restricts the built-in tool set). This is gated behind its own
   * switch, default OFF, mirroring `guardHooks` above: enforcing is the
   * correct end state, but flipping it silently would remove any tool a live
   * lane relied on outside its list — it is Jm's architecture call, one env
   * var away, not something this slice should flip for every caller at once.
   *
   * Resolution order: this option (when set) → env
   * `KAYA_HEADLESS_TOOLS_ENFORCE` ("1" on / "0" off) → default OFF.
   */
  enforceTools?: boolean;
  /** Default `isolated`. Which settings the agent loads — see `AgentSettings`. */
  settings?: AgentSettings;
}

/**
 * Resolve the effective guardHooks setting: explicit option wins, then the
 * `KAYA_HEADLESS_GUARD_HOOKS` env var ("1" on / "0" off), then default OFF.
 * Pure — exported for tests.
 */
export function resolveGuardHooks(explicit: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  if (explicit !== undefined) return explicit;
  if (env.KAYA_HEADLESS_GUARD_HOOKS === "1") return true;
  if (env.KAYA_HEADLESS_GUARD_HOOKS === "0") return false;
  return false;
}

/**
 * Resolve the effective enforceTools setting: explicit option wins, then the
 * `KAYA_HEADLESS_TOOLS_ENFORCE` env var ("1" on / "0" off), then default OFF.
 * Pure — exported for tests. See `AgentSpawnOptions.enforceTools` doc comment
 * for the rationale (default stays off until Jm rules on it).
 */
export function resolveEnforceTools(explicit: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  if (explicit !== undefined) return explicit;
  if (env.KAYA_HEADLESS_TOOLS_ENFORCE === "1") return true;
  if (env.KAYA_HEADLESS_TOOLS_ENFORCE === "0") return false;
  return false;
}

/**
 * Build the inline `--settings` JSON that loads ONLY the two pure, local
 * (no Inference/claude-spawn — verified S-06 slice-3 probe) guard hooks into
 * a headless agent: `SecurityValidator` on PreToolUse Bash/Edit/Write, and
 * `PromptInjectionDefender` on PostToolUse Bash/Read/WebFetch/WebSearch.
 * Deliberately excludes every other hook in settings.json (SessionStart,
 * UserPromptSubmit, Stop, SessionEnd, ReadToolGuard, OutputValidator,
 * SkillStructureGuard, CommitWorkReminder, TaskCompleted, AskUserQuestion
 * hooks) — those either call back into orchestrators/inference (recursion
 * risk, the reason `--setting-sources ""` exists at all) or simply don't
 * apply to a one-shot headless spawn.
 *
 * `kayaDir` must be an absolute path — headless/cron environments are not
 * guaranteed to have `KAYA_DIR` set, and `--settings` hook `command` strings
 * are NOT shell-expanded the way settings.json's `${KAYA_DIR}` is.
 */
export function buildGuardHookSettings(kayaDir: string): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: `${kayaDir}/hooks/SecurityValidator.hook.ts` }] },
        { matcher: "Edit", hooks: [{ type: "command", command: `${kayaDir}/hooks/SecurityValidator.hook.ts` }] },
        { matcher: "Write", hooks: [{ type: "command", command: `${kayaDir}/hooks/SecurityValidator.hook.ts` }] },
      ],
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: `bun run ${kayaDir}/hooks/PromptInjectionDefender.hook.ts`, timeout: 10 },
          ],
        },
        {
          matcher: "Read",
          hooks: [
            { type: "command", command: `bun run ${kayaDir}/hooks/PromptInjectionDefender.hook.ts`, timeout: 10 },
          ],
        },
        {
          matcher: "WebFetch",
          hooks: [
            { type: "command", command: `bun run ${kayaDir}/hooks/PromptInjectionDefender.hook.ts`, timeout: 10 },
          ],
        },
        {
          matcher: "WebSearch",
          hooks: [
            { type: "command", command: `bun run ${kayaDir}/hooks/PromptInjectionDefender.hook.ts`, timeout: 10 },
          ],
        },
      ],
    },
  });
}

// ============================================================================
// Agent argv builder (shared with the cron runner)
// ============================================================================

export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Which settings a one-shot agent loads.
 * - `isolated` (default): no user settings (`--setting-sources ""`), skip
 *   permissions, optional inline guard hooks. AgentSpawner callers.
 * - `kaya`: the user's settings.json supplies permissions and hooks (slash
 *   commands, CLAUDE.md). Cron agent mode. No inline guard hooks: settings.json
 *   already runs them, so they would run twice.
 */
export type AgentSettings = "isolated" | "kaya";

export interface AgentArgsOptions {
  prompt: string;
  /** Omitted = no `--model` (CLI default). Only the cron builder omits it. */
  model?: string;
  effort?: AgentEffort;
  allowedTools: string;
  /** Default `isolated`. */
  settings?: AgentSettings;
  /** Explicit switch, else env `KAYA_HEADLESS_GUARD_HOOKS`. Ignored for `kaya`. */
  guardHooks?: boolean;
  /** Explicit switch, else env `KAYA_HEADLESS_TOOLS_ENFORCE`. Applies to both settings kinds. */
  enforceTools?: boolean;
}

/**
 * The `claude` argv for a one-shot agent, WITHOUT the binary. The prompt is
 * always the last arg (never stdin). No side effects; it reads only the two
 * env switches (via `resolveEnforceTools` / `resolveGuardHooks`) and, for
 * guard hooks, the Kaya home.
 */
export function buildAgentArgs(o: AgentArgsOptions): string[] {
  const isolated = (o.settings ?? "isolated") === "isolated";
  // `--allowedTools` is a permission-system allow-list — under
  // `--dangerously-skip-permissions` the permission system never runs, so it
  // is INERT as a boundary (verified live, S-06 slice-3 probe 0b: a Bash-less
  // `--allowedTools Read` agent ran Bash anyway). `--tools` is the flag that
  // actually restricts the built-in tool set regardless of permission mode,
  // so it is the real enforcement mechanism — passed alongside `--allowedTools`
  // (kept: `kaya` runs do not skip permissions, so there it is live) rather
  // than replacing it. Gated behind `enforceTools` (see `resolveEnforceTools`
  // doc comment) — default OFF.
  const args: string[] = [
    "-p",
    ...(o.model ? ["--model", o.model] : []),
    ...(o.effort ? ["--effort", o.effort] : []),
    ...(isolated ? ["--dangerously-skip-permissions"] : []),
    "--allowedTools",
    o.allowedTools,
  ];

  if (resolveEnforceTools(o.enforceTools, process.env)) {
    args.push("--tools", o.allowedTools);
  }

  if (isolated) {
    args.push("--setting-sources", ""); // disable hooks to prevent recursion
  }
  args.push("--output-format", "text");

  if (isolated && resolveGuardHooks(o.guardHooks, process.env)) {
    const kayaDir = getKayaHome(); // KAYA_HOME → KAYA_DIR → ~/.claude, same resolution the hooks and Integrator use
    args.push("--settings", buildGuardHookSettings(kayaDir));
  }

  args.push(o.prompt); // ALWAYS last — never via stdin.
  return args;
}

/** Raw shape returned by the injectable low-level process-spawn function. */
export interface RawSpawnOutcome {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: string | null;
  error?: { code?: string };
}

/** DI seam: the function that actually invokes the OS process. */
export type RawSpawnFn = (
  claudePath: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; maxBuffer: number },
) => RawSpawnOutcome;

/** DI seam for worktree resolution (mirrors getOrCreateWorktree's signature). */
export type GetOrCreateWorktreeFn = typeof getOrCreateWorktree;

/** DI seam for the pre-spawn rate-limit check (mirrors isRateLimited's signature). */
export type IsRateLimitedFn = typeof isRateLimited;

export interface AgentSpawnDeps {
  /** Defaults to a real spawnSync() call. Inject a fake in tests — never spawn a real process. */
  spawnFn?: RawSpawnFn;
  /** Defaults to the real WorktreeManager.getOrCreateWorktree. */
  getOrCreateWorktreeFn?: GetOrCreateWorktreeFn;
  /** Defaults to the real RateLimitGuard.isRateLimited. */
  isRateLimitedFn?: IsRateLimitedFn;
  /** Defaults to the real ProcessReaper.reapAgentRun (post-run leftover sweep). */
  reapFn?: (runId: string) => number[];
}

// ============================================================================
// Env
// ============================================================================

/**
 * Build the spawn env: hardened base (never hand-rolled — see buildHardenedClaudeEnv)
 * + KAYA_AUTONOMOUS=1 default + caller overrides on top.
 *
 * The caller-supplied `extra` env is merged OVER the hardened base, then the
 * SAME denylist (stripDangerousClaudeEnvKeys, shared with Inference.ts's
 * buildHardenedClaudeEnv — not duplicated) is re-applied. Without this
 * re-strip, a caller passing `env: {...process.env}` would silently
 * reintroduce ANTHROPIC_API_KEY / CLAUDECODE / CLAUDE_CODE_* into the spawned
 * process, un-hardening it. Legitimate extras (KAYA_AUTONOMOUS, custom vars)
 * are unaffected — only the denylisted keys are stripped.
 */
function buildSpawnEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(buildHardenedClaudeEnv())) {
    if (v !== undefined) env[k] = v;
  }
  env.KAYA_AUTONOMOUS = "1";
  if (extra) Object.assign(env, extra);
  stripDangerousClaudeEnvKeys(env);
  return env;
}

// ============================================================================
// Default process spawn (real spawnSync — never used in unit tests)
// ============================================================================

const defaultSpawnFn: RawSpawnFn = (claudePath, args, opts) => {
  const res = spawnSync(claudePath, args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "utf-8",
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBuffer,
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status,
    signal: res.signal,
    error: res.error ? { code: (res.error as NodeJS.ErrnoException).code } : undefined,
  };
};

// ============================================================================
// Core spawn (sync)
// ============================================================================

/**
 * Spawn a headless `claude -p` subprocess with the given prompt and return a
 * structured result. Never throws for spawn/timeout failures — those are
 * reported in the result. Throws only for a caller-error precondition
 * (`worktree` given without a resolved `cwd`).
 *
 * Synchronous by design (spawnSync-based, matching the proven pattern in
 * `executor/spawnAgent.ts`) so a future thin wrapper over this function can
 * preserve an external synchronous signature.
 */
export function spawnAgentSync(opts: AgentSpawnOptions, deps: AgentSpawnDeps = {}): AgentSpawnResult {
  if (opts.worktree && !opts.cwd) {
    throw new Error(
      "spawnAgentSync: opts.worktree requires an already-resolved opts.cwd (worktree creation is " +
        "async) — use spawnAgent() instead, or resolve the worktree path yourself and pass it as cwd.",
    );
  }

  const skipGate = opts.skipRateLimitGate ?? false;
  if (!skipGate) {
    const checkRateLimited = deps.isRateLimitedFn ?? isRateLimited;
    const threshold = opts.rateLimitThreshold ?? DEFAULT_THRESHOLD;
    if (checkRateLimited(threshold)) {
      return {
        success: false,
        stdout: "",
        stderr: "",
        exitCode: -1,
        timedOut: false,
        infraUnavailable: true,
        preSpawnGated: true,
      };
    }
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const cwd = opts.cwd ?? process.env.HOME ?? "/tmp";
  // Fresh per-run marker: every descendant inherits it, so the post-run sweep
  // can find servers the agent backgrounded and never stopped (ProcessReaper.ts).
  const runId = randomUUID();
  const env = { ...buildSpawnEnv(opts.env), [AGENT_RUN_ENV_KEY]: runId };

  const args = buildAgentArgs({
    prompt: opts.prompt,
    model: opts.model,
    effort: opts.effort,
    allowedTools: opts.allowedTools,
    settings: opts.settings,
    guardHooks: opts.guardHooks,
    enforceTools: opts.enforceTools,
  });

  const spawnFn = deps.spawnFn ?? defaultSpawnFn;
  const raw = spawnFn(CLAUDE_PATH, args, { cwd, env, timeoutMs, maxBuffer });
  const reapedPids = (deps.reapFn ?? reapAgentRun)(runId);
  if (reapedPids.length > 0) {
    console.warn(
      `[AgentSpawner] agent left ${reapedPids.length} process(es) running in ${cwd}; ended pids ${reapedPids.join(", ")}`,
    );
  }

  const timedOut = raw.signal === "SIGTERM" || raw.error?.code === "ETIMEDOUT";
  const exitCode = raw.status ?? 1;
  const success = exitCode === 0 && !timedOut;

  const result: AgentSpawnResult = {
    success,
    stdout: raw.stdout,
    stderr: raw.stderr,
    exitCode,
    timedOut,
    infraUnavailable: false,
    preSpawnGated: false,
    errorCode: raw.error?.code,
    ...(reapedPids.length > 0 ? { reapedPids } : {}),
  };
  const end = classifyRunEnd({ exitCode, timedOut, stdout: raw.stdout, stderr: raw.stderr, errorCode: raw.error?.code });
  if (end !== "ok" && end !== "failed") {
    result.infraReason = end;
    result.infraUnavailable = true;
  }
  return result;
}

// ============================================================================
// Async convenience wrapper (adds optional worktree isolation)
// ============================================================================

/**
 * Async convenience wrapper over `spawnAgentSync()`. If `opts.cwd` is not set
 * and `opts.worktree` is, resolves the worktree path via
 * WorktreeManager.getOrCreateWorktree() first. Most callers pass an explicit
 * `cwd` (or neither) and can ignore this — it exists only for the callers that
 * want spawn-time worktree isolation.
 */
export async function spawnAgent(opts: AgentSpawnOptions, deps: AgentSpawnDeps = {}): Promise<AgentSpawnResult> {
  let cwd = opts.cwd;
  if (!cwd && opts.worktree) {
    const resolveWorktree = deps.getOrCreateWorktreeFn ?? getOrCreateWorktree;
    const entry = await resolveWorktree(opts.worktree);
    cwd = entry.path;
  }
  return spawnAgentSync({ ...opts, cwd }, deps);
}

// ============================================================================
// Verdict-block parsing
// ============================================================================

export interface VerdictTags {
  /** Marker string preceding the JSON block (e.g. "EXECUTOR_VERDICT_START"). */
  start: string;
  /** Marker string following the JSON block (e.g. "EXECUTOR_VERDICT_END"). */
  end: string;
}

/**
 * Extract and parse a tagged JSON verdict block from agent stdout.
 *
 * Generalizes `executor/verdictParser.ts`: caller supplies the start/end tag
 * strings and, optionally, a Zod schema to validate the parsed shape. Returns
 * null on ANY malformity — missing markers, empty block, invalid JSON, or (when
 * a schema is supplied) a shape that fails validation. NEVER returns a
 * default or partial object; null is the hard-failure signal callers must
 * check explicitly.
 *
 * CAVEAT: without a schema, a literal JSON `null` body (e.g.
 * `START\nnull\nEND`) parses successfully to the value `null` — which is
 * BYTE-IDENTICAL to this function's own failure sentinel. A caller doing
 * `const v = parseVerdictBlock(out, tags); if (v === null) { ...fail... }`
 * cannot distinguish "the agent explicitly emitted null" from "parsing
 * failed". Callers should supply an object-shaped Zod `schema` (which rejects
 * a bare `null` body via safeParse) rather than relying on a raw, schema-less
 * `T` and truthiness of the return value.
 */
export function parseVerdictBlock<T = unknown>(output: string, tags: VerdictTags, schema?: ZodType<T>): T | null {
  if (!output || output.trim().length === 0) return null;

  const startIdx = output.indexOf(tags.start);
  if (startIdx === -1) return null;

  const endIdx = output.indexOf(tags.end, startIdx + tags.start.length);
  if (endIdx === -1) return null;

  const raw = output.slice(startIdx + tags.start.length, endIdx).trim();
  if (raw.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (schema) {
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  }

  return parsed as T;
}
