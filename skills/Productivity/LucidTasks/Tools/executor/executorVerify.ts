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
 *   - Intent + UI evidence (2026-10-23, task t-mvfkuj9e-1v6obq): the verifier judges against
 *     Jm's original words, not only the rewritten DONE WHEN, and a UI change gets a rendered
 *     desktop + phone review against qualityBar.ts's UI_DESIGN_BAR. `applyEvidenceGates` then
 *     refuses a "pass" that lacks the evidence: no intent checks, an unmet requirement, or a UI
 *     change without screenshots. A refused pass never reaches runAutoMerge as "pass".
 */

import { execFileSync } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
import {
  INTENT_RULE,
  UI_DESIGN_BAR,
  changedPathsFromDiff,
  findReviewScreenshots,
  isUiPath,
  type ReviewScreenshots,
} from "./qualityBar.ts";

// ============================================================================
// Types
// ============================================================================

/** Tags for the verifier's structured output block — distinct from the builder's EXECUTOR_VERDICT. */
export const VERIFY_TAGS: VerdictTags = {
  start: "EXECUTOR_VERIFY_START",
  end: "EXECUTOR_VERIFY_END",
};

const IntentCheckSchema = z.object({
  requirement: z.string().min(1),
  met: z.boolean(),
  evidence: z.string(),
});

export type IntentCheck = z.infer<typeof IntentCheckSchema>;

const VerifyVerdictSchema = z.object({
  verdict: z.enum(["pass", "fail", "uncertain"]),
  reasoning: z.string().min(1),
  checkedCommands: z.array(z.string()).optional(),
  intentChecks: z.array(IntentCheckSchema).optional(),
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
  /** One entry per requirement in Jm's words, as the verifier judged it. */
  intentChecks?: IntentCheck[];
  /** UI changes only: the desktop + phone screenshots the verifier saved. */
  screenshots?: string[];
  /** Set when applyEvidenceGates refused the verifier's "pass" — says why. */
  gate?: string;
}

export type VerifyOutcome =
  | { kind: "verified"; record: VerifyRecord }
  | { kind: "infra-unavailable"; reason: string };

export interface VerifyTaskInput {
  id: string;
  title: string;
  description?: string | null;
  raw_input?: string | null;
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
  /** Injectable screenshot folder for a UI change — defaults to a fresh mkdtemp under tmpdir(). */
  makeShotsDir?: (taskId: string) => string;
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
  /** Set when the diff touches UI paths — the folder the verifier must save its screenshots to. */
  ui?: { shotsDir: string };
}

const CHROME = '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"';

/** The rendered-review section for a UI change. Pure. */
function buildUiReviewSection(shotsDir: string): string {
  return `## UI REVIEW — MANDATORY FOR THIS CHANGE

This diff changes something a person sees in a browser. Tests and parsed HTML do not show if it is
simple, uncrowded or usable. **You must render it and look at it.**

1. Start the server that serves the changed page FROM THIS WORKTREE, bound to 127.0.0.1 on a free
   port, in the background, with its log in the screenshot folder. Kaya dashboards turn auth off on
   a loopback bind, but a bind secret can override the default and give 401, so set the host env
   var. LifeOS dashboard:
   \`LIFEOS_DASH_HOST=127.0.0.1 LIFEOS_DASH_PORT=<free port> bun skills/Productivity/LifeOS/Dashboards/DashboardServer.ts > ${shotsDir}/server.log 2>&1 &\`
   For another app, find its start command in the changed files or its skill docs.
2. Wait until \`curl\` gets 200 from the page URL.
3. Take full screenshots with headless Chrome, with exactly these file names. Desktop:
   \`${CHROME} --headless=new --disable-gpu --hide-scrollbars --window-size=1280,2400 --screenshot=${shotsDir}/desktop.png <url>\`
   Phone: headless Chrome never goes below 500 px wide (a 390 window still renders at 500 and
   looks clipped), so frame the page at 390 px. Write \`${shotsDir}/phone-frame.html\` containing
   \`<iframe src="<url>" width="390" height="2400" style="border:0"></iframe>\`, then:
   \`${CHROME} --headless=new --disable-gpu --hide-scrollbars --window-size=500,2400 --screenshot=${shotsDir}/phone.png file://${shotsDir}/phone-frame.html\`
   More views are welcome (\`desktop-2.png\`, \`phone-2.png\`, ...).
4. Open every screenshot with the Read tool and look at it. Judge it against Jm's words and the UI
   bar below. Each failed point of the bar is a defect.
5. Stop the server (\`kill <pid>\`).

For this review you may also run headless Chrome and the server start command above, and write
files in \`${shotsDir}\` (and only there). If you cannot render the page, the verdict is
"uncertain", never "pass". The executor checks that \`desktop*.png\` and \`phone*.png\` exist in
that folder; a UI "pass" without them is refused.

${UI_DESIGN_BAR}`;
}

/**
 * Build the SKEPTICAL verifier prompt. Pure — exported for tests.
 *
 * Posture: the verifier did not write this code, has no stake in it being good, and is
 * instructed to actively try to REFUTE completion rather than confirm it — the opposite
 * incentive from the builder agent that just delivered the work.
 */
export function buildVerifierPrompt(input: VerifyPromptInput): string {
  const { task, branch, builderSummary, diff, ui } = input;
  const uiSection = ui ? `\n---\n\n${buildUiReviewSection(ui.shotsDir)}\n` : "";

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
**Raw Input**: ${task.raw_input?.trim() || "(none)"}

---

${INTENT_RULE}

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
5. **Judge the result against Jm's words** (see JM'S WORDS ARE THE SPEC). Fill \`intentChecks\`
   with one entry per requirement, quality words included. Something that works but misses a
   quality word ("simple", "seamless", ...) is not met. A requirement you could not check is not
   met either: an important part you could not exercise makes the verdict "uncertain".
${uiSection}
---

## OUTPUT CONTRACT — MANDATORY

This is the LAST thing in your response. Emit it exactly as shown (no extra whitespace or text
between the markers):

EXECUTOR_VERIFY_START
{"verdict": "pass"|"fail"|"uncertain", "reasoning": "<your actual findings — cite what you checked and what you found>", "checkedCommands": ["<command you actually ran>", "..."], "intentChecks": [{"requirement": "<one requirement from Jm's words>", "met": true|false, "evidence": "<what you saw>"}]}
EXECUTOR_VERIFY_END

- **"pass"**: you checked and found no real defect, AND every intent check is met — the task is
  genuinely, fully done as Jm asked for it, not only as DONE WHEN summarized it.
- **"fail"**: you found a concrete defect (broken/missing test, missing functionality, a false
  claim in the summary, an unmet requirement or quality word from Jm, a UI bar failure, etc.) —
  cite it in \`reasoning\`.
- **"uncertain"**: you could not reach a confident verdict (e.g. no way to run checks here, the
  page would not render, the task is inherently unverifiable by automated means) — say why in
  \`reasoning\`.

\`reasoning\` is required and must reference what you actually checked, not what you assume would
happen. \`checkedCommands\` should list the exact commands you ran (empty array if none).
\`intentChecks\` is required: the executor refuses a "pass" without it, and a "pass" with any
\`"met": false\`. If you fail to emit this block exactly, your review will be discarded and the
task will be treated as unverified.
`;
}

// ============================================================================
// Evidence gates
// ============================================================================

export interface EvidenceGateInput {
  parsed: VerifyVerdictParsed;
  /** True when the diff touches UI paths (qualityBar.ts isUiPath). */
  ui: boolean;
  shots: ReviewScreenshots;
}

export interface EvidenceGateResult {
  verdict: VerifyRecord["verdict"];
  /** Why a "pass" was refused; undefined when the verdict stands. */
  gate?: string;
}

/**
 * Refuse a "pass" that lacks its evidence. Pure — exported for tests. Only "pass" is ever
 * changed: the verifier's own fail/uncertain always stand. Order matters — an unmet requirement
 * is a concrete defect (fail); missing evidence is only "not shown" (uncertain).
 */
export function applyEvidenceGates(input: EvidenceGateInput): EvidenceGateResult {
  const { parsed, ui, shots } = input;
  if (parsed.verdict !== "pass") return { verdict: parsed.verdict };

  const unmet = (parsed.intentChecks ?? []).filter((c) => !c.met);
  if (unmet.length > 0) {
    return {
      verdict: "fail",
      gate: `pass refused: requirement(s) from Jm's words not met: ${unmet.map((c) => c.requirement).join("; ")}`,
    };
  }
  if (!parsed.intentChecks || parsed.intentChecks.length === 0) {
    return {
      verdict: "uncertain",
      gate: "pass refused: no intent checks — the verifier did not judge the result against Jm's original words",
    };
  }
  if (ui && (shots.desktop.length === 0 || shots.phone.length === 0)) {
    return {
      verdict: "uncertain",
      gate: "pass refused: UI change without rendered screenshots at desktop and phone width — nobody looked at the screen",
    };
  }
  return { verdict: "pass" };
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
  // UI detection reads the FULL diff's paths — the bounded copy may have cut the UI file off.
  const rawDiff = gitDiffFn(params.wtPath);
  const diff = getBoundedDiff(params.wtPath, () => rawDiff);
  const isUi = changedPathsFromDiff(rawDiff).some(isUiPath);
  const shotsDir = isUi
    ? (deps.makeShotsDir ?? ((id: string) => mkdtempSync(join(tmpdir(), `kaya-verify-${id}-`))))(params.task.id)
    : undefined;
  const prompt = buildVerifierPrompt({
    task: params.task,
    branch: params.branch,
    builderSummary: params.builderSummary,
    diff,
    ui: shotsDir ? { shotsDir } : undefined,
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

  const shots = shotsDir ? findReviewScreenshots(shotsDir) : { desktop: [], phone: [] };
  const gated = applyEvidenceGates({ parsed, ui: isUi, shots });
  const screenshots = [...shots.desktop, ...shots.phone];

  return {
    kind: "verified",
    record: {
      taskId: params.task.id,
      branch: params.branch,
      verdict: gated.verdict,
      reasoning: gated.gate ? `GATE — ${gated.gate}. Verifier said: ${parsed.reasoning}` : parsed.reasoning,
      checkedCommands: parsed.checkedCommands ?? [],
      ts: new Date().toISOString(),
      agentDurationMs,
      ...(parsed.intentChecks ? { intentChecks: parsed.intentChecks } : {}),
      ...(screenshots.length > 0 ? { screenshots } : {}),
      ...(gated.gate ? { gate: gated.gate } : {}),
    },
  };
}
