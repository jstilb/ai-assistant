#!/usr/bin/env bun
/**
 * executorVerify.ts — Lane A post-delivery verification (slice F1).
 *
 * Today the executor delivers with ZERO verification: the builder agent self-reports an
 * EXECUTOR_VERDICT and that's it — no independent check. This module adds ONE extra step
 * AFTER captureWorktreeChanges succeeds (there ARE committed changes on the task branch):
 * spawn a second, SKEPTICAL agent whose only job is to try to REFUTE the claim that the task
 * is actually done, working live inside the same worktree on the delivered branch.
 *
 * This is verification, not merge policy — slice F2 (not this slice) decides what to DO with
 * a fail/uncertain verdict (auto-merge vs. hold). Here we only produce a trustworthy record.
 *
 * Design:
 *   - `runVerification()` is the sole orchestration entry point: bounded diff → skeptical
 *     prompt → spawnAgentSync (model "opus", read-oriented tools + Bash, cwd = the worktree)
 *     → parseVerdictBlock. Synchronous, matching the proven executor/spawnAgent.ts shape (the
 *     builder spawn it runs after is also synchronous-from-runTask's perspective).
 *   - DI seam: `deps` is `AgentSpawnDeps` (the SAME shape AgentSpawner.test.ts injects —
 *     `spawnFn` never touches a real process) plus two small extras (`gitDiffFn`, `now`) for
 *     deterministic tests. No hand-rolled parallel DI shape.
 *   - Every non-"clean pass/fail/uncertain-from-the-agent" outcome is still surfaced, never
 *     dropped:
 *       - infra-unavailable (rate limit / credit pool / timeout / pre-spawn gate, per
 *         AgentSpawner's shared `infraUnavailable` classifier) → `{ kind: "infra-unavailable" }`,
 *         NO record — the caller must not silently treat this as "verified."
 *       - agent ran but exited non-zero, OR ran and emitted no parseable EXECUTOR_VERIFY
 *         block → a synthesized `verdict: "uncertain"` record with `degraded: true` so the
 *         caller can tell "the agent genuinely said uncertain" apart from "we never got a
 *         real verdict" (both cases need surfacing, but only the latter warrants
 *         recordFailure()).
 *   - Does NOT wire SelfVerifyRunner.ts directly — instead the prompt instructs the verifier
 *     to run the repo's own relevant tests/typecheck itself via its own Bash access. S12: the
 *     command-safety instructions in the prompt are RENDERED from the SAME
 *     lib/core/CommandSafety.ts SELF_VERIFY_SCOPE that SelfVerifyRunner enforces in code
 *     (describeScopeForPrompt) — the two lanes can no longer drift.
 */

import { execFileSync } from "child_process";
import { z } from "zod";
import {
  describeScopeForPrompt,
  SELF_VERIFY_SCOPE,
} from "../../../../../lib/core/CommandSafety.ts";
import {
  spawnAgentSync,
  parseVerdictBlock,
  type AgentSpawnDeps,
  type VerdictTags,
} from "../../../../../lib/core/AgentSpawner.ts";

// ============================================================================
// Types
// ============================================================================

/** Tags for the verifier's structured output block — distinct from the builder's EXECUTOR_VERDICT. */
export const VERIFY_TAGS: VerdictTags = {
  start: "EXECUTOR_VERIFY_START",
  end: "EXECUTOR_VERIFY_END",
};

const VerifyVerdictSchema = z.object({
  verdict: z.enum(["pass", "fail", "uncertain"]),
  reasoning: z.string().min(1),
  checkedCommands: z.array(z.string()).optional(),
});

export type VerifyVerdictParsed = z.infer<typeof VerifyVerdictSchema>;

export interface VerifyRecord {
  taskId: string;
  branch: string;
  verdict: "pass" | "fail" | "uncertain";
  reasoning: string;
  /** Commands the verifier reports having actually run. Always an array; [] if none. */
  checkedCommands: string[];
  ts: string;
  agentDurationMs: number;
  /**
   * True ONLY when this record was synthesized because the verifier agent's output could not
   * be turned into a real verdict (crashed, or no parseable EXECUTOR_VERIFY block) — never a
   * genuine judgment from the agent. Callers should call recordFailure() when true: this is an
   * infra/parsing degradation, not a deliberate "uncertain" from the verifier.
   */
  degraded?: boolean;
}

export type VerifyOutcome =
  | { kind: "verified"; record: VerifyRecord }
  | { kind: "infra-unavailable"; reason: string };

export interface VerifyTaskInput {
  id: string;
  title: string;
  description?: string | null;
}

export interface VerifyParams {
  task: VerifyTaskInput;
  /** The executor's task branch (e.g. `executor/task-<id>`) — for record-keeping and the prompt. */
  branch: string;
  /** The isolated worktree path — verifier spawns with this as cwd and reads/runs live there. */
  wtPath: string;
  /** The builder agent's own EXECUTOR_VERDICT summary — given to the verifier as a claim to check. */
  builderSummary: string;
}

export interface VerifyDeps extends AgentSpawnDeps {
  /** Injectable diff computation — defaults to a real `git diff --stat`+`diff` in wtPath. */
  gitDiffFn?: (wtPath: string) => string;
  /** Injectable clock for deterministic duration measurement in tests. Defaults to Date.now. */
  now?: () => number;
}

// ============================================================================
// Constants
// ============================================================================

/** Read-oriented + Bash (for running checks INSIDE the worktree) — no Write/Edit. */
const VERIFY_ALLOWED_TOOLS = "Bash,Read,Grep,Glob";

/** Bounded — this is a review pass, not another 90-minute build. */
const VERIFY_TIMEOUT_MS = 15 * 60 * 1000;

/** Diff is capped to keep the prompt small; the stat summary is prepended so scope is visible
 *  even when the full diff is truncated. */
const DIFF_LINE_CAP = 400;

// ============================================================================
// Bounded diff
// ============================================================================

function runGit(args: string[], wtPath: string): string {
  try {
    return execFileSync("git", args, {
      cwd: wtPath,
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    return `(git ${args.join(" ")} failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}

/** Default diff source: `git diff --stat main...HEAD` + `git diff main...HEAD`, both live in wtPath. */
function defaultGitDiff(wtPath: string): string {
  const stat = runGit(["diff", "--stat", "main...HEAD"], wtPath);
  const full = runGit(["diff", "main...HEAD"], wtPath);
  return `--- STAT (git diff --stat main...HEAD) ---\n${stat}\n--- DIFF (git diff main...HEAD) ---\n${full}`;
}

/**
 * Cap a diff string to DIFF_LINE_CAP lines, appending a truncation notice. Pure — exported
 * for tests. `gitDiffFn` defaults to the real `defaultGitDiff`.
 */
export function getBoundedDiff(
  wtPath: string,
  gitDiffFn: (wtPath: string) => string = defaultGitDiff,
): string {
  const raw = gitDiffFn(wtPath);
  const lines = raw.split("\n");
  if (lines.length <= DIFF_LINE_CAP) return raw;
  const remaining = lines.length - DIFF_LINE_CAP;
  return lines.slice(0, DIFF_LINE_CAP).join("\n") + `\n... [diff truncated — ${remaining} more line(s)] ...`;
}

// ============================================================================
// Prompt
// ============================================================================

export interface VerifyPromptInput {
  task: VerifyTaskInput;
  branch: string;
  builderSummary: string;
  diff: string;
}

/**
 * Build the SKEPTICAL verifier prompt. Pure — exported for tests.
 *
 * Posture: the verifier did not write this code, has no stake in it being good, and is
 * instructed to actively try to REFUTE completion rather than confirm it — the opposite
 * incentive from the builder agent that just delivered the work.
 */
export function buildVerifierPrompt(input: VerifyPromptInput): string {
  const { task, branch, builderSummary, diff } = input;

  return `# SKEPTICAL CODE VERIFIER

## YOUR ROLE

You are an adversarial verifier reviewing another agent's completed work. You did NOT write this
code and have no stake in it looking good. Your job is to try to **REFUTE** the claim that this
task is actually, fully done — not to confirm it. Assume the builder agent may have been lazy,
may have left tests failing or skipped, may have claimed something works without checking, may
have weakened a test to make it pass, or may have silently done only part of the task. Do not give the benefit of the doubt.
Only report "pass" if you actually checked and could not find a real defect.

---

## THE TASK THAT WAS SUPPOSED TO BE DONE

**ID**: ${task.id}
**Title**: ${task.title}
**Description**: ${task.description?.trim() || "(none)"}

---

## WHAT THE BUILDER CLAIMS IT DID

${builderSummary}

---

## THE DIFF IT PRODUCED (branch \`${branch}\`, may be truncated)

\`\`\`diff
${diff}
\`\`\`

---

## YOUR JOB

1. Read the diff. Does it actually match the task and the builder's claimed summary —
   **completely**, not partially? Is anything claimed but not present in the diff?
2. **Actually run checks.** You are already live inside the worktree on the delivered branch
   (your cwd IS this worktree) — use Bash to run the repo's OWN test command(s) for any file(s)
   touched by the diff (e.g. \`bun test <absolute/path/to/*.test.ts>\` for a changed \`.ts\` file
   with a co-located test, or \`bunx tsc --noEmit\` if there's a tsconfig and no test exists).
   Command safety rules (rendered from the shared self-verify scope in
   lib/core/CommandSafety.ts — the same allowlist SelfVerifyRunner enforces in code):
${describeScopeForPrompt(SELF_VERIFY_SCOPE)}
3. Look specifically for: tests that don't actually exist for the claimed behavior, tests that
   were weakened or deleted to make the suite pass, claims in the summary not backed by the diff,
   missing error handling, dead/placeholder code, an incomplete implementation of the task's real
   requirements, or a summary that oversells what was actually done.
4. If a check would take too long or you genuinely cannot run it in this environment, say so
   explicitly in your reasoning rather than assuming it would have passed.

---

## OUTPUT CONTRACT — MANDATORY

This is the LAST thing in your response. Emit it exactly as shown (no extra whitespace or text
between the markers):

EXECUTOR_VERIFY_START
{"verdict": "pass"|"fail"|"uncertain", "reasoning": "<your actual findings — cite what you checked and what you found>", "checkedCommands": ["<command you actually ran>", "..."]}
EXECUTOR_VERIFY_END

- **"pass"**: you checked and found no real defect — the task is genuinely, fully done.
- **"fail"**: you found a concrete defect (broken/missing test, missing functionality, a false
  claim in the summary, etc.) — cite it in \`reasoning\`.
- **"uncertain"**: you could not reach a confident verdict (e.g. no way to run checks here, the
  task is inherently unverifiable by automated means) — say why in \`reasoning\`.

\`reasoning\` is required and must reference what you actually checked, not what you assume would
happen. \`checkedCommands\` should list the exact commands you ran (empty array if none). If you
fail to emit this block exactly, your review will be discarded and the task will be treated as
unverified.
`;
}

// ============================================================================
// Core
// ============================================================================

function buildDegradedRecord(
  params: VerifyParams,
  reasoning: string,
  agentDurationMs: number,
): VerifyRecord {
  return {
    taskId: params.task.id,
    branch: params.branch,
    verdict: "uncertain",
    reasoning,
    checkedCommands: [],
    ts: new Date().toISOString(),
    agentDurationMs,
    degraded: true,
  };
}

/**
 * Run the skeptical verifier agent against a delivered worktree and return a structured
 * outcome. Never throws — spawn/parse failures become a degraded "uncertain" record (or, for
 * infra unavailability, a distinct `infra-unavailable` outcome with NO record at all).
 */
export function runVerification(params: VerifyParams, deps: VerifyDeps = {}): VerifyOutcome {
  const now = deps.now ?? (() => Date.now());
  const start = now();

  const gitDiffFn = deps.gitDiffFn ?? defaultGitDiff;
  const diff = getBoundedDiff(params.wtPath, gitDiffFn);
  const prompt = buildVerifierPrompt({
    task: params.task,
    branch: params.branch,
    builderSummary: params.builderSummary,
    diff,
  });

  const res = spawnAgentSync(
    {
      prompt,
      model: "opus",
      allowedTools: VERIFY_ALLOWED_TOOLS,
      cwd: params.wtPath,
      timeoutMs: VERIFY_TIMEOUT_MS,
      env: { KAYA_AUTONOMOUS: "1" },
    },
    deps,
  );

  const agentDurationMs = now() - start;

  // Infra unavailable (rate limit / credit pool / timeout / pre-spawn gate) — NEVER
  // synthesize a record here. The caller must treat this as "not reviewed at all," not as a
  // verdict of any kind.
  if (res.infraUnavailable) {
    const reason =
      res.stdout.trim() || res.stderr.trim() || (res.timedOut ? "verifier agent timed out" : "infra unavailable");
    return { kind: "infra-unavailable", reason };
  }

  // Agent ran but did not complete cleanly (non-infra crash/non-zero exit) — not proof the
  // work is broken, but not a real verdict either. Surface as degraded-uncertain.
  if (!res.success) {
    return {
      kind: "verified",
      record: buildDegradedRecord(
        params,
        `verifier agent did not complete cleanly (exit ${res.exitCode})`,
        agentDurationMs,
      ),
    };
  }

  const parsed = parseVerdictBlock<VerifyVerdictParsed>(res.stdout, VERIFY_TAGS, VerifyVerdictSchema);
  if (!parsed) {
    return {
      kind: "verified",
      record: buildDegradedRecord(
        params,
        "verifier agent did not emit a valid EXECUTOR_VERIFY block",
        agentDurationMs,
      ),
    };
  }

  return {
    kind: "verified",
    record: {
      taskId: params.task.id,
      branch: params.branch,
      verdict: parsed.verdict,
      reasoning: parsed.reasoning,
      checkedCommands: parsed.checkedCommands ?? [],
      ts: new Date().toISOString(),
      agentDurationMs,
    },
  };
}
