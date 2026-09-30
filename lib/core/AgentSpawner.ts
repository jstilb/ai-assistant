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
 *   - The rate-limit gate (pre-spawn `isRateLimited()` + post-spawn
 *     `isRateLimitError()` on BOTH stdout and stderr) and the infra-vs-failure
 *     split (`isInfraUnavailable`) generalize
 *     `skills/Productivity/LucidTasks/Tools/executor/executor.ts`'s
 *     `isInfraUnavailable` so callers can distinguish "defer and retry" from
 *     "genuine task failure" without re-deriving the pattern-matching.
 *   - The process-spawn function is injectable (`deps.spawnFn`) so unit tests
 *     never spawn a real process or call a real LLM; worktree resolution is
 *     likewise injectable (`deps.getOrCreateWorktreeFn`).
 *   - `parseVerdictBlock()` generalizes
 *     `skills/Productivity/LucidTasks/Tools/executor/verdictParser.ts`: caller
 *     supplies start/end tag strings (and an optional Zod schema); returns null
 *     on ANY malformity — never a default, never a partial result.
 */

import { spawnSync } from "child_process";
import type { ZodType } from "zod";
import { CLAUDE_PATH, buildHardenedClaudeEnv, stripDangerousClaudeEnvKeys } from "./Inference.ts";
import { isRateLimited, isRateLimitError, DEFAULT_THRESHOLD } from "./RateLimitGuard.ts";
import { getKayaHome } from "./KayaHome.ts";
import { getOrCreateWorktree } from "./WorktreeManager.ts";
import type { CreateWorktreeOptions } from "./WorktreeManager.ts";

// ============================================================================
// Constants
// ============================================================================

/** Matches the reference implementations' proven timeout (executor Lane A). */
export const DEFAULT_TIMEOUT_MS = 90 * 60 * 1000;

/** Matches both reference implementations' spawnSync maxBuffer. */
export const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Other "infra unavailable" signals beyond the rate/usage/session-limit wording
 * (owned by the shared RateLimitGuard `isRateLimitError` detector): credit-pool /
 * quota / overload notices that also warrant a retry-not-blame pause.
 * Ported verbatim from executor.ts's INFRA_UNAVAILABLE_PATTERN.
 */
const INFRA_UNAVAILABLE_PATTERN = /exhaust|credit|pool|paused|monthly|quota|overloaded/i;

/**
 * Node.js errno codes that indicate a DNS/network-layer failure reaching the
 * API, not a task failure. Sourced from `spawnSync`'s `error.code`.
 */
const NETWORK_ERROR_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "ENETUNREACH", "EAI_AGAIN"]);

/**
 * Matches network/DNS failure signals in stdout/stderr TEXT: the same errno
 * code strings (some CLI wrappers print the code into the text rather than
 * surfacing it via a structured `error.code`) plus the CLI's own literal
 * "Can't reach the API server" wording. This is the actual bug this slice
 * fixes — previously this text matched NO infra pattern and fell through to a
 * generic task failure, mislabeling a DNS/network outage as a task bug.
 * `.` (not a literal apostrophe) tolerates straight/curly-quote variants.
 */
const NETWORK_UNAVAILABLE_TEXT_PATTERN = /\b(ENOTFOUND|ECONNREFUSED|ENETUNREACH|EAI_AGAIN)\b|can.t reach the api server/i;

// ============================================================================
// Types
// ============================================================================

/**
 * WHY a spawn result is infra-unavailable (undefined when it isn't).
 * Precedence when a result could match more than one — timeout → network →
 * rate-limit → quota → no-output — is documented on `classifyInfraReason`.
 */
export type InfraReason = "timeout" | "network" | "rate-limit" | "quota" | "no-output";

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
   * See `classifyInfraReason` for the precedence order.
   */
  infraReason?: InfraReason;
  /** Node.js errno code from a spawn-level error (e.g. "ENOTFOUND"), when present. */
  errorCode?: string;
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
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
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
          hooks: [{ type: "command", command: `bun run ${kayaDir}/hooks/PromptInjectionDefender.hook.ts`, timeout: 10 }],
        },
        {
          matcher: "Read",
          hooks: [{ type: "command", command: `bun run ${kayaDir}/hooks/PromptInjectionDefender.hook.ts`, timeout: 10 }],
        },
        {
          matcher: "WebFetch",
          hooks: [{ type: "command", command: `bun run ${kayaDir}/hooks/PromptInjectionDefender.hook.ts`, timeout: 10 }],
        },
        {
          matcher: "WebSearch",
          hooks: [{ type: "command", command: `bun run ${kayaDir}/hooks/PromptInjectionDefender.hook.ts`, timeout: 10 }],
        },
      ],
    },
  });
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
// Infra-vs-failure classification
// ============================================================================

/** Pick shape shared by `classifyInfraReason` / `isInfraUnavailable`. */
type InfraClassifiable = Pick<
  AgentSpawnResult,
  "success" | "stdout" | "stderr" | "timedOut" | "preSpawnGated" | "errorCode"
>;

/**
 * Classify WHY a spawn result is an infrastructure/credit-pool pause (vs. a
 * real task failure) — or return undefined when it isn't one. Pure — exported
 * for tests and for callers that want to re-classify a result independently
 * (e.g. after batching).
 *
 * Precedence (first match wins) — documented here because a result can match
 * more than one bucket (e.g. a timed-out spawn can also have credit-pool text
 * in a partial stdout capture) and the order determines which reason callers
 * see:
 *   1. timeout    — process was killed/errored on timeout; any text present
 *                    is incidental, so this pre-empts everything else.
 *   2. network     — DNS/connection-layer failure (errno code OR the CLI's own
 *                    "Can't reach the API server" text). Checked next because
 *                    it is the most specific, actionable cause and — this is
 *                    the bug this slice fixes — previously matched NO pattern
 *                    at all, mislabeling a network outage as a task failure.
 *   3. rate-limit  — the shared RateLimitGuard rate/usage/session-limit wording.
 *   4. quota       — the broader credit/pool/quota/overloaded wording.
 *   5. no-output   — blank stdout AND blank stderr on a genuine failure (silent
 *                    infra shutdown); the catch-all, checked last since it only
 *                    applies when nothing more specific matched.
 *
 * Generalizes executor.ts's `isInfraUnavailable`: checks BOTH stdout and
 * stderr for the rate/usage/session-limit wording (the `--output-format text`
 * limit notice surfaces on stdout, not stderr — a stderr-only check would
 * mislabel a session-limit hit as a genuine failure).
 */
export function classifyInfraReason(res: InfraClassifiable): InfraReason | undefined {
  if (res.success) return undefined;
  if (res.timedOut) return "timeout";
  if (isNetworkFailure(res)) return "network";
  const combined = `${res.stdout}\n${res.stderr}`;
  if (isRateLimitError(combined)) return "rate-limit";
  if (INFRA_UNAVAILABLE_PATTERN.test(combined)) return "quota";
  if (res.stdout.trim() === "" && res.stderr.trim() === "") return "no-output";
  return undefined;
}

/**
 * Boolean form of `classifyInfraReason`, plus the pre-spawn-gated case (which
 * has no InfraReason value of its own — the process never ran, so there is no
 * timeout/network/rate-limit/quota/no-output text to classify).
 */
export function isInfraUnavailable(res: InfraClassifiable): boolean {
  if (res.success) return false;
  if (res.preSpawnGated) return true;
  return classifyInfraReason(res) !== undefined;
}

/**
 * True when a spawn-level error code (e.g. ENOTFOUND from Node's DNS
 * resolver) or the stdout/stderr TEXT indicates a DNS/network-layer failure
 * reaching the API — as opposed to the agent's own task outcome.
 */
function isNetworkFailure(res: Pick<AgentSpawnResult, "stdout" | "stderr" | "errorCode">): boolean {
  if (res.errorCode && NETWORK_ERROR_CODES.has(res.errorCode)) return true;
  return NETWORK_UNAVAILABLE_TEXT_PATTERN.test(`${res.stdout}\n${res.stderr}`);
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
  const env = buildSpawnEnv(opts.env);

  // `--allowedTools` is a permission-system allow-list — under
  // `--dangerously-skip-permissions` the permission system never runs, so it
  // is INERT as a boundary (verified live, S-06 slice-3 probe 0b: a Bash-less
  // `--allowedTools Read` agent ran Bash anyway). `--tools` is the flag that
  // actually restricts the built-in tool set regardless of permission mode,
  // so it is the real enforcement mechanism — passed alongside `--allowedTools`
  // (kept, so permission semantics are unchanged if a future caller drops
  // skip-permissions) rather than replacing it. Gated behind `enforceTools`
  // (see `resolveEnforceTools` doc comment) — default OFF.
  const args: string[] = [
    "-p",
    "--model", opts.model,
    ...(opts.effort ? ["--effort", opts.effort] : []),
    "--dangerously-skip-permissions",
    "--allowedTools", opts.allowedTools,
  ];

  if (resolveEnforceTools(opts.enforceTools, process.env)) {
    args.push("--tools", opts.allowedTools);
  }

  args.push(
    "--setting-sources", "", // disable hooks to prevent recursion
    "--output-format", "text",
  );

  if (resolveGuardHooks(opts.guardHooks, process.env)) {
    const kayaDir = getKayaHome(); // KAYA_HOME → KAYA_DIR → ~/.claude, same resolution the hooks and Integrator use
    args.push("--settings", buildGuardHookSettings(kayaDir));
  }

  args.push(opts.prompt); // ALWAYS last — never via stdin.

  const spawnFn = deps.spawnFn ?? defaultSpawnFn;
  const raw = spawnFn(CLAUDE_PATH, args, { cwd, env, timeoutMs, maxBuffer });

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
  };
  result.infraReason = classifyInfraReason(result);
  result.infraUnavailable = isInfraUnavailable(result);
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
export async function spawnAgent(
  opts: AgentSpawnOptions,
  deps: AgentSpawnDeps = {},
): Promise<AgentSpawnResult> {
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
export function parseVerdictBlock<T = unknown>(
  output: string,
  tags: VerdictTags,
  schema?: ZodType<T>,
): T | null {
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
