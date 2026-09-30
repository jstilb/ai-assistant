#!/usr/bin/env bun
/**
 * SessionHarvester - Extract learnings from Claude Code session transcripts
 *
 * Harvests insights from ~/.claude/projects/ sessions and writes to LEARNING/
 *
 * Commands:
 *   --recent N     Harvest from N most recent sessions (default: 10)
 *   --all          Harvest from all sessions modified in last 7 days
 *   --session ID   Harvest from specific session UUID
 *   --dry-run      Show what would be harvested without writing
 *
 * Examples:
 *   bun run SessionHarvester.ts --recent 5
 *   bun run SessionHarvester.ts --session abc-123
 *   bun run SessionHarvester.ts --all --dry-run
 *
 * LEARNING JUDGMENT (S8, let-the-model-speak — REMOVED 2026-07):
 * This tool used to decide "is this a learning, and SYSTEM or ALGORITHM?"
 * via three regex pattern lists (CORRECTION_PATTERNS/ERROR_PATTERNS/
 * INSIGHT_PATTERNS) matched line-by-line against the transcript, plus
 * hooks/lib/learning-utils.ts's isLearningCapture()/getLearningCategory()
 * (both deleted in S8 — see lib/core/LearningJudgment.ts's docblock for why).
 * That per-line regex scan is gone. This is a manually-invoked batch CLI
 * (not a per-turn/per-session hook, per LearningJudgment.ts's "(b)"), so it
 * makes its OWN inference call per session — one Sonnet call over the
 * session's concatenated readable turns, using the SAME
 * LEARNING_JUDGMENT_CRITERIA + LearningItemSchema as
 * hooks/SessionRatingCapture.hook.ts — rather than consuming that hook's
 * output, because this tool's job is retroactively mining ARBITRARY past
 * sessions under ~/.claude/projects/ (including ones from before S8, or
 * ones SessionRatingCapture never ran against), not re-processing sessions
 * that already went through the live hook path. See docs/decisions/015.
 */

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import { inference } from "./Inference.ts";
import { LEARNING_JUDGMENT_CRITERIA, parseLearningsArray, type LearningItem } from "./LearningJudgment.ts";
import { prepareOutputPath } from "./OutputPathResolver";
import { getKayaHome } from "./KayaHome.ts";

// ============================================================================
// Configuration
// ============================================================================

// frozen at import (getKayaHome cached); no test re-pins this module
const CLAUDE_DIR = getKayaHome();
const USERNAME = process.env.USER || require("os").userInfo().username;
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects", `-Users-${USERNAME}--claude`);
const LEARNING_DIR = path.join(CLAUDE_DIR, "MEMORY", "LEARNING");

/** Minimum non-whitespace turns before a session is worth an inference call. */
const MIN_TURNS = 1;
/** Cap on the concatenated transcript excerpt sent to inference (chars). */
const TRANSCRIPT_CAP = 8000;

const HARVEST_SYSTEM_PROMPT = `You are retroactively reviewing a past Kaya (AI assistant) session transcript for Jm, looking for genuine learning moments worth recording for later reference.

Produce a JSON object with exactly this field:
  "learnings" - array (use [] if there are none — do not force one), each item: {"summary": string, "category": "SYSTEM"|"ALGORITHM", "evidence": string}

${LEARNING_JUDGMENT_CRITERIA}

Return ONLY valid JSON — no prose, no markdown fences.`;

// ============================================================================
// Types
// ============================================================================

interface ProjectsEntry {
  sessionId?: string;
  type?: "user" | "assistant" | "summary";
  message?: {
    role?: string;
    content?: string | Array<{
      type: string;
      text?: string;
      name?: string;
      input?: any;
    }>;
  };
  timestamp?: string;
}

interface HarvestedLearning {
  sessionId: string;
  timestamp: string;
  category: LearningItem["category"];
  summary: string;
  evidence: string;
}

// ============================================================================
// Session File Discovery
// ============================================================================

function getSessionFiles(options: { recent?: number; all?: boolean; sessionId?: string }): string[] {
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error(`Projects directory not found: ${PROJECTS_DIR}`);
    return [];
  }

  const files = fs.readdirSync(PROJECTS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({
      name: f,
      path: path.join(PROJECTS_DIR, f),
      mtime: fs.statSync(path.join(PROJECTS_DIR, f)).mtime.getTime()
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (options.sessionId) {
    const match = files.find(f => f.name.includes(options.sessionId!));
    return match ? [match.path] : [];
  }

  if (options.all) {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return files.filter(f => f.mtime > sevenDaysAgo).map(f => f.path);
  }

  const limit = options.recent || 10;
  return files.slice(0, limit).map(f => f.path);
}

// ============================================================================
// Content Extraction
// ============================================================================

function extractTextContent(content: string | Array<any>): string {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text)
      .join('\n');
  }

  return '';
}

// ============================================================================
// Learning Extraction
// ============================================================================

/**
 * Read one session transcript, concatenate its readable user/assistant turns
 * (capped, most-recent-last like hooks/SessionRatingCapture.hook.ts's
 * buildUserPrompt), and make ONE inference call asking the model to judge
 * genuine learning moments — no regex pre-filtering of which lines "count".
 */
async function harvestLearnings(sessionPath: string): Promise<HarvestedLearning[]> {
  const sessionId = path.basename(sessionPath, '.jsonl');
  const content = fs.readFileSync(sessionPath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());

  const turns: string[] = [];
  let lastTimestamp = new Date().toISOString();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as ProjectsEntry;
      if (!entry.message?.content) continue;

      const textContent = extractTextContent(entry.message.content);
      if (!textContent || textContent.length < 20) continue;

      const role = entry.type === 'user' ? 'User' : entry.type === 'assistant' ? 'Assistant' : null;
      if (!role) continue;

      if (entry.timestamp) lastTimestamp = entry.timestamp;
      turns.push(`${role}: ${textContent.slice(0, 1000)}`);
    } catch {
      // Skip malformed lines
    }
  }

  if (turns.length < MIN_TURNS) return [];

  const body = turns.join('\n\n');
  const transcriptExcerpt = body.length > TRANSCRIPT_CAP ? body.slice(-TRANSCRIPT_CAP) : body;

  const result = await inference({
    systemPrompt: HARVEST_SYSTEM_PROMPT,
    userPrompt: `Review this past Kaya session transcript excerpt and extract any learnings:\n\n${transcriptExcerpt}`,
    level: "standard",
    expectJson: true,
    timeout: 45000,
  });

  if (!result.success || !result.parsed) {
    console.error(`  ⚠️  ${sessionId.slice(0, 8)}: inference failed, skipping — ${result.error ?? "no output"}`);
    return [];
  }

  const learnings = parseLearningsArray((result.parsed as { learnings?: unknown }).learnings);

  return learnings.map(item => ({
    sessionId,
    timestamp: lastTimestamp,
    category: item.category,
    summary: item.summary,
    evidence: item.evidence,
  }));
}

// ============================================================================
// Learning File Generation
// ============================================================================

function formatLearningFile(learning: HarvestedLearning): string {
  return `# Learning

**Session:** ${learning.sessionId}
**Timestamp:** ${learning.timestamp}
**Category:** ${learning.category}

---

## Summary

${learning.summary}

## Evidence

${learning.evidence}

---

*Harvested by SessionHarvester from projects/ transcript*
`;
}

async function writeLearning(learning: HarvestedLearning): Promise<string> {
  const sessionShort = learning.sessionId.slice(0, 8);

  const { path: filepath } = await prepareOutputPath({
    skill: `LEARNING/${learning.category}`,
    title: `learning-${sessionShort}`,
    extension: 'md',
    includeTimestamp: true,
  });

  // Skip if file already exists
  if (fs.existsSync(filepath)) {
    return filepath + ' (skipped - exists)';
  }

  const content = formatLearningFile(learning);
  fs.writeFileSync(filepath, content);

  return filepath;
}

// ============================================================================
// CLI
// ============================================================================

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    recent: { type: "string" },
    all: { type: "boolean" },
    session: { type: "string" },
    "dry-run": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`
SessionHarvester - Extract learnings from Claude Code session transcripts

Usage:
  bun run SessionHarvester.ts --recent 10    Harvest from 10 most recent sessions
  bun run SessionHarvester.ts --all          Harvest from all sessions (7 days)
  bun run SessionHarvester.ts --session ID   Harvest from specific session
  bun run SessionHarvester.ts --dry-run      Preview without writing files

Output: Creates learning files in MEMORY/LEARNING/{ALGORITHM|SYSTEM}/YYYY-MM/

Each session review makes one LLM inference call (S8, let-the-model-speak) —
this is a manually-invoked batch tool, not a hot-path hook, so it isn't cheap
to run over large --all windows.
`);
  process.exit(0);
}

// Get sessions to process
const sessionFiles = getSessionFiles({
  recent: values.recent ? parseInt(values.recent) : undefined,
  all: values.all,
  sessionId: values.session
});

if (sessionFiles.length === 0) {
  console.log("No sessions found to harvest");
  process.exit(0);
}

console.log(`🔍 Scanning ${sessionFiles.length} session(s)...`);

// Harvest learnings from each session (one inference call per session)
let totalLearnings = 0;
const allLearnings: HarvestedLearning[] = [];

for (const sessionFile of sessionFiles) {
  const sessionName = path.basename(sessionFile, '.jsonl').slice(0, 8);
  const learnings = await harvestLearnings(sessionFile);

  if (learnings.length > 0) {
    console.log(`  📂 ${sessionName}: ${learnings.length} learning(s)`);
    allLearnings.push(...learnings);
    totalLearnings += learnings.length;
  }
}

if (totalLearnings === 0) {
  console.log("✅ No new learnings found");
  process.exit(0);
}

console.log(`\n📊 Found ${totalLearnings} learning(s)`);
console.log(`   - SYSTEM: ${allLearnings.filter(l => l.category === 'SYSTEM').length}`);
console.log(`   - ALGORITHM: ${allLearnings.filter(l => l.category === 'ALGORITHM').length}`);

if (values["dry-run"]) {
  console.log("\n🔍 DRY RUN - Would write:");
  for (const learning of allLearnings) {
    const sessionShort = learning.sessionId.slice(0, 8);
    console.log(`   ${learning.category}/learning-${sessionShort}.md`);
  }
} else {
  console.log("\n✍️  Writing learning files...");
  for (const learning of allLearnings) {
    const result = await writeLearning(learning);
    console.log(`   ✅ ${path.basename(result)}`);
  }
  console.log(`\n✅ Harvested ${totalLearnings} learning(s) to MEMORY/LEARNING/`);
}
