#!/usr/bin/env bun
/**
 * GrillPreResearch.ts — G2: directed-investigation pass, run BEFORE the
 * interactive grill interview, that narrows a needs-grilling item's
 * `grillBrief.suggested_questions` down to the HUMAN-ONLY subset.
 *
 * Problem: `grillBrief.suggested_questions` (set by QueueManager.parkForGrill,
 * sourced from the LLM triage's suggested_questions) mixes two kinds of
 * question — "what does the codebase already do / is this feasible" (answerable
 * by investigation, no Jm needed) and "what does Jm actually want" (genuine
 * human judgment). Every unnecessary question burns interview time. This tool
 * spawns ONE read-only investigation agent to resolve whatever it can before
 * Jm sits down, and rewrites the brief to only the questions that remain.
 *
 * Design:
 *   - ONE `spawnAgentSync` call (lib/core/AgentSpawner.ts), read-only posture
 *     (`Bash,Read,Glob,Grep` — same allowlist as LiveVerifier's Explorer),
 *     model resolved via `RateLimitGuard.resolveModel("sonnet")`.
 *     `skipRateLimitGate` is deliberately NOT set: unlike LiveVerifier (a
 *     batch/autonomous caller that wants the escalated model to actually run
 *     even at high usage), this is a standalone, human-invoked tool — a single
 *     honest pre-spawn gate at high usage is the right, simple behavior here.
 *   - The agent's verdict is a tagged JSON block (`parseVerdictBlock`,
 *     GRILL_PRERESEARCH_START/END tags, zod-validated) with
 *     `{ answeredQuestions, remainingQuestions, newQuestionsForJm? }`.
 *   - Persistence follows the SAME idiom as `QueueManager.attachContext`'s
 *     `researchArtifactPath`: the Q&A is written to a durable artifact file
 *     under MEMORY/WORK, and only its PATH is stored on `_meta` (as
 *     `preResearchArtifactPath`) — never the full blob inline. The
 *     `grillBrief` itself is rewritten in place via
 *     `QueueManager.updateSpecPipelineStatus(id, "needs-grilling", ...)` — a
 *     same-stage patch, which `ALLOWED_TRANSITIONS["needs-grilling"]`
 *     explicitly legalizes as an "idempotent re-park (update brief in place)"
 *     self-loop (see PipelineRepository.ts). `missing`/`confidence`/`verdict`/
 *     `reasoning` on the existing brief are preserved untouched — only
 *     `suggested_questions` is rewritten.
 *   - Failure posture: infra-unavailable (rate limit / credit pool / timeout /
 *     pre-spawn gate) or a malformed/missing verdict block NEVER touches the
 *     brief — the function returns before any persistence call, and logs via
 *     `recordFailure`. A failed pre-research must never eat questions.
 *
 * CLI:
 *   bun GrillPreResearch.ts <itemId> [--dry-run]
 *
 * @module GrillPreResearch
 */

import { join } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { z } from "zod";
import {
  spawnAgentSync,
  parseVerdictBlock,
  type AgentSpawnDeps,
  type VerdictTags,
} from "../../../../lib/core/AgentSpawner.ts";
import { resolveModel } from "../../../../lib/core/RateLimitGuard.ts";
import { recordFailure } from "../../../../lib/core/FailureLog.ts";
import { QueueManager, loadQueueItems, type QueueItem } from "./QueueManager.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================================================
// Config
// ============================================================================

/** Read-only posture — matches LiveVerifier's Explorer allowlist exactly. */
const PRE_RESEARCH_ALLOWED_TOOLS = "Bash,Read,Glob,Grep";

/** Bounded — this is a directed narrowing pass, not a full research spawn. */
const PRE_RESEARCH_TIMEOUT_MS = 10 * 60 * 1000;

// ============================================================================
// Types
// ============================================================================

export interface AnsweredQuestion {
  question: string;
  answer: string;
  evidence: string;
}

/** The raw grillBrief shape as stored on `_meta.grillBrief` by parkForGrill. */
export interface RawGrillBrief {
  missing: string[];
  suggested_questions: string[];
  confidence?: number;
  verdict?: string;
  reasoning?: string;
}

export interface PreResearchVerdict {
  answeredQuestions: AnsweredQuestion[];
  remainingQuestions: string[];
  newQuestionsForJm?: string[];
}

export const PRE_RESEARCH_TAGS: VerdictTags = {
  start: "GRILL_PRERESEARCH_START",
  end: "GRILL_PRERESEARCH_END",
};

const PreResearchVerdictSchema = z.object({
  answeredQuestions: z.array(
    z.object({
      question: z.string(),
      answer: z.string(),
      evidence: z.string(),
    })
  ),
  remainingQuestions: z.array(z.string()),
  newQuestionsForJm: z.array(z.string()).optional(),
});

export interface GrillPreResearchDeps extends AgentSpawnDeps {
  /** Clock override for artifact timestamps (tests). Defaults to real Date.now. */
  now?: () => Date;
}

export type GrillPreResearchOutcome =
  | {
      kind: "completed";
      itemId: string;
      before: string[];
      after: string[];
      answered: AnsweredQuestion[];
      newQuestionsForJm: string[];
      artifactPath: string | null;
      persisted: boolean;
    }
  | {
      kind: "error";
      itemId: string;
      reason: "not-found" | "wrong-status" | "infra-unavailable" | "malformed-verdict" | "spawn-error";
      message: string;
    };

// ============================================================================
// grillBrief access
// ============================================================================

/**
 * Read the FULL grillBrief object (missing/suggested_questions/confidence/
 * verdict/reasoning) recorded by QueueManager.parkForGrill. Distinct from
 * GrillRunner.getGrillBrief(), which only surfaces missing+suggestedQuestions
 * for display — this tool must preserve confidence/verdict/reasoning
 * untouched when it rewrites suggested_questions, so it needs the raw shape.
 */
export function getRawGrillBrief(item: QueueItem): RawGrillBrief {
  const meta = (item.payload.context?._meta as Record<string, unknown>) ?? {};
  const brief = (meta.grillBrief as Partial<RawGrillBrief> | undefined) ?? {};
  return {
    missing: brief.missing ?? [],
    suggested_questions: brief.suggested_questions ?? [],
    confidence: brief.confidence,
    verdict: brief.verdict,
    reasoning: brief.reasoning,
  };
}

// ============================================================================
// Prompt
// ============================================================================

/**
 * Build the directed-investigation prompt. Pure — exported for tests.
 */
export function buildPreResearchPrompt(item: QueueItem, brief: RawGrillBrief): string {
  const questionsBlock = brief.suggested_questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  const missingBlock = brief.missing.length ? brief.missing.map((m) => `- ${m}`).join("\n") : "(none recorded)";

  return `You are a directed-investigation research agent preparing a spec-pipeline item for a human interview (grill session). Your job is NOT to answer every question — it is to investigate the codebase and any relevant docs and answer ONLY the questions that can be resolved from existing facts (code, prior art, feasibility, config), so the human interviewer's time is spent only on genuinely human-judgment questions (product intent, priorities, tradeoffs only Jm can decide).

## Item

**Title:** ${item.payload.title}
**Description:** ${item.payload.description}

## What the triage classifier flagged as missing

${missingBlock}

## Suggested questions to investigate

${questionsBlock}

## Your task

For EACH question above, decide:
- Can this be answered from the codebase/docs/prior art WITHOUT asking Jm? If yes, investigate (Read/Grep/Glob/Bash) and answer it with cited evidence (file:line or command output).
- Is this a genuine human-judgment question (intent, priority, scope decision, preference) that only Jm can answer? Leave it in remainingQuestions.
- Did your investigation surface a NEW question that only Jm can answer (e.g. a discovered tradeoff)? Add it to newQuestionsForJm.

Be honest — if you cannot resolve a question, or you're not confident in the answer, leave it as a remaining/human question rather than guessing. It is entirely valid to answer NONE of the questions if none are actually resolvable from the codebase.

## Output contract — MANDATORY

This is the LAST thing in your response. Emit it exactly as shown (no extra text between the markers):

${PRE_RESEARCH_TAGS.start}
{"answeredQuestions": [{"question": "...", "answer": "...", "evidence": "<file:line or command output>"}], "remainingQuestions": ["..."], "newQuestionsForJm": ["..."]}
${PRE_RESEARCH_TAGS.end}

- answeredQuestions: every question you resolved WITHOUT Jm, with evidence.
- remainingQuestions: every original suggested question you could NOT resolve (human judgment required).
- newQuestionsForJm: any NEW human-only question your investigation surfaced (omit or [] if none).

If you fail to emit this block exactly, your investigation will be discarded and no questions will be narrowed.
`;
}

// ============================================================================
// Artifact
// ============================================================================

/** Render the durable pre-research artifact — same idiom as grill findings artifacts. */
export function renderPreResearchArtifact(item: QueueItem, parsed: PreResearchVerdict, now: Date): string {
  const answeredSection = parsed.answeredQuestions.length
    ? parsed.answeredQuestions
        .map((a) => `### Q: ${a.question}\n**A:** ${a.answer}\n**Evidence:** ${a.evidence}`)
        .join("\n\n")
    : "(none — investigation could not resolve any question without Jm)";
  const remainingSection = parsed.remainingQuestions.length
    ? parsed.remainingQuestions.map((q) => `- ${q}`).join("\n")
    : "(none)";
  const newSection = (parsed.newQuestionsForJm ?? []).length
    ? (parsed.newQuestionsForJm ?? []).map((q) => `- ${q}`).join("\n")
    : "(none)";

  return `# Pre-Research: ${item.payload.title}

**Item ID:** ${item.id}
**Researched At:** ${now.toISOString()}
**Method:** Autonomous directed-investigation pass (GrillPreResearch, pre-interview)

## Answered (no Jm needed)

${answeredSection}

## Remaining questions (human judgment required)

${remainingSection}

## New questions surfaced by investigation

${newSection}
`;
}

function writeArtifact(itemId: string, content: string): string {
  const dir = join(getKayaHome(), "MEMORY/WORK");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `grill-${itemId}-preresearch.md`);
  writeFileSync(path, content, "utf-8");
  return path;
}

// ============================================================================
// Core
// ============================================================================

/**
 * Run the pre-research pass for a needs-grilling item.
 *
 * Never throws for spawn/parse failures — those become `{ kind: "error" }`
 * outcomes, always WITHOUT touching the persisted grillBrief. Only a
 * successfully-parsed verdict (and `!opts.dryRun`) triggers a persist.
 */
export async function runGrillPreResearch(
  itemId: string,
  opts: { dryRun?: boolean } = {},
  deps: GrillPreResearchDeps = {}
): Promise<GrillPreResearchOutcome> {
  const item = loadQueueItems("spec-pipeline").find((i) => i.id === itemId);

  if (!item) {
    const message = `Item ${itemId} not found in spec-pipeline`;
    recordFailure({ source: "GrillPreResearch", error: message, context: { itemId } });
    return { kind: "error", itemId, reason: "not-found", message };
  }

  if (item.status !== "needs-grilling") {
    const message = `Item ${itemId} is not in needs-grilling status (found: "${item.status}") — pre-research only applies to parked items`;
    recordFailure({ source: "GrillPreResearch", error: message, context: { itemId, status: item.status } });
    return { kind: "error", itemId, reason: "wrong-status", message };
  }

  const brief = getRawGrillBrief(item);
  const before = brief.suggested_questions;

  // Nothing to investigate — cheap no-op, never spend a spawn on it.
  if (before.length === 0) {
    return {
      kind: "completed",
      itemId,
      before: [],
      after: [],
      answered: [],
      newQuestionsForJm: [],
      artifactPath: null,
      persisted: false,
    };
  }

  const prompt = buildPreResearchPrompt(item, brief);
  const model = resolveModel("sonnet").model;

  const res = spawnAgentSync(
    {
      prompt,
      model,
      allowedTools: PRE_RESEARCH_ALLOWED_TOOLS,
      cwd: getKayaHome(),
      timeoutMs: PRE_RESEARCH_TIMEOUT_MS,
    },
    deps
  );

  if (res.infraUnavailable) {
    const reason =
      res.stdout.trim() || res.stderr.trim() || (res.timedOut ? "pre-research agent timed out" : "infra unavailable");
    recordFailure({ source: "GrillPreResearch", error: reason, context: { itemId } });
    return { kind: "error", itemId, reason: "infra-unavailable", message: reason };
  }

  if (!res.success) {
    const message = `pre-research agent exited non-zero (${res.exitCode}): ${res.stdout.slice(0, 300) || res.stderr.slice(0, 300)}`;
    recordFailure({ source: "GrillPreResearch", error: message, context: { itemId } });
    return { kind: "error", itemId, reason: "spawn-error", message };
  }

  const parsed = parseVerdictBlock<PreResearchVerdict>(res.stdout, PRE_RESEARCH_TAGS, PreResearchVerdictSchema);
  if (!parsed) {
    const message = "pre-research agent did not emit a valid GRILL_PRERESEARCH block";
    recordFailure({ source: "GrillPreResearch", error: message, context: { itemId } });
    return { kind: "error", itemId, reason: "malformed-verdict", message };
  }

  const newQuestionsForJm = parsed.newQuestionsForJm ?? [];
  const after = [...parsed.remainingQuestions, ...newQuestionsForJm];

  if (opts.dryRun) {
    return {
      kind: "completed",
      itemId,
      before,
      after,
      answered: parsed.answeredQuestions,
      newQuestionsForJm,
      artifactPath: null,
      persisted: false,
    };
  }

  const now = deps.now ? deps.now() : new Date();
  const artifactPath = writeArtifact(itemId, renderPreResearchArtifact(item, parsed, now));

  const qm = new QueueManager();
  const newBrief: RawGrillBrief = { ...brief, suggested_questions: after };
  await qm.updateSpecPipelineStatus(itemId, "needs-grilling", undefined, {
    grillBrief: newBrief,
    preResearchArtifactPath: artifactPath,
    preResearchAt: now.toISOString(),
  });

  return {
    kind: "completed",
    itemId,
    before,
    after,
    answered: parsed.answeredQuestions,
    newQuestionsForJm,
    artifactPath,
    persisted: true,
  };
}

// ============================================================================
// CLI Entry
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const itemId = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  const dryRun = args.includes("--dry-run");

  if (!itemId || args.includes("--help")) {
    console.log(`
GrillPreResearch — directed-investigation pass narrowing grillBrief.suggested_questions
to HUMAN-ONLY questions before an interactive grill interview.

Usage:
  bun GrillPreResearch.ts <itemId> [--dry-run]

  --dry-run   Print the narrowing without persisting it (no queue write, no artifact file).
`);
    process.exit(itemId ? 0 : 1);
  }

  runGrillPreResearch(itemId, { dryRun })
    .then((outcome) => {
      if (outcome.kind === "error") {
        console.error(`GrillPreResearch failed (${outcome.reason}): ${outcome.message}`);
        process.exit(1);
      }

      console.log(`Item: ${outcome.itemId}${dryRun ? "  [DRY RUN — not persisted]" : ""}\n`);
      console.log(`Before (${outcome.before.length}):`);
      for (const q of outcome.before) console.log(`  ? ${q}`);

      if (outcome.answered.length) {
        console.log(`\nAnswered (${outcome.answered.length}):`);
        for (const a of outcome.answered) {
          console.log(`  Q: ${a.question}`);
          console.log(`  A: ${a.answer}`);
          console.log(`  Evidence: ${a.evidence}\n`);
        }
      } else {
        console.log(`\nAnswered: none (investigation resolved nothing without Jm)`);
      }

      console.log(`\nAfter (${outcome.after.length}):`);
      for (const q of outcome.after) console.log(`  ? ${q}`);

      if (outcome.persisted) {
        console.log(`\nPersisted. Artifact: ${outcome.artifactPath}`);
      } else {
        console.log(`\nNot persisted${dryRun ? " (dry-run)" : ""}.`);
      }
    })
    .catch((err) => {
      console.error(`GrillPreResearch error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
