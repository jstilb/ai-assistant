#!/usr/bin/env bun
/**
 * label-router-golden.ts
 *
 * Builds the routing-disposition golden set via REAL ensemble labeling.
 *
 * For each capture string, runs the EnsembleLabelGrader (fast + standard + smart)
 * using the routing rubric from ensemble-known-truth.yaml (single source of truth).
 * Writes one JSONL line per case to:
 *   skills/Intelligence/Evals/Data/golden/router-disposition-golden.jsonl
 *
 * Consensus cases  → { capture, disposition: <label>, source: 'ensemble', labeled_at, criteria_version }
 * Divergent cases  → { capture, disposition: null, divergent: true, votes, source: 'ensemble', labeled_at, criteria_version }
 *
 * Usage:
 *   bun skills/Intelligence/Evals/scripts/label-router-golden.ts
 *   bun skills/Intelligence/Evals/scripts/label-router-golden.ts --dry-run   # print captures, no LLM calls
 */

import { inference } from "../../../../lib/core/Inference.ts";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";

// ============================================================================
// Config
// ============================================================================

const CRITERIA_VERSION = 1;
const OUTPUT_PATH = join(import.meta.dir, "../Data/golden/router-disposition-golden.jsonl");

// ============================================================================
// Routing rubric (mirrors ensemble-known-truth.yaml routing bucket)
// — single source of truth: same rubric the router itself was trained on
// ============================================================================

const ROUTING_SYSTEM_PROMPT = `You are a routing classifier for an AI assistant. Classify the input into exactly
one of four dispositions. Return ONLY valid JSON with the key "disposition".

Disposition rules:
- autonomous: Work Kaya can do independently (research tasks, coding, script writing,
  information lookup, anything achievable via computer). Default when the task is
  clearly doable without a human.
- needs-jm: Requires Jm's physical presence, credentials, or a consequential
  real-world action only a human can perform (e.g., in-person enrollment, cancelling
  a paid subscription, signing a document). NOT for digital research tasks.
- personal-todo: An errand or task Jm must do himself (not Kaya), typically
  involving physical action or personal commitment.
- drop: Test noise, empty input, or clearly throwaway content.

NOTE: lifeos-idea and note are NOT valid dispositions. Food/restaurant/book/media ideas
and pure knowledge captures are handled by moving them to their real home (LifeOS vault
/ Obsidian notes) — they do NOT get a task-level disposition tag.

Examples:
  "research Python async patterns" -> {"disposition": "autonomous"}
  "call dentist to reschedule" -> {"disposition": "personal-todo"}
  "Restaurant: Nobu downtown" -> {"disposition": "drop"}  // agent moves to LifeOS vault instead

Return: {"disposition": "<one-of-enum>"}`;

const CANDIDATE_FIELD = "disposition";

const VALID_DISPOSITIONS = new Set([
  "autonomous",
  "needs-jm",
  "personal-todo",
  "drop",
]);

// ============================================================================
// Capture corpus (≥30 cases)
// Sources:
//   - 18 cases originally drawn from KayaRouter.eval.ts EVAL_CASES (that file is
//     retired — KayaRouter.ts was deleted; cases are preserved inline here as
//     historical anchors)
//   - 12+ additional cases drawn from daily-run task titles and realistic patterns
// ============================================================================

const CAPTURES: string[] = [
  // === From KayaRouter.eval.ts EVAL_CASES (18 cases) ===
  // autonomous — research
  "research cooking courses in san diego",
  "research fashion/style course online",
  // autonomous — build
  "build a script to parse my CSV exports from Asana",
  // lifeos-idea — food/restaurant
  "Food idea: pho hoa",
  "Restaurant: Animae in downtown San Diego",
  // lifeos-idea — media
  "Book list: Dune by Frank Herbert",
  // personal-todo
  "call mom this weekend",
  "buy groceries at trader joe's",
  // note
  "git workflow for feature branches: always branch from main, PR back to main",
  // drop
  "test item delete this",
  // needs-jm
  "cancel my gym membership at Chuze Fitness",
  // autonomous — information
  "find the best productivity apps for iOS in 2026",
  // lifeos-idea — food prefix
  "Food idea: shakshuka from that place on Newport",
  // lifeos-idea — restaurant prefix
  "Restaurant: Soichi sushi omakase",
  // note — insight
  "Key insight: compound interest is the 8th wonder of the world",
  // autonomous — look into
  "Look into pi agent harness for home lab",
  // personal-todo — family
  "call dad before the weekend",
  // drop — test prefix
  "Test: delete this scratchpad entry",

  // === Additional captures from daily-run titles + realistic patterns ===
  // needs-jm — in-person enrollment (calibration anchor from ensemble-known-truth)
  "research cooking courses in san diego (in person)",
  // needs-jm — physical car errand (from daily-runs)
  "Take Car in for Oil Change / Tires @ Sunset Garage",
  // personal-todo — text someone
  "text Jackson about weekend plans",
  // needs-jm — trip ticket purchase (from daily-runs)
  "Buy tickets to Charleston / New York",
  // lifeos-idea — restaurant discovery
  "Restaurant: Born and Raised steakhouse in SD",
  // autonomous — code task
  "write a bun script to batch rename files by date prefix",
  // note — dev reference
  "TypeScript: use `satisfies` instead of `as` for safer type narrowing",
  // autonomous — data analysis
  "analyze my habit_log CSV and produce weekly consistency report",
  // personal-todo — in-person commitment
  "Volunteer for Mentorship @ MIDS",
  // lifeos-idea — movie
  "Movie: Dune Part Two – add to watch list",
  // autonomous — scheduling / system task
  "set up a launchd cron to run the briefing skill every morning at 7am",
  // drop — empty / noise
  "asdf",
  // note — factual reference
  "REST APIs use HTTP verbs: GET read, POST create, PUT replace, PATCH update, DELETE remove",
  // autonomous — web research
  "research best standing desks under $500 with monitor arm compatibility",
  // personal-todo — gym
  "go to the gym — leg day",
  // lifeos-idea — podcast
  "Podcast: Lex Friedman ep with Sam Altman — add to queue",
];

// ============================================================================
// Ensemble labeler
// ============================================================================

type InferenceLevel = "fast" | "standard" | "smart";
const LEVELS: InferenceLevel[] = ["fast", "standard", "smart"];

interface EnsembleResult {
  capture: string;
  label: string | null;
  divergent: boolean;
  votes: Record<string, number>;
}

async function ensembleLabel(capture: string): Promise<EnsembleResult> {
  // Run all three levels in parallel
  const rawResults = await Promise.all(
    LEVELS.map((level) =>
      inference({
        systemPrompt: ROUTING_SYSTEM_PROMPT,
        userPrompt: capture,
        level,
        expectJson: true,
        retries: 2,
      })
    )
  );

  // Tally votes
  const votes: Record<string, number> = {};
  let voterCount = 0;

  for (const result of rawResults) {
    const raw = result.success && result.parsed != null
      ? (result.parsed as Record<string, unknown>)[CANDIDATE_FIELD]
      : undefined;

    if (typeof raw === "string" && VALID_DISPOSITIONS.has(raw)) {
      votes[raw] = (votes[raw] ?? 0) + 1;
      voterCount++;
    }
  }

  if (voterCount === 0) {
    return { capture, label: null, divergent: true, votes };
  }

  // Simple majority: top vote must have >50% of voter count
  let topLabel: string | undefined;
  let topCount = 0;
  for (const [label, count] of Object.entries(votes)) {
    if (count > topCount) {
      topCount = count;
      topLabel = label;
    }
  }

  const hasMajority = topLabel !== undefined && topCount * 2 > voterCount;

  if (hasMajority && topLabel !== undefined) {
    return { capture, label: topLabel, divergent: false, votes };
  }

  return { capture, label: null, divergent: true, votes };
}

// ============================================================================
// Main
// ============================================================================

const isDryRun = process.argv.includes("--dry-run");

console.log(`\n=== Router Disposition Golden Labeler ===`);
console.log(`Captures: ${CAPTURES.length}`);
console.log(`Levels: ${LEVELS.join(", ")} (${CAPTURES.length * LEVELS.length} total inference calls)`);
console.log(`Output: ${OUTPUT_PATH}`);
console.log(`Mode: ${isDryRun ? "DRY-RUN (no LLM calls)" : "LIVE"}\n`);

if (isDryRun) {
  console.log("Captures (dry-run):");
  CAPTURES.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
  process.exit(0);
}

// Run labeling
const lines: string[] = [];
let consensusCount = 0;
let divergentCount = 0;
const distributionMap: Record<string, number> = {};
const labeledAt = new Date().toISOString();

console.log("Labeling captures...\n");

for (let i = 0; i < CAPTURES.length; i++) {
  const capture = CAPTURES[i];
  process.stdout.write(`[${i + 1}/${CAPTURES.length}] ${capture.slice(0, 60)}${capture.length > 60 ? "…" : ""} `);

  try {
    const result = await ensembleLabel(capture);

    if (result.divergent) {
      divergentCount++;
      process.stdout.write(`→ DIVERGENT (votes: ${JSON.stringify(result.votes)})\n`);
      lines.push(JSON.stringify({
        capture,
        disposition: null,
        divergent: true,
        votes: result.votes,
        source: "ensemble",
        labeled_at: labeledAt,
        criteria_version: CRITERIA_VERSION,
      }));
    } else {
      consensusCount++;
      const disposition = result.label!;
      distributionMap[disposition] = (distributionMap[disposition] ?? 0) + 1;
      process.stdout.write(`→ ${disposition}\n`);
      lines.push(JSON.stringify({
        capture,
        disposition,
        source: "ensemble",
        labeled_at: labeledAt,
        criteria_version: CRITERIA_VERSION,
      }));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    divergentCount++;
    process.stdout.write(`→ ERROR: ${msg}\n`);
    lines.push(JSON.stringify({
      capture,
      disposition: null,
      divergent: true,
      error: msg,
      source: "ensemble",
      labeled_at: labeledAt,
      criteria_version: CRITERIA_VERSION,
    }));
  }
}

// Write output
const outputDir = dirname(OUTPUT_PATH);
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}
writeFileSync(OUTPUT_PATH, lines.join("\n") + "\n", "utf-8");

// Report
console.log(`\n=== Results ===`);
console.log(`Total:      ${CAPTURES.length}`);
console.log(`Consensus:  ${consensusCount}`);
console.log(`Divergent:  ${divergentCount}`);
console.log(`\nPer-disposition distribution (consensus cases):`);
for (const [disp, count] of Object.entries(distributionMap).sort()) {
  console.log(`  ${disp.padEnd(16)} ${count}`);
}
console.log(`\nGolden set written to: ${OUTPUT_PATH}`);
