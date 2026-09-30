#!/usr/bin/env bun
/**
 * label-clarity-golden.ts
 *
 * Builds the clarity-verdict golden set via REAL ensemble labeling.
 *
 * Sources:
 *   1. Real task captures from archived daily-runs JSON files (deduplicated by
 *      taskId; frozen 2026-06-18, now under MEMORY/AUTOINFO/_archive/)
 *   2. Synthetic cases drawn from the rubric to cover all 3 verdict classes
 *      and ensure the total reaches ≥30 entries.
 *
 * Writes one JSONL line per case to:
 *   skills/Intelligence/Evals/Data/golden/clarity-verdict-golden.jsonl
 *
 * Consensus cases  → { taskId, title, verdict: <label>, source, labeled_at, criteria_version }
 * Divergent cases  → { taskId, title, verdict: null, divergent: true, votes, source, labeled_at, criteria_version }
 *
 * Disposition→verdict mapping (from daily-runs logs):
 *   clear          → clear
 *   needs-grilling → needs-grill
 *   skip           → not-executable
 *
 * Usage:
 *   bun skills/Intelligence/Evals/scripts/label-clarity-golden.ts
 *   bun skills/Intelligence/Evals/scripts/label-clarity-golden.ts --dry-run   # print captures, no LLM calls
 *   bun skills/Intelligence/Evals/scripts/label-clarity-golden.ts --live      # explicit live mode alias
 */

import { inference } from "../../../../lib/core/Inference.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "fs";
import { join, dirname } from "path";

// ============================================================================
// Config
// ============================================================================

const CRITERIA_VERSION = 1;
const OUTPUT_PATH = join(import.meta.dir, "../Data/golden/clarity-verdict-golden.jsonl");
// Frozen old-tier history (last write 2026-06-18), archived 2026-07-05 — see
// MEMORY/AUTOINFO/_archive/README.md. Missing dir → synthetic-only fallback below.
const DAILY_RUNS_DIR = join(getKayaHome(), "MEMORY", "AUTOINFO", "_archive", "daily-runs");
const TOTAL_CAP = 30;

// ============================================================================
// Clarity-verdict rubric
// ============================================================================

const CLARITY_SYSTEM_PROMPT = `You are a clarity verdict classifier for an AI assistant pipeline.
Given a task title and optional routing reasoning, classify the clarity of the task
into exactly one of three verdicts. Return ONLY valid JSON with the key "verdict".

CLARITY VERDICT RUBRIC:
- clear: task is well-scoped, has a defined deliverable, and Kaya can execute it autonomously right now
- needs-grill: task is actionable in principle but underspecified — needs clarifying questions before it can be spec'd
- not-executable: task is not something Kaya can execute (personal action for Jm, vague idea, journaling, entertainment, etc.)

Examples:
  "research cooking courses in san diego" + reasoning about research skill → {"verdict": "clear"}
  "look into massage course (in person)" + reasoning about missing parameters → {"verdict": "needs-grill"}
  "Take Car in for Oil Change / Tires @ Sunset Garage" + reasoning about physical errand → {"verdict": "not-executable"}
  "text Jackson" + reasoning about personal communication → {"verdict": "not-executable"}
  "Buy tickets to Charleston / New York" + reasoning about credentials needed → {"verdict": "not-executable"}
  "Add local library events pages to EventScout skill" + reasoning about missing implementation details → {"verdict": "needs-grill"}
  "Add interactive voice mode to Anki skill" + reasoning about unspecified integration design → {"verdict": "needs-grill"}

Return: {"verdict": "clear" | "needs-grill" | "not-executable"}`;

const CANDIDATE_FIELD = "verdict";

const VALID_VERDICTS = new Set(["clear", "needs-grill", "not-executable"]);

// ============================================================================
// Task capture type
// ============================================================================

interface CaptureTask {
  taskId: string;
  title: string;
  disposition?: string; // only present for daily-run tasks
  reasoning?: string;
  source: "daily-run" | "synthetic";
}

interface DailyRunTask {
  taskId: string;
  title: string;
  disposition: string;
  confidence?: number;
  reasoning?: string;
}

interface DailyRunFile {
  runAt: string;
  mode: string;
  tasks: DailyRunTask[];
}

// ============================================================================
// Synthetic supplement cases
// These cover rubric edge cases and ensure all 3 verdict classes are present
// even when daily-runs don't have enough coverage.
// ============================================================================

const SYNTHETIC_CASES: Array<{ title: string; reasoning: string }> = [
  // --- clear ---
  {
    title: "write a bun script to batch rename files by date prefix",
    reasoning: "Well-scoped coding task — Kaya can implement and test this autonomously via the Development skill.",
  },
  {
    title: "research best standing desks under $500 with monitor arm compatibility",
    reasoning: "Clear research task with defined scope and budget constraint — Kaya's Research skill can execute this immediately.",
  },
  {
    title: "analyze my habit_log CSV and produce weekly consistency report",
    reasoning: "Kaya has direct access to habit_log and the analytics toolchain — well-defined deliverable.",
  },
  {
    title: "set up launchd cron to run the briefing skill every morning at 7am",
    reasoning: "Discrete system-configuration task with a clear target — Kaya's launchd skill handles this.",
  },
  {
    title: "find the best productivity apps for iOS in 2026",
    reasoning: "Well-scoped research task — Kaya can execute via web search and produce a ranked list immediately.",
  },
  // --- needs-grill ---
  {
    title: "improve the EventScout skill",
    reasoning: "EventScout is in-scope for Kaya but 'improve' is underspecified — which sources, which bugs, what outcome?",
  },
  {
    title: "look into building a voice journal feature",
    reasoning: "Building a feature is in-scope but the design, integration point, and acceptance criteria are all undefined.",
  },
  {
    title: "figure out a better morning routine",
    reasoning: "Kaya could research routines but Jm's specific goals, constraints, and current habits are unspecified.",
  },
  {
    title: "research group piano courses / lessons",
    reasoning: "Kaya can research piano courses but location, budget, skill level, and desired output are all unspecified.",
  },
  {
    title: "look into fashion/style course - can be in person or online",
    reasoning: "Kaya can research fashion/style courses but the goal, budget, format preference, and expected output are all unspecified.",
  },
  // --- not-executable ---
  {
    title: "call mom this weekend",
    reasoning: "Personal phone call — requires Jm's relationship, voice, and availability. Kaya cannot execute.",
  },
  {
    title: "go to the gym — leg day",
    reasoning: "Physical errand requiring Jm's presence. Not a software task.",
  },
  {
    title: "buy groceries at trader joe's",
    reasoning: "Physical errand — Kaya cannot physically buy groceries.",
  },
];

// ============================================================================
// Load daily-run captures (sync)
// ============================================================================

function loadDailyRunCaptures(): CaptureTask[] {
  if (!existsSync(DAILY_RUNS_DIR)) {
    console.warn(`[WARN] daily-runs directory not found: ${DAILY_RUNS_DIR} — using synthetic only`);
    return [];
  }

  const allFiles = readdirSync(DAILY_RUNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()    // chronological ascending
    .reverse(); // most recent first

  const seen = new Set<string>();
  const captures: CaptureTask[] = [];

  for (const file of allFiles) {
    if (captures.length >= TOTAL_CAP) break;

    const filePath = join(DAILY_RUNS_DIR, file);
    let data: DailyRunFile;
    try {
      const raw = readFileSync(filePath, "utf-8");
      data = JSON.parse(raw) as DailyRunFile;
    } catch {
      console.warn(`[WARN] Could not parse ${file}, skipping`);
      continue;
    }

    for (const task of data.tasks) {
      if (!task.taskId || !task.title) continue;
      if (seen.has(task.taskId)) continue;
      seen.add(task.taskId);
      captures.push({
        taskId: task.taskId,
        title: task.title,
        disposition: task.disposition,
        reasoning: task.reasoning,
        source: "daily-run",
      });
      if (captures.length >= TOTAL_CAP) break;
    }
  }

  return captures;
}

// ============================================================================
// Build final corpus: real captures + synthetic supplement up to TOTAL_CAP
// ============================================================================

function buildCorpus(): CaptureTask[] {
  const realCaptures = loadDailyRunCaptures();
  const corpus: CaptureTask[] = [...realCaptures];
  const needed = Math.max(0, TOTAL_CAP - corpus.length);

  // Add synthetic cases to fill to cap
  const syntheticBatch = SYNTHETIC_CASES.slice(0, needed);
  for (let i = 0; i < syntheticBatch.length; i++) {
    const s = syntheticBatch[i];
    corpus.push({
      taskId: `synthetic-${i + 1}`,
      title: s.title,
      reasoning: s.reasoning,
      source: "synthetic",
    });
  }

  return corpus;
}

// ============================================================================
// Ensemble labeler
// ============================================================================

type InferenceLevel = "fast" | "standard" | "smart";
const LEVELS: InferenceLevel[] = ["fast", "standard", "smart"];

interface EnsembleResult {
  taskId: string;
  title: string;
  label: string | null;
  divergent: boolean;
  votes: Record<string, number>;
}

async function ensembleLabel(task: CaptureTask): Promise<EnsembleResult> {
  // Compose user prompt: title + reasoning (if available)
  const userPrompt = task.reasoning
    ? `Task title: ${task.title}\n\nRouting reasoning: ${task.reasoning}`
    : `Task title: ${task.title}`;

  // Run all three levels in parallel
  const rawResults = await Promise.all(
    LEVELS.map((level) =>
      inference({
        systemPrompt: CLARITY_SYSTEM_PROMPT,
        userPrompt,
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
    const raw =
      result.success && result.parsed != null
        ? (result.parsed as Record<string, unknown>)[CANDIDATE_FIELD]
        : undefined;

    if (typeof raw === "string" && VALID_VERDICTS.has(raw)) {
      votes[raw] = (votes[raw] ?? 0) + 1;
      voterCount++;
    }
  }

  if (voterCount === 0) {
    return { taskId: task.taskId, title: task.title, label: null, divergent: true, votes };
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
    return { taskId: task.taskId, title: task.title, label: topLabel, divergent: false, votes };
  }

  return { taskId: task.taskId, title: task.title, label: null, divergent: true, votes };
}

// ============================================================================
// Main
// ============================================================================

const isDryRun = process.argv.includes("--dry-run");
const CORPUS = buildCorpus();

const realCount = CORPUS.filter((c) => c.source === "daily-run").length;
const syntheticCount = CORPUS.filter((c) => c.source === "synthetic").length;

console.log(`\n=== Clarity-Verdict Golden Labeler ===`);
console.log(`Total captures: ${CORPUS.length} (${realCount} real daily-run + ${syntheticCount} synthetic)`);
console.log(`Levels:         ${LEVELS.join(", ")} (${CORPUS.length * LEVELS.length} total inference calls)`);
console.log(`Output:         ${OUTPUT_PATH}`);
console.log(`Mode:           ${isDryRun ? "DRY-RUN (no LLM calls)" : "LIVE"}\n`);

if (isDryRun) {
  console.log("Corpus (dry-run):");
  CORPUS.forEach((t, i) =>
    console.log(
      `  ${i + 1}. [${(t.disposition ?? t.source).padEnd(15)}] ${t.title.slice(0, 65)}${t.title.length > 65 ? "…" : ""}`
    )
  );
  process.exit(0);
}

// Run labeling
const lines: string[] = [];
let consensusCount = 0;
let divergentCount = 0;
const distributionMap: Record<string, number> = {};
const labeledAt = new Date().toISOString();

console.log("Labeling captures...\n");

for (let i = 0; i < CORPUS.length; i++) {
  const task = CORPUS[i];
  const display = task.title.slice(0, 55);
  process.stdout.write(
    `[${i + 1}/${CORPUS.length}] ${display}${task.title.length > 55 ? "…" : ""} `
  );

  try {
    const result = await ensembleLabel(task);

    if (result.divergent) {
      divergentCount++;
      process.stdout.write(`→ DIVERGENT (votes: ${JSON.stringify(result.votes)})\n`);
      lines.push(
        JSON.stringify({
          taskId: task.taskId,
          title: task.title,
          verdict: null,
          divergent: true,
          votes: result.votes,
          source: "ensemble",
          capture_source: task.source,
          labeled_at: labeledAt,
          criteria_version: CRITERIA_VERSION,
        })
      );
    } else {
      consensusCount++;
      const verdict = result.label!;
      distributionMap[verdict] = (distributionMap[verdict] ?? 0) + 1;
      process.stdout.write(`→ ${verdict}\n`);
      lines.push(
        JSON.stringify({
          taskId: task.taskId,
          title: task.title,
          verdict,
          source: "ensemble",
          capture_source: task.source,
          labeled_at: labeledAt,
          criteria_version: CRITERIA_VERSION,
        })
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    divergentCount++;
    process.stdout.write(`→ ERROR: ${msg}\n`);
    lines.push(
      JSON.stringify({
        taskId: task.taskId,
        title: task.title,
        verdict: null,
        divergent: true,
        error: msg,
        source: "ensemble",
        capture_source: task.source,
        labeled_at: labeledAt,
        criteria_version: CRITERIA_VERSION,
      })
    );
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
console.log(`Total:      ${CORPUS.length}`);
console.log(`Consensus:  ${consensusCount}`);
console.log(`Divergent:  ${divergentCount}`);
console.log(`\nPer-verdict distribution (consensus cases):`);
for (const [verdict, count] of Object.entries(distributionMap).sort()) {
  console.log(`  ${verdict.padEnd(20)} ${count}`);
}
console.log(`\nGolden set written to: ${OUTPUT_PATH}`);
