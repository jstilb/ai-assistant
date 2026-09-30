#!/usr/bin/env bun
/**
 * AutoMemoryConsolidator.ts — Context Integrity Program, Slice E2.
 *
 * Finds oversized files in the auto-memory store (~/.kaya/memory — see
 * getAutoMemoryDir() in KayaHome.ts; a DIFFERENT store from the repo's
 * MEMORY/ tree, which lib/core/MemoryPaths.ts and lib/core/MemoryCleanup.ts
 * own) and restructures them by SPLITTING — never by re-summarizing.
 *
 * WHY SPLIT, NOT SUMMARIZE: iterative re-summarization is the documented
 * failure mode this program exists to close (a real case distorted "I like
 * mild spicy food" into "loves very spicy food" over successive passes).
 * So this tool never asks an LLM to rewrite a memory's prose. The LLM's
 * only job is judgment that never touches content bytes: deciding which
 * existing `###`-delimited sections belong together in a new file, and
 * writing a short frontmatter `description` for each new file. The actual
 * entry text is always copied byte-for-byte from the source file — the LLM
 * is never even shown a channel through which its output could become the
 * new file's body text (see requestSplitPlan(): the response schema has no
 * field for entry content, only block INDICES).
 *
 * HARD INVARIANTS (enforced by code in this file, not by LLM judgment):
 *   1. Every dated entry survives (verifySplitPreservesContent()).
 *   2. No cross-file merge of conflicting conclusions — out of scope for a
 *      pure splitter (it only ever moves entries to new homes, it never
 *      combines two SOURCE files' conclusions into one). The LLM is still
 *      asked to flag any contradiction it notices between entries as
 *      `conflictNotes` (advisory, surfaced in the result, never blocking —
 *      see SplitPlanSchema) since splitting can't introduce a false merge.
 *   3. Every NEEDS JM marker survives verbatim (verifySplitPreservesContent()).
 *   4. Split, don't re-narrate — see WHY SPLIT above.
 *   5. Frontmatter contract (name/description/metadata.type) preserved on
 *      every output file (buildOutputFrontmatter()).
 *   6. MEMORY.md (the index) is updated in the same commit (updateMemoryIndex()).
 *
 * SAFETY NET: every real (non-dry-run) run commits ~/.kaya/memory (a private
 * git repo with zero remotes and a refusing pre-push hook — Context
 * Integrity slice E1) before touching anything, and again after a
 * successful rewrite. A post-write verification re-reads every file from
 * DISK (not the in-memory strings this process just wrote) and re-checks
 * every invariant; on any failure the run discards its changes via
 * `git checkout -- .` and throws — nothing lossy is ever committed.
 *
 * CLI:
 *   bun AutoMemoryConsolidator.ts scan [--threshold <bytes>] [--json]
 *   bun AutoMemoryConsolidator.ts run --file <name.md> [--threshold <bytes>] [--dry-run] [--json]
 *   bun AutoMemoryConsolidator.ts run --all [--threshold <bytes>] [--dry-run] [--json]
 */

import { parseArgs } from "util";
import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "fs";
import { join } from "path";
import * as YAML from "yaml";
import { z } from "zod";
import {
  inference as defaultInference,
  extractJson,
  type InferenceLevel,
  type InferenceOptions,
  type InferenceResult,
} from "./Inference.ts";
import { getAutoMemoryDir, assertNotLiveAutoMemoryDirUnderTest } from "./KayaHome.ts";

// ============================================================================
// Threshold
// ============================================================================

/**
 * 20,000 bytes (~20KB).
 *
 * Reasoning (computed 2026-07-29 over the live 121-file top-level corpus at
 * ~/.kaya/memory): median file size is 3.6KB, p75 6.6KB, p90 10.7KB,
 * p95 20.4KB, max 40.4KB (`project_spec_pipeline_gotchas.md`). A file at
 * 20KB is ~5.5x the median and sits right at the p95 boundary — it flags
 * exactly the small cluster of genuine outliers (8 files, all clearly
 * "running logs" rather than "one fact") while leaving the other 113 files
 * untouched, including MEMORY.md itself (17.8KB — never a split candidate,
 * see INDEX_FILENAME below; it's the index, not a memory entry). A lower
 * threshold (10-15KB) would start flagging p90-range files that are still a
 * single coherent topic and would just get needlessly fragmented; a higher
 * one (30KB+) would leave files most in need of restructuring un-flagged.
 */
export const DEFAULT_THRESHOLD_BYTES = 20_000;

/** Never a split candidate — the index itself, not a memory entry. */
export const INDEX_FILENAME = "MEMORY.md";

const BLOCK_SEPARATOR = "\n\n---\n\n";
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;
const DATE_RE = /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g;
/** Case-sensitive by design: the corpus convention is the ALL-CAPS marker
 *  "NEEDS JM" / "NEEDS-JM" (often bolded/struck-through around it). Title-case
 *  "Needs Jm" / "Needs-Jm" appears throughout this corpus as ordinary prose —
 *  the LucidTasks project literally named "Kaya — Needs Jm" — and must NOT be
 *  flagged as a commitment marker. */
const NEEDS_JM_RE = /NEEDS[- ]JM/g;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

// ============================================================================
// Types
// ============================================================================

export interface MemoryBlock {
  /** 0-based position among this file's blocks, in original file order. */
  index: number;
  /** Exact original text of this block (leading/trailing blank lines trimmed). */
  raw: string;
  /** First markdown heading line inside the block (## or ###), or null. */
  headingTitle: string | null;
  /** True if the block contains at least one YYYY-MM-DD date. */
  hasDate: boolean;
  /** Every YYYY-MM-DD date string found in this block (may repeat). */
  dates: string[];
  /** Every literal NEEDS JM marker occurrence found in this block. */
  needsJmMarkers: string[];
  /** Every [[wikilink]] target found in this block. */
  wikilinks: string[];
}

export interface MemoryFrontmatter {
  name: string;
  description: string;
  metadata: Record<string, unknown>;
}

export interface ParsedMemoryFile {
  frontmatter: MemoryFrontmatter;
  blocks: MemoryBlock[];
}

const MemoryFrontmatterSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    metadata: z
      .object({
        node_type: z.string().optional(),
        type: z.string().optional(),
        originSessionId: z.string().optional(),
        modified: z.string().optional(),
      })
      .catchall(z.unknown())
      .default({}),
  })
  .passthrough();

// ============================================================================
// Parsing (deterministic — no LLM involvement)
// ============================================================================

function extractBlockMeta(raw: string, index: number): MemoryBlock {
  const headingMatch = /^#{2,3}\s+(.+)$/m.exec(raw);
  const dates = [...raw.matchAll(DATE_RE)].map((m) => m[0]);
  const needsJmMarkers = [...raw.matchAll(NEEDS_JM_RE)].map((m) => m[0]);
  const wikilinks = [...raw.matchAll(WIKILINK_RE)].map((m) => m[1]);
  return {
    index,
    raw,
    headingTitle: headingMatch ? headingMatch[1].trim() : null,
    hasDate: dates.length > 0,
    dates,
    needsJmMarkers,
    wikilinks,
  };
}

/**
 * Parse a raw memory-file string into frontmatter + ordered content blocks.
 * Throws loudly (never returns a partial/best-effort parse) if the file
 * doesn't match the established `---\n<yaml>\n---\n<body>` shape — callers
 * treat a parse failure as "cannot safely restructure this file," not as
 * license to guess.
 */
export function parseMemoryFile(raw: string, sourceLabel: string): ParsedMemoryFile {
  const fmMatch = FRONTMATTER_RE.exec(raw);
  if (!fmMatch) {
    throw new Error(
      `${sourceLabel}: no YAML frontmatter found (expected a leading "---\\n...\\n---\\n" block) — refusing to parse.`,
    );
  }

  let fmParsed: unknown;
  try {
    fmParsed = YAML.parse(fmMatch[1]);
  } catch (err) {
    throw new Error(
      `${sourceLabel}: frontmatter YAML failed to parse: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const fmResult = MemoryFrontmatterSchema.safeParse(fmParsed);
  if (!fmResult.success) {
    const issues = fmResult.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`${sourceLabel}: frontmatter failed schema validation: ${issues}`);
  }

  const body = raw.slice(fmMatch[0].length);
  const rawBlocks = body
    .split(BLOCK_SEPARATOR)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const blocks = rawBlocks.map((b, i) => extractBlockMeta(b, i));

  return { frontmatter: fmResult.data, blocks };
}

/** Serialize frontmatter + blocks back into the on-disk file format. */
export function renderMemoryFile(frontmatter: MemoryFrontmatter, blocks: MemoryBlock[]): string {
  const fmYaml = YAML.stringify(
    { name: frontmatter.name, description: frontmatter.description, metadata: frontmatter.metadata },
    { lineWidth: 0 },
  );
  const body = blocks.map((b) => b.raw.trim()).join(BLOCK_SEPARATOR);
  return `---\n${fmYaml}---\n\n${body}\n`;
}

// ============================================================================
// Whole-file invariant extraction (independent of block parsing — see
// verifySplitPreservesContent()'s doc comment for why this is a genuinely
// separate check, not a restatement of the block-level one).
// ============================================================================

function bodyOnly(raw: string): string {
  const fmMatch = FRONTMATTER_RE.exec(raw);
  return fmMatch ? raw.slice(fmMatch[0].length) : raw;
}

function extractDates(raw: string): string[] {
  return [...bodyOnly(raw).matchAll(DATE_RE)].map((m) => m[0]).sort();
}

function extractNeedsJmMarkers(raw: string): string[] {
  return [...bodyOnly(raw).matchAll(NEEDS_JM_RE)].map((m) => m[0]).sort();
}

function extractWikilinks(raw: string): string[] {
  return [...bodyOnly(raw).matchAll(WIKILINK_RE)].map((m) => m[1]).sort();
}

// ============================================================================
// LLM split plan (judgment-only: grouping + descriptions, never content)
// ============================================================================

const SplitFilePlanSchema = z.object({
  /** New filename. Must follow the corpus convention: lowercase word_words.md */
  filename: z.string().regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)+\.md$/, "expected lowercase snake_case name.md"),
  /** Short frontmatter description for this new file (metadata only, not content). */
  description: z.string().min(1).max(600),
  /** Which ORIGINAL block indices (0-based) go into this new file. */
  blockIndices: z.array(z.number().int().nonnegative()).min(1),
});

const SplitPlanSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("split"),
    files: z.array(SplitFilePlanSchema).min(2),
    /** Advisory only — see invariant #2 in the file header comment. */
    conflictNotes: z.array(z.string()).default([]),
  }),
  z.object({
    action: z.literal("flag_for_human"),
    reason: z.string().min(1),
  }),
]);

export type SplitPlan = z.infer<typeof SplitPlanSchema>;

const SPLIT_PLAN_SYSTEM_PROMPT = `You are helping restructure an oversized personal-memory file by SPLITTING it into multiple smaller files. You are NOT rewriting, summarizing, or narrating any content — you never see the entry text itself, only short previews, and your response contains no entry content at all: only which existing section INDICES belong together in each new file, plus a short frontmatter description per new file.

Rules:
- Every original section index must end up in exactly one new file. Do not drop any, do not duplicate any.
- Group by topical coherence (a human re-reading one new file later should find its sections belong together), not by size alone.
- Propose at least 2 new files (that's why you were called — the source is oversized).
- Each new filename must be lowercase snake_case ending in .md, and must not collide with any existing filename listed below.
- If, after reviewing the section previews, you believe this file should NOT be auto-split (e.g. sections are too tightly interdependent to separate without losing context, or you can't find a coherent grouping), respond with action "flag_for_human" and a reason instead of forcing a bad split.
- If you notice what looks like two sections stating genuinely CONTRADICTORY conclusions, note it in conflictNotes — this is informational only (splitting never merges anything, so it doesn't block the split), it just tells the human something may need reconciling.
- Respond with JSON only, matching this shape exactly:
  {"action":"split","files":[{"filename":"...","description":"...","blockIndices":[0,2,5]}, ...],"conflictNotes":[]}
  or
  {"action":"flag_for_human","reason":"..."}`;

function buildSplitPlanUserPrompt(
  originalFilename: string,
  frontmatter: MemoryFrontmatter,
  blocks: MemoryBlock[],
  existingFilenames: string[],
): string {
  const sections = blocks
    .map((b) => {
      const preview = b.raw.replace(/\s+/g, " ").slice(0, 300);
      return [
        `index: ${b.index}`,
        `heading: ${b.headingTitle ?? "(none)"}`,
        `hasDate: ${b.hasDate}${b.dates.length ? ` (${[...new Set(b.dates)].join(", ")})` : ""}`,
        `bytes: ${b.raw.length}`,
        b.wikilinks.length ? `wikilinks: ${[...new Set(b.wikilinks)].join(", ")}` : null,
        b.needsJmMarkers.length ? `needsJmMarkers: ${b.needsJmMarkers.length}` : null,
        `preview: ${preview}${b.raw.length > 300 ? "…" : ""}`,
      ]
        .filter((line): line is string => line !== null)
        .join("\n  ");
    })
    .join("\n\n");

  return `Source file: ${originalFilename}
Source frontmatter description: ${frontmatter.description}
Existing filenames in this directory (new filenames must not collide, case-insensitive): ${existingFilenames.join(", ")}

Sections (${blocks.length} total, 0-indexed, in original order):

${sections}`;
}

export type InferenceFn = (options: InferenceOptions) => Promise<InferenceResult>;

/**
 * Ask the LLM for a split plan. Validates the response against SplitPlanSchema
 * plus the business rules zod can't express (full index coverage, no dupes,
 * no filename collisions). Retries once on ANY validation failure by
 * re-prompting with the specific error; a second failure is a loud throw —
 * this never falls back to a silent default grouping.
 */
export async function requestSplitPlan(params: {
  originalFilename: string;
  frontmatter: MemoryFrontmatter;
  blocks: MemoryBlock[];
  existingFilenames: string[];
  inferenceFn?: InferenceFn;
  level?: InferenceLevel;
}): Promise<SplitPlan> {
  const infer = params.inferenceFn ?? defaultInference;
  const level = params.level ?? "standard";
  const basePrompt = buildSplitPlanUserPrompt(
    params.originalFilename,
    params.frontmatter,
    params.blocks,
    params.existingFilenames,
  );

  let lastError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const userPrompt = lastError
      ? `${basePrompt}\n\nYour previous response was invalid: ${lastError}\nRespond again with a corrected JSON plan only.`
      : basePrompt;

    const result = await infer({
      systemPrompt: SPLIT_PLAN_SYSTEM_PROMPT,
      userPrompt,
      level,
      expectJson: true,
      retries: 1,
      retryDelayMs: 4000,
    });

    if (!result.success) {
      lastError = `inference failed: ${result.error ?? "unknown error"}`;
      continue;
    }

    const parsedRaw = result.parsed ?? extractJson(result.output);
    if (parsedRaw === undefined) {
      lastError = "response was not valid JSON";
      continue;
    }

    const validated = SplitPlanSchema.safeParse(parsedRaw);
    if (!validated.success) {
      lastError = validated.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      continue;
    }

    if (validated.data.action === "flag_for_human") {
      return validated.data;
    }

    const businessRuleError = validateSplitPlanBusinessRules(
      validated.data,
      params.blocks.length,
      params.existingFilenames,
    );
    if (businessRuleError) {
      lastError = businessRuleError;
      continue;
    }

    return validated.data;
  }

  throw new Error(
    `requestSplitPlan: LLM failed to produce a valid split plan for ${params.originalFilename} after 2 attempts. ` +
      `Last error: ${lastError}. Refusing to fall back to a guessed grouping — this is a hard failure, not a silent default.`,
  );
}

/** Business rules zod's schema can't express: full, non-overlapping index coverage + filename safety. */
function validateSplitPlanBusinessRules(
  plan: Extract<SplitPlan, { action: "split" }>,
  blockCount: number,
  existingFilenames: string[],
): string | null {
  const seen = new Map<number, string>();
  for (const f of plan.files) {
    for (const idx of f.blockIndices) {
      if (idx >= blockCount) {
        return `blockIndices contains ${idx} but source only has ${blockCount} blocks (0-${blockCount - 1})`;
      }
      if (seen.has(idx)) {
        return `block index ${idx} assigned to both "${seen.get(idx)}" and "${f.filename}" — every index must appear exactly once`;
      }
      seen.set(idx, f.filename);
    }
  }
  const missing: number[] = [];
  for (let i = 0; i < blockCount; i++) {
    if (!seen.has(i)) missing.push(i);
  }
  if (missing.length > 0) {
    return `block indices [${missing.join(", ")}] were not assigned to any file — every original section must be preserved`;
  }

  const existingLower = new Set(existingFilenames.map((f) => f.toLowerCase()));
  const newFilenames = new Set<string>();
  for (const f of plan.files) {
    const lower = f.filename.toLowerCase();
    if (existingLower.has(lower)) {
      return `filename "${f.filename}" collides with an existing file`;
    }
    if (newFilenames.has(lower)) {
      return `filename "${f.filename}" is used by more than one planned file`;
    }
    newFilenames.add(lower);
  }
  return null;
}

// ============================================================================
// Deterministic output construction
// ============================================================================

/** Build a new file's frontmatter, preserving the contract (name/description/metadata.type). */
export function buildOutputFrontmatter(
  filename: string,
  description: string,
  original: MemoryFrontmatter,
  splitFrom: string,
): MemoryFrontmatter {
  const name = filename.replace(/\.md$/, "");
  const metadata: Record<string, unknown> = {
    node_type: original.metadata.node_type ?? "memory",
    type: original.metadata.type ?? "project",
  };
  if (typeof original.metadata.originSessionId === "string") {
    metadata.originSessionId = original.metadata.originSessionId;
  }
  metadata.splitFrom = splitFrom;
  metadata.modified = new Date().toISOString();
  return { name, description, metadata };
}

export interface PlannedOutputFile {
  filename: string;
  raw: string;
  description: string;
}

export function buildOutputFiles(
  originalFilename: string,
  frontmatter: MemoryFrontmatter,
  blocks: MemoryBlock[],
  plan: Extract<SplitPlan, { action: "split" }>,
): PlannedOutputFile[] {
  return plan.files.map((f) => {
    const orderedBlocks = [...f.blockIndices].sort((a, b) => a - b).map((i) => blocks[i]);
    const fm = buildOutputFrontmatter(f.filename, f.description, frontmatter, originalFilename);
    return { filename: f.filename, raw: renderMemoryFile(fm, orderedBlocks), description: f.description };
  });
}

// ============================================================================
// Invariant verification guard
// ============================================================================

export interface DatedFindingSummary {
  index: number;
  headingTitle: string | null;
  dates: string[];
  file?: string;
}

export interface InvariantCheckResult {
  ok: boolean;
  errors: string[];
  datedFindingsBefore: DatedFindingSummary[];
  datedFindingsAfter: DatedFindingSummary[];
  needsJmMarkersBefore: string[];
  needsJmMarkersAfter: string[];
  wikilinksBefore: string[];
  wikilinksAfter: string[];
}

/**
 * The core safety guard. Two INDEPENDENT layers, both must pass:
 *
 *  Layer 1 (block-level, structural): every source block, by exact verbatim
 *  text, must appear in exactly one output file, and every output block must
 *  correspond to exactly one source block (no extras, no drops, no dupes).
 *  This is the strong proof that content was moved, never rewritten.
 *
 *  Layer 2 (whole-file regex, independent of the block parser): dates,
 *  NEEDS JM markers, and wikilinks are re-extracted directly from the raw
 *  source and the raw union of outputs, bypassing the block-splitting logic
 *  entirely. This exists so a bug in the block separator/parsing code
 *  (e.g. an off-by-one that silently truncates a block mid-marker) would
 *  still be caught — Layer 1 alone would trust whatever the parser produced.
 *
 * Any failure in either layer sets ok:false; callers must not write/commit
 * when ok is false.
 */
export function verifySplitPreservesContent(
  sourceRaw: string,
  sourceLabel: string,
  outputs: { filename: string; raw: string }[],
): InvariantCheckResult {
  const errors: string[] = [];

  const source = parseMemoryFile(sourceRaw, sourceLabel);
  const datedFindingsBefore: DatedFindingSummary[] = source.blocks
    .filter((b) => b.hasDate)
    .map((b) => ({ index: b.index, headingTitle: b.headingTitle, dates: [...new Set(b.dates)] }));

  // Layer 1: block-level exact-text accounting.
  const outputBlockTexts: { text: string; file: string }[] = [];
  for (const out of outputs) {
    let parsedOut: ParsedMemoryFile;
    try {
      parsedOut = parseMemoryFile(out.raw, out.filename);
    } catch (err) {
      errors.push(`output file ${out.filename} failed to parse: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const b of parsedOut.blocks) outputBlockTexts.push({ text: b.raw, file: out.filename });
  }

  if (outputBlockTexts.length !== source.blocks.length) {
    errors.push(
      `block count mismatch: source has ${source.blocks.length} blocks, outputs have ${outputBlockTexts.length} total`,
    );
  }

  const datedFindingsAfter: DatedFindingSummary[] = [];
  for (const srcBlock of source.blocks) {
    const matches = outputBlockTexts.filter((o) => o.text === srcBlock.raw);
    if (matches.length === 0) {
      errors.push(
        `source block ${srcBlock.index} (heading: ${srcBlock.headingTitle ?? "none"}) is MISSING from all outputs`,
      );
    } else if (matches.length > 1) {
      errors.push(
        `source block ${srcBlock.index} (heading: ${srcBlock.headingTitle ?? "none"}) appears in ${matches.length} outputs (duplicated): ${matches.map((m) => m.file).join(", ")}`,
      );
    }
    if (srcBlock.hasDate && matches.length >= 1) {
      datedFindingsAfter.push({
        index: srcBlock.index,
        headingTitle: srcBlock.headingTitle,
        dates: [...new Set(srcBlock.dates)],
        file: matches[0].file,
      });
    }
  }

  // Layer 2: whole-file regex accounting, independent of block parsing.
  const needsJmMarkersBefore = extractNeedsJmMarkers(sourceRaw);
  const needsJmMarkersAfter = outputs.flatMap((o) => extractNeedsJmMarkers(o.raw)).sort();
  if (JSON.stringify(needsJmMarkersBefore) !== JSON.stringify(needsJmMarkersAfter)) {
    errors.push(
      `NEEDS JM marker count/content mismatch: before=${JSON.stringify(needsJmMarkersBefore)} after=${JSON.stringify(needsJmMarkersAfter)}`,
    );
  }

  const datesBefore = extractDates(sourceRaw);
  const datesAfter = outputs.flatMap((o) => extractDates(o.raw)).sort();
  if (JSON.stringify(datesBefore) !== JSON.stringify(datesAfter)) {
    errors.push(`date occurrence mismatch: before has ${datesBefore.length}, after has ${datesAfter.length}`);
  }

  const wikilinksBefore = extractWikilinks(sourceRaw);
  const wikilinksAfter = outputs.flatMap((o) => extractWikilinks(o.raw)).sort();
  if (JSON.stringify(wikilinksBefore) !== JSON.stringify(wikilinksAfter)) {
    errors.push(`wikilink mismatch: before has ${wikilinksBefore.length}, after has ${wikilinksAfter.length}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    datedFindingsBefore,
    datedFindingsAfter,
    needsJmMarkersBefore,
    needsJmMarkersAfter,
    wikilinksBefore,
    wikilinksAfter,
  };
}

// ============================================================================
// MEMORY.md index update
// ============================================================================

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace the single index line linking to `oldFilename` with one line per
 * new file, in the same position. Throws (never silently no-ops) if no
 * matching line is found — a split that can't confirm the index was updated
 * must not be reported as successful.
 */
export function updateMemoryIndex(
  indexRaw: string,
  oldFilename: string,
  newEntries: { filename: string; description: string }[],
): string {
  const lines = indexRaw.split("\n");
  const linkRe = new RegExp(`\\]\\(${escapeRegExp(oldFilename)}\\)\\s*$`);
  const idx = lines.findIndex((l) => linkRe.test(l));
  if (idx === -1) {
    throw new Error(
      `MEMORY.md: no index line found linking to ${oldFilename} — refusing to update the index blind ` +
        `(a stale index is exactly the drift this program exists to close).`,
    );
  }
  const newLines = newEntries.map((e) => `- [${e.description}](${e.filename})`);
  lines.splice(idx, 1, ...newLines);
  return lines.join("\n");
}

// ============================================================================
// Git safety net (commit before + after every real rewrite)
// ============================================================================

export type GitFn = (args: string[], cwd: string) => string;

const defaultGit: GitFn = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 }).trim();

/** Commit any dirty state (so "before" always refers to a real, addressable commit), and return HEAD sha. */
function ensureCommitted(memoryDir: string, message: string, git: GitFn): string {
  const status = git(["status", "--porcelain"], memoryDir);
  if (status.trim().length > 0) {
    git(["add", "-A"], memoryDir);
    git(["commit", "-m", message], memoryDir);
  }
  return git(["rev-parse", "HEAD"], memoryDir);
}

// ============================================================================
// Write + verify + commit (or revert) — the actual disk/git mutation, factored
// out of consolidateFile() so the fail-loud/revert guard can be exercised
// directly with an adversarial `outputs` array in tests, independent of
// whether the plan/LLM layer upstream would ever actually produce one (it
// can't — validateSplitPlanBusinessRules() proves full index coverage before
// this function ever runs). This function is what "the tool" does with
// whatever outputs it's given; feeding it a deliberately lossy split is the
// direct way to prove the guard, the same way you'd unit-test any assertion
// by feeding it the failing case rather than trying to trick everything
// upstream of it into producing one.
// ============================================================================

export interface WriteAndVerifyResult {
  postCheck: InvariantCheckResult;
  beforeSha: string;
  afterSha: string;
}

/**
 * Write `outputs`, delete `filename`, update MEMORY.md, re-read everything
 * back from disk and re-verify. On any failure: `git checkout -- .` to
 * restore the pre-write tree exactly, delete any newly-created output files
 * checkout didn't touch, and re-throw — no commit happens. On success:
 * `git add -A && git commit`, returning before/after shas.
 */
export function writeAndVerifySplit(params: {
  memoryDir: string;
  filename: string;
  sourceRaw: string;
  outputs: PlannedOutputFile[];
  git: GitFn;
}): WriteAndVerifyResult {
  const { memoryDir, filename, sourceRaw, outputs, git } = params;
  const filePath = join(memoryDir, filename);

  if (!existsSync(join(memoryDir, ".git"))) {
    throw new Error(
      `writeAndVerifySplit: ${memoryDir} is not a git repository — Context Integrity slice E1 (the revert safety ` +
        `net) must exist before E2 may rewrite anything. Refusing to run without it.`,
    );
  }

  const beforeSha = ensureCommitted(memoryDir, `chore(auto-memory): checkpoint before splitting ${filename}`, git);

  const indexPath = join(memoryDir, INDEX_FILENAME);
  const indexRawBefore = readFileSync(indexPath, "utf-8");
  const indexRawAfter = updateMemoryIndex(
    indexRawBefore,
    filename,
    outputs.map((o) => ({ filename: o.filename, description: o.description })),
  );

  try {
    for (const out of outputs) writeFileSync(join(memoryDir, out.filename), out.raw, "utf-8");
    unlinkSync(filePath);
    writeFileSync(indexPath, indexRawAfter, "utf-8");

    // Post-write verification: re-read from DISK, not the in-memory strings
    // above — a genuine end-to-end check of what actually landed.
    const diskOutputs = outputs.map((o) => ({
      filename: o.filename,
      raw: readFileSync(join(memoryDir, o.filename), "utf-8"),
    }));
    const postCheck = verifySplitPreservesContent(sourceRaw, filename, diskOutputs);

    const indexOnDisk = readFileSync(indexPath, "utf-8");
    const indexErrors: string[] = [];
    if (indexOnDisk.includes(`(${filename})`)) {
      indexErrors.push(`MEMORY.md still references the old filename ${filename} after the split`);
    }
    for (const out of outputs) {
      if (!indexOnDisk.includes(`(${out.filename})`)) {
        indexErrors.push(`MEMORY.md does not reference new file ${out.filename}`);
      }
    }

    if (!postCheck.ok || indexErrors.length > 0) {
      throw new Error(
        `writeAndVerifySplit(${filename}): POST-WRITE invariant check FAILED — reverting, nothing will be ` +
          `committed.\n` +
          [...postCheck.errors, ...indexErrors].join("\n"),
      );
    }

    git(["add", "-A"], memoryDir);
    git(
      [
        "commit",
        "-m",
        `consolidate(auto-memory E2): split ${filename} into ${outputs.length} files\n\n` +
          outputs.map((o) => `- ${o.filename}: ${o.description}`).join("\n"),
      ],
      memoryDir,
    );
    const afterSha = git(["rev-parse", "HEAD"], memoryDir);

    return { postCheck, beforeSha, afterSha };
  } catch (err) {
    // FAIL LOUD, THEN REVERT — never commit a lossy rewrite.
    git(["checkout", "--", "."], memoryDir);
    // checkout doesn't remove files that didn't exist at beforeSha but do now
    // (new split files, if writeFileSync succeeded before the throw) — clean
    // those explicitly so the working tree matches beforeSha exactly.
    for (const out of outputs) {
      const p = join(memoryDir, out.filename);
      if (existsSync(p)) unlinkSync(p);
    }
    throw err;
  }
}

// ============================================================================
// Orchestration
// ============================================================================

export interface ConsolidateOptions {
  memoryDir?: string;
  thresholdBytes?: number;
  dryRun?: boolean;
  inferenceFn?: InferenceFn;
  level?: InferenceLevel;
  git?: GitFn;
}

export type ConsolidateAction =
  | "split"
  | "flag_for_human"
  | "skipped_under_threshold"
  | "skipped_unsplittable"
  | "skipped_no_frontmatter"
  | "skipped_not_found";

export interface ConsolidateResult {
  file: string;
  action: ConsolidateAction;
  reason?: string;
  dryRun: boolean;
  sizeBefore: number;
  newFiles?: string[];
  conflictNotes?: string[];
  beforeSha?: string;
  afterSha?: string;
  invariantCheck?: InvariantCheckResult;
}

/** List top-level `.md` files (excludes MEMORY.md and anything under archive/). */
export function listCandidateFiles(memoryDir: string): string[] {
  return readdirSync(memoryDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md") && d.name !== INDEX_FILENAME)
    .map((d) => d.name)
    .sort();
}

export interface OversizedFile {
  filename: string;
  sizeBytes: number;
}

export function findOversizedFiles(memoryDir: string, thresholdBytes: number): OversizedFile[] {
  return listCandidateFiles(memoryDir)
    .map((filename) => ({ filename, sizeBytes: statSync(join(memoryDir, filename)).size }))
    .filter((f) => f.sizeBytes > thresholdBytes)
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
}

/**
 * Consolidate a single oversized file. Safe to call on a file under
 * threshold (returns skipped_under_threshold, a pure no-op — no git activity).
 */
export async function consolidateFile(filename: string, opts: ConsolidateOptions = {}): Promise<ConsolidateResult> {
  const memoryDir = opts.memoryDir ?? getAutoMemoryDir();
  const thresholdBytes = opts.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
  const dryRun = opts.dryRun ?? false;
  const git = opts.git ?? defaultGit;

  const filePath = join(memoryDir, filename);
  if (filename === INDEX_FILENAME) {
    throw new Error(`consolidateFile: refusing to split ${INDEX_FILENAME} — it is the index, not a memory entry.`);
  }
  if (!existsSync(filePath)) {
    return { file: filename, action: "skipped_not_found", dryRun, sizeBefore: 0 };
  }

  const sizeBefore = statSync(filePath).size;
  if (sizeBefore <= thresholdBytes) {
    return { file: filename, action: "skipped_under_threshold", dryRun, sizeBefore };
  }

  const sourceRaw = readFileSync(filePath, "utf-8");

  let parsed: ParsedMemoryFile;
  try {
    parsed = parseMemoryFile(sourceRaw, filename);
  } catch (err) {
    return {
      file: filename,
      action: "skipped_no_frontmatter",
      reason: err instanceof Error ? err.message : String(err),
      dryRun,
      sizeBefore,
    };
  }

  if (parsed.blocks.length < 2) {
    return {
      file: filename,
      action: "skipped_unsplittable",
      reason: `file has only ${parsed.blocks.length} content block(s) — splitting would require re-narrating, not restructuring; needs manual review`,
      dryRun,
      sizeBefore,
    };
  }

  const existingFilenames = listCandidateFiles(memoryDir).filter((f) => f !== filename);
  const plan = await requestSplitPlan({
    originalFilename: filename,
    frontmatter: parsed.frontmatter,
    blocks: parsed.blocks,
    existingFilenames,
    inferenceFn: opts.inferenceFn,
    level: opts.level,
  });

  if (plan.action === "flag_for_human") {
    return { file: filename, action: "flag_for_human", reason: plan.reason, dryRun, sizeBefore };
  }

  const outputs = buildOutputFiles(filename, parsed.frontmatter, parsed.blocks, plan);

  // Pre-write in-memory check — never touch disk if this fails.
  const preCheck = verifySplitPreservesContent(
    sourceRaw,
    filename,
    outputs.map((o) => ({ filename: o.filename, raw: o.raw })),
  );
  if (!preCheck.ok) {
    throw new Error(
      `consolidateFile(${filename}): pre-write invariant check FAILED — refusing to write anything.\n` +
        preCheck.errors.join("\n"),
    );
  }

  if (dryRun) {
    return {
      file: filename,
      action: "split",
      dryRun: true,
      sizeBefore,
      newFiles: outputs.map((o) => o.filename),
      conflictNotes: plan.conflictNotes,
      invariantCheck: preCheck,
    };
  }

  assertNotLiveAutoMemoryDirUnderTest("AutoMemoryConsolidator.consolidateFile", memoryDir);

  const { postCheck, beforeSha, afterSha } = writeAndVerifySplit({
    memoryDir,
    filename,
    sourceRaw,
    outputs,
    git,
  });

  return {
    file: filename,
    action: "split",
    dryRun: false,
    sizeBefore,
    newFiles: outputs.map((o) => o.filename),
    conflictNotes: plan.conflictNotes,
    beforeSha,
    afterSha,
    invariantCheck: postCheck,
  };
}

/** Consolidate every file currently over threshold, sequentially (largest first). */
export async function consolidateAll(opts: ConsolidateOptions = {}): Promise<ConsolidateResult[]> {
  const memoryDir = opts.memoryDir ?? getAutoMemoryDir();
  const thresholdBytes = opts.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
  const oversized = findOversizedFiles(memoryDir, thresholdBytes);
  const results: ConsolidateResult[] = [];
  for (const { filename } of oversized) {
    results.push(await consolidateFile(filename, opts));
  }
  return results;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      file: { type: "string" },
      all: { type: "boolean" },
      threshold: { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  const command = positionals[0];

  if (values.help || !command) {
    console.log(`
AutoMemoryConsolidator — Context Integrity Program, Slice E2

Usage:
  bun AutoMemoryConsolidator.ts scan [--threshold <bytes>] [--json]
  bun AutoMemoryConsolidator.ts run --file <name.md> [--threshold <bytes>] [--dry-run] [--json]
  bun AutoMemoryConsolidator.ts run --all [--threshold <bytes>] [--dry-run] [--json]

Options:
  --threshold <bytes>  Override the default ${DEFAULT_THRESHOLD_BYTES}-byte oversized-file threshold
  --dry-run            Plan and verify, but never write to disk or git
  --json               Output results as JSON
`);
    return;
  }

  const thresholdBytes = values.threshold ? parseInt(values.threshold, 10) : DEFAULT_THRESHOLD_BYTES;
  const memoryDir = getAutoMemoryDir();

  if (command === "scan") {
    const oversized = findOversizedFiles(memoryDir, thresholdBytes);
    if (values.json) {
      console.log(JSON.stringify({ memoryDir, thresholdBytes, oversized }, null, 2));
    } else {
      console.log(`Auto-memory dir: ${memoryDir}`);
      console.log(`Threshold: ${thresholdBytes} bytes\n`);
      if (oversized.length === 0) {
        console.log("No oversized files.");
      } else {
        for (const f of oversized) console.log(`${f.sizeBytes.toString().padStart(8)}  ${f.filename}`);
      }
    }
    return;
  }

  if (command === "run") {
    const dryRun = values["dry-run"] ?? false;
    let results: ConsolidateResult[];
    if (values.all) {
      results = await consolidateAll({ memoryDir, thresholdBytes, dryRun });
    } else if (values.file) {
      results = [await consolidateFile(values.file, { memoryDir, thresholdBytes, dryRun })];
    } else {
      console.error("run requires --file <name.md> or --all");
      process.exit(1);
    }

    if (values.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const r of results) {
        console.log(`${r.file}: ${r.action}${r.reason ? ` — ${r.reason}` : ""}`);
        if (r.newFiles) console.log(`  -> ${r.newFiles.join(", ")}`);
        if (r.beforeSha) console.log(`  before: ${r.beforeSha}  after: ${r.afterSha}`);
      }
    }
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}
