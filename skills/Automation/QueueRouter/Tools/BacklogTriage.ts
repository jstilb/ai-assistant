#!/usr/bin/env bun
/**
 * BacklogTriage.ts — H1: backlog triage proposals (READ-ONLY analysis)
 *
 * Slice H1 of the pipeline overhaul. The spec pipeline has 74 needs-grilling
 * items (oldest ~51 days, all created via lucidtasks-llm-triage) sitting
 * un-actioned, plus 16 LucidTasks that are permanently invisible to
 * IntakeRunner because they carry a `kaya_triage` stamp written before the
 * `scope` field existed — the stamp hash still matches current content, so
 * `hasValidTriageStamp()` skips them forever even though the current
 * enqueue path (IntakeRunner.runEnqueuePhase) now visibly parks non-clear
 * verdicts instead of silently stamping them invisible.
 *
 * This tool produces LLM-judged triage PROPOSALS for both cohorts:
 *   verdict ∈ { kill, merge-duplicate, downgrade-to-executor, keep-for-grill }
 *
 * It does NOT execute anything — no writes to pipeline.db or lucidtasks.db.
 * Execution (clearing stamps, killing/merging/downgrading items) is H2, a
 * Jm-in-session checkpoint that consumes the JSON output this tool writes.
 *
 * Read-only architecture: every DB read goes through a `{ readonly: true }`
 * bun:sqlite connection (structurally cannot write — SQLite raises
 * "attempt to write a readonly database" on any mutation attempt). This is a
 * stronger guarantee than "we didn't call a write method" — it's enforced by
 * the database engine itself.
 *
 * Chunking follows KayaTaskClassifier's idiom exactly (CHUNK_SIZE=10,
 * per-chunk fault tolerance, throw only on total outage) — see
 * skills/Productivity/LucidTasks/Tools/KayaTaskClassifier.ts.
 *
 * @module BacklogTriage
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { inference } from "../../../../lib/core/Inference.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
// cross-skill-allowed: shared classification engine, deliberate reuse of KayaTaskClassifier's chunk() idiom
import { chunk } from "../../../Productivity/LucidTasks/Tools/KayaTaskClassifier.ts";
import { defaultPipelineDbPath } from "./PipelineDB.ts";

// ============================================================================
// Path resolution
// ============================================================================

/**
 * Mirrors TaskDB.ts's (unexported) defaultDbPath(): lucidtasks.db lives under
 * KAYA_HOME/skills/Productivity/LucidTasks/Data/lucidtasks.db. Resolved at
 * call time, not module load, so tests that repoint KAYA_HOME still work.
 */
export function defaultLucidDbPath(): string {
  const kayaHome = getKayaHome();
  return join(kayaHome, "skills/Productivity/LucidTasks/Data/lucidtasks.db");
}

function getKayaHomeForOutput(): string {
  return getKayaHome();
}

/** Default report output directory: <KAYA_HOME>/MEMORY/WORK */
export function defaultReportDir(): string {
  return join(getKayaHomeForOutput(), "MEMORY/WORK");
}

// ============================================================================
// Types
// ============================================================================

export type CandidateKind = "pipeline-item" | "stamped-task";

export interface TriageCandidate {
  id: string;
  kind: CandidateKind;
  title: string;
  description: string;
  createdAt: string;
  ageDays: number;
  /** For pipeline-item: the linked LucidTask id (nullable). For stamped-task: same as id. */
  lucidTaskId: string | null;
  linkedTaskStatus: string | null;
  linkedTaskDisposition: string | null;
  executorDelivered: boolean;
  executorEvidenceSnippet: string | null;
  approvedByJm: boolean;
  /** stamped-task only: the pre-scope-field kaya_triage verdict/confidence/reasoning already on file. */
  stampVerdict: string | null;
  stampConfidence: number | null;
  stampReasoning: string | null;
}

export const TriageVerdictEnum = z.enum([
  "kill",
  "merge-duplicate",
  "downgrade-to-executor",
  "keep-for-grill",
]);
export type TriageVerdict = z.infer<typeof TriageVerdictEnum>;

export const TriageProposalSchema = z
  .object({
    id: z.string(),
    verdict: TriageVerdictEnum,
    reasoning: z.string().min(1),
    /**
     * Required for merge-duplicate — the id (pipeline item or LucidTask) that
     * already covers this work. `.nullish()` (not `.optional()`) because the
     * LLM reliably emits an explicit `"survivor_id": null` for every other
     * verdict rather than omitting the key — `z.string().optional()` rejects
     * null and fails EVERY item, not just merge-duplicate ones (see
     * BacklogTriage.test.ts). The trailing transform normalizes null to
     * undefined so downstream code only ever sees `string | undefined`.
     */
    survivor_id: z
      .string()
      .nullish()
      .transform((v) => v ?? undefined),
  })
  .superRefine((val, ctx) => {
    if (val.verdict === "merge-duplicate" && !(val.survivor_id && val.survivor_id.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["survivor_id"],
        message: "merge-duplicate verdict requires a non-empty survivor_id",
      });
    }
  });
export type TriageProposal = z.infer<typeof TriageProposalSchema>;

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * Age in days from createdAt to now, rounded to 1 decimal place.
 * NEVER use updated_at for age — a 2026-06-29 bulk sweep touched updated_at
 * on all 74 needs-grilling rows, making it a false staleness signal (same
 * trap documented in GrillRunner.getGrillBacklogSummary).
 */
export function computeAgeDays(createdAt: string, now: Date = new Date()): number {
  const ms = now.getTime() - new Date(createdAt).getTime();
  return Math.round((ms / (1000 * 60 * 60 * 24)) * 10) / 10;
}

/** Cap candidates to the oldest `limit` (by createdAt ascending). Undefined limit = no cap. */
export function capCandidates(candidates: TriageCandidate[], limit?: number): TriageCandidate[] {
  if (typeof limit !== "number") return candidates;
  const sorted = [...candidates].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  return sorted.slice(0, Math.max(0, limit));
}

// ============================================================================
// Raw row types
// ============================================================================

interface PipelineItemRow {
  id: string;
  title: string;
  description: string;
  created_at: string;
  lucid_task_id: string | null;
}

interface StampedTaskRow {
  id: string;
  title: string;
  description: string;
  status: string;
  disposition: string | null;
  created_at: string;
  kaya_triage: string;
}

interface LinkedTaskEvidence {
  status: string | null;
  disposition: string | null;
  executorDelivered: boolean;
  executorEvidenceSnippet: string | null;
  approvedByJm: boolean;
}

// ============================================================================
// Read-only DB access
// ============================================================================

/**
 * Open a connection that structurally cannot write.
 *
 * Uses a normal open + `PRAGMA query_only = ON` rather than SQLite's
 * OS-level `{ readonly: true }` (SQLITE_OPEN_READONLY). Some sandboxed
 * shells tag externally-created files (e.g. a `sqlite3 .backup` clone or a
 * `cp` copy) with a `com.apple.provenance` xattr that makes
 * SQLITE_OPEN_READONLY raise SQLITE_CANTOPEN — and critically, that failure
 * surfaces lazily on the FIRST QUERY, not at construction time, so a
 * try/catch around `new Database(path, { readonly: true })` cannot recover
 * from it. `PRAGMA query_only` enforces the identical guarantee at the SQL
 * layer instead: any write statement raises "attempt to write a readonly
 * database" regardless of file provenance — verified in BacklogTriage.test.ts
 * against both bun-native and externally-`cp`-copied fixture files.
 */
function openReadonly(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA query_only = ON;");
  return db;
}

/**
 * All pipeline_items rows with stage='needs-grilling', oldest first.
 * Read-only — opens a { readonly: true } connection, closes it before returning.
 */
export function loadNeedsGrillingItems(pipelineDbPath: string): PipelineItemRow[] {
  if (!existsSync(pipelineDbPath)) return [];
  const db = openReadonly(pipelineDbPath);
  try {
    return db
      .query(
        `SELECT id, title, description, created_at, lucid_task_id
         FROM pipeline_items
         WHERE stage = 'needs-grilling'
         ORDER BY created_at ASC`
      )
      .all() as PipelineItemRow[];
  } finally {
    db.close();
  }
}

/**
 * The permanently-invisible cohort: LucidTasks with disposition='autonomous',
 * no queue_item_id (never graduated to the pipeline), a kaya_triage stamp
 * that predates the `scope` field (json_extract(...,'$.scope') IS NULL —
 * `hasValidTriageStamp()` skips these forever since their content hasn't
 * changed), a needs-grill/not-executable verdict, and an active task status.
 */
const STAMPED_INVISIBLE_QUERY = `
  SELECT id, title, description, status, disposition, created_at, kaya_triage
  FROM tasks
  WHERE disposition = 'autonomous'
    AND queue_item_id IS NULL
    AND kaya_triage IS NOT NULL
    AND json_extract(kaya_triage, '$.scope') IS NULL
    AND json_extract(kaya_triage, '$.verdict') IN ('needs-grill', 'not-executable')
    AND status IN ('inbox', 'next', 'in_progress', 'waiting')
  ORDER BY created_at ASC
`;

export function loadStampedInvisibleTasks(lucidDbPath: string): StampedTaskRow[] {
  if (!existsSync(lucidDbPath)) return [];
  const db = openReadonly(lucidDbPath);
  try {
    return db.query(STAMPED_INVISIBLE_QUERY).all() as StampedTaskRow[];
  } finally {
    db.close();
  }
}

/** Truncate an executor comment to a prompt-safe snippet. */
function truncateSnippet(text: string, max = 240): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Look up a task's status/disposition plus executor-delivered and
 * Jm-approved comment evidence, using an already-open readonly connection.
 * Returns null if the task doesn't exist in this db.
 */
function queryTaskEvidence(db: Database, taskId: string): LinkedTaskEvidence | null {
  const task = db
    .query(`SELECT status, disposition FROM tasks WHERE id = ?`)
    .get(taskId) as { status: string; disposition: string | null } | null;
  if (!task) return null;

  const comments = db
    .query(
      `SELECT actor, changes FROM activity_log WHERE task_id = ? AND action = 'comment' ORDER BY created_at ASC`
    )
    .all(taskId) as { actor: string; changes: string }[];

  let executorDelivered = false;
  let executorEvidenceSnippet: string | null = null;
  let approvedByJm = false;

  for (const c of comments) {
    let text = "";
    try {
      const parsed = JSON.parse(c.changes) as { text?: string };
      text = parsed.text ?? "";
    } catch {
      continue;
    }
    // "Deliverable" prefix distinguishes real deliveries from EXECUTOR_FAIL
    // comments (unparseable verdict / non-zero exit) — see executor.ts.
    if (c.actor === "executor" && text.startsWith("Deliverable")) {
      executorDelivered = true;
      executorEvidenceSnippet = truncateSnippet(text);
    }
    if (c.actor === "jm" && /approved/i.test(text)) {
      approvedByJm = true;
    }
  }

  return {
    status: task.status,
    disposition: task.disposition,
    executorDelivered,
    executorEvidenceSnippet,
    approvedByJm,
  };
}

/** Standalone wrapper around queryTaskEvidence for direct/testing use — opens+closes its own connection. */
export function loadLinkedTaskEvidence(lucidDbPath: string, taskId: string): LinkedTaskEvidence | null {
  if (!existsSync(lucidDbPath)) return null;
  const db = openReadonly(lucidDbPath);
  try {
    return queryTaskEvidence(db, taskId);
  } finally {
    db.close();
  }
}

/** Parse a kaya_triage TriageStamp JSON blob. Malformed stamps are treated as absent. */
function parseTriageStamp(raw: string): { verdict: string; confidence: number; reasoning: string } | null {
  try {
    const parsed = JSON.parse(raw) as { verdict?: string; confidence?: number; reasoning?: string };
    if (typeof parsed.verdict !== "string") return null;
    return {
      verdict: parsed.verdict,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  } catch {
    return null;
  }
}

// ============================================================================
// buildCandidates — merge both cohorts with deterministic pre-signals
// ============================================================================

/**
 * Load both cohorts (needs-grilling pipeline items + stamped-invisible
 * LucidTasks) and merge them into a single candidate list, each annotated
 * with deterministic pre-signals (age, linked-task status, executor-delivered
 * sibling evidence) for the LLM to judge — no thresholds, the LLM decides.
 *
 * Opens the lucid db ONCE and reuses the connection across all lookups
 * (rather than per-candidate) — still fully read-only, just avoids ~90
 * separate connection opens for a single batch run.
 */
export function buildCandidates(
  pipelineDbPath: string,
  lucidDbPath: string,
  now: Date = new Date()
): TriageCandidate[] {
  const pipelineRows = loadNeedsGrillingItems(pipelineDbPath);
  const stampedRows = loadStampedInvisibleTasks(lucidDbPath);

  const lucidDb = existsSync(lucidDbPath) ? openReadonly(lucidDbPath) : null;
  try {
    const candidates: TriageCandidate[] = [];

    for (const row of pipelineRows) {
      const evidence =
        row.lucid_task_id && lucidDb ? queryTaskEvidence(lucidDb, row.lucid_task_id) : null;
      candidates.push({
        id: row.id,
        kind: "pipeline-item",
        title: row.title,
        description: row.description,
        createdAt: row.created_at,
        ageDays: computeAgeDays(row.created_at, now),
        lucidTaskId: row.lucid_task_id || null,
        linkedTaskStatus: evidence?.status ?? null,
        linkedTaskDisposition: evidence?.disposition ?? null,
        executorDelivered: evidence?.executorDelivered ?? false,
        executorEvidenceSnippet: evidence?.executorEvidenceSnippet ?? null,
        approvedByJm: evidence?.approvedByJm ?? false,
        stampVerdict: null,
        stampConfidence: null,
        stampReasoning: null,
      });
    }

    for (const row of stampedRows) {
      const stamp = parseTriageStamp(row.kaya_triage);
      // Check the task's OWN activity log too — it may have been delivered by
      // the Lane A executor directly despite never graduating into the pipeline.
      const evidence = lucidDb ? queryTaskEvidence(lucidDb, row.id) : null;
      candidates.push({
        id: row.id,
        kind: "stamped-task",
        title: row.title,
        description: row.description,
        createdAt: row.created_at,
        ageDays: computeAgeDays(row.created_at, now),
        lucidTaskId: row.id,
        linkedTaskStatus: row.status,
        linkedTaskDisposition: row.disposition,
        executorDelivered: evidence?.executorDelivered ?? false,
        executorEvidenceSnippet: evidence?.executorEvidenceSnippet ?? null,
        approvedByJm: evidence?.approvedByJm ?? false,
        stampVerdict: stamp?.verdict ?? null,
        stampConfidence: stamp?.confidence ?? null,
        stampReasoning: stamp?.reasoning ?? null,
      });
    }

    return candidates;
  } finally {
    lucidDb?.close();
  }
}

// ============================================================================
// LLM classification — chunked, per-chunk fault tolerant (KayaTaskClassifier idiom)
// ============================================================================

export const CHUNK_SIZE = 10;

export type TriageChunkClassifierFn = (
  candidates: TriageCandidate[],
  chunkIndex: number,
  totalChunks: number,
  systemPrompt: string
) => Promise<TriageProposal[]>;

export function buildTriageSystemPrompt(): string {
  return `You are triaging Jm's stale Kaya spec-pipeline backlog for him. Two cohorts of items are mixed together — each item carries a "kind" field:

- "pipeline-item": a spec-pipeline item stuck in needs-grilling (parked, waiting for a Socratic grill session before work can begin).
- "stamped-task": a LucidTask that carries a triage stamp written before the pipeline's "scope" field existed. Because the stamp's content-hash still matches, Kaya's IntakeRunner treats it as "already judged" and skips it on every run forever — these tasks are permanently invisible even though the current code would otherwise visibly park them.

For EACH item, decide exactly one verdict:

- "kill" — no longer relevant / stale / not worth doing. The underlying need has evaporated, was superseded, or was never worth pursuing. Jm will close it without further action.
- "merge-duplicate" — the work this item describes has ALREADY been delivered (by the Lane A autonomous executor working the same LucidTask outside the spec pipeline, or by another item in this same backlog). REQUIRES survivor_id: the id of the item/task that already covers the work (use the linked LucidTask id when executor_delivered=true — the executor comment lives there — or another candidate's id when two items are duplicates of each other).
- "downgrade-to-executor" — still worth doing, but doesn't need the heavyweight research+spec pipeline. It's a small, well-enough-understood task that the Lane A autonomous executor can just run directly once re-routed.
- "keep-for-grill" — genuinely needs Jm's Socratic-grill session (a short interactive Q&A) to resolve real ambiguity before any work — target, scope, or expected output is still unclear even after you consider all the evidence below.

Judge from the evidence provided per item — no fixed thresholds, use judgment:
- age_days: how long the item has sat unactioned (from created_at — the pipeline's updated_at field is unreliable, a bulk sweep touched it on every row on one date).
- linked_task_status / linked_task_disposition: the state of the LucidTask this item traces back to.
- executor_delivered + executor_evidence: if true, the linked LucidTask already has a "Deliverable" comment from the Lane A executor describing what was built — this is strong (often decisive) evidence for "merge-duplicate", with survivor_id = the LucidTask id (lucid_task_id / the stamped-task's own id).
- approved_by_jm: Jm explicitly approved/merged that delivery — strengthens the "already done" case further.
- stamped_invisible + prior_triage_verdict/prior_triage_reasoning (stamped-task items only): the classifier's original verdict and reasoning, now stale but still informative context.

Be decisive but honest about uncertainty — reasoning should name the concrete evidence that drove the call, not just restate the verdict. A short task title with a thin description and zero corroborating evidence, sitting for weeks, is a reasonable "keep-for-grill" or "kill" candidate depending on whether the underlying need still seems durable — use your judgment, don't default to one or the other.

Output format — for each input item, emit exactly:
{
  "id": string,
  "verdict": "kill" | "merge-duplicate" | "downgrade-to-executor" | "keep-for-grill",
  "reasoning": string (1-3 sentences citing the concrete evidence),
  "survivor_id": string (REQUIRED when verdict is "merge-duplicate", omit otherwise)
}

Output ONLY a JSON array, one object per input item, in the same order. No prose, no markdown fences.`;
}

/**
 * Parse a JSON array, repairing the one malformation Claude reliably emits
 * for this prompt shape: a trailing comma before a `}` or `]` (e.g. after the
 * last field of a multi-line object literal). `inference()`'s own
 * `extractJson` has no such repair step, so a single stray comma anywhere in
 * a 10-item response fails the WHOLE chunk even though 9 of the 10 objects
 * are perfectly valid JSON. Tries a direct parse first; only applies the
 * regex repair (and re-parses) if that fails. Returns null if the input is
 * still unparseable after repair — callers fall back to their normal
 * failure path (chunk marked unclassified, self-heals on rerun).
 */
export function repairAndParseJsonArray(text: string): unknown[] | null {
  const tryParse = (s: string): unknown[] | null => {
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(text);
  if (direct) return direct;

  const repaired = text.replace(/,(\s*[}\]])/g, "$1");
  return tryParse(repaired);
}

async function classifyChunk(
  candidates: TriageCandidate[],
  _chunkIndex: number,
  _totalChunks: number,
  systemPrompt: string
): Promise<TriageProposal[]> {
  const payload = candidates.map((c) => ({
    id: c.id,
    kind: c.kind,
    title: c.title,
    description: c.description.slice(0, 500),
    age_days: c.ageDays,
    linked_task_status: c.linkedTaskStatus,
    linked_task_disposition: c.linkedTaskDisposition,
    executor_delivered: c.executorDelivered,
    executor_evidence: c.executorEvidenceSnippet,
    approved_by_jm: c.approvedByJm,
    stamped_invisible: c.kind === "stamped-task",
    prior_triage_verdict: c.stampVerdict,
    prior_triage_reasoning: c.stampReasoning,
  }));

  const userPrompt = `Triage the following ${candidates.length} backlog item(s):\n\n${JSON.stringify(payload, null, 2)}`;

  const result = await inference({
    systemPrompt,
    userPrompt,
    level: "standard",
    expectJson: true,
    timeout: 120_000,
    retries: 1,
  });

  let parsedArray: unknown[] | undefined;
  if (result.success && Array.isArray(result.parsed)) {
    parsedArray = result.parsed;
  } else {
    // inference()'s own extractJson has no trailing-comma repair — try ours
    // before giving up. result.output holds the raw text on both success and
    // failure paths.
    const repaired = repairAndParseJsonArray(result.output);
    if (repaired) {
      console.warn(`[BacklogTriage] Recovered malformed JSON via trailing-comma repair.`);
      parsedArray = repaired;
    }
  }

  if (!parsedArray) {
    throw new Error(`BacklogTriage inference failed: ${result.error || "no parsed output"}`);
  }

  const out: TriageProposal[] = [];
  for (const item of parsedArray) {
    const parsed = TriageProposalSchema.safeParse(item);
    if (parsed.success) {
      out.push(parsed.data);
    } else {
      const id = (item as Record<string, unknown>)?.id ?? "unknown";
      console.warn(`[BacklogTriage] Skipping item id=${id}: ${parsed.error.issues[0]?.message}`);
    }
  }
  return out;
}

export interface RunTriageResult {
  proposals: TriageProposal[];
  /** Candidate ids that never got a valid proposal this run (failed chunk OR silently omitted by the LLM). */
  unclassifiedIds: string[];
  failedChunks: number;
  totalChunks: number;
}

/**
 * Classify candidates in chunks with per-chunk fault tolerance — mirrors
 * classifyTasksForKaya() in KayaTaskClassifier.ts exactly: a failed chunk is
 * logged and skipped (its ids land in unclassifiedIds, self-healing on next
 * run); only a TOTAL outage (every chunk fails) throws.
 */
export async function runBacklogTriage(
  candidates: TriageCandidate[],
  classifyFn: TriageChunkClassifierFn = classifyChunk,
  chunkSize: number = CHUNK_SIZE
): Promise<RunTriageResult> {
  if (candidates.length === 0) {
    return { proposals: [], unclassifiedIds: [], failedChunks: 0, totalChunks: 0 };
  }

  const systemPrompt = buildTriageSystemPrompt();
  const chunks = chunk(candidates, chunkSize);
  console.log(`[BacklogTriage] Triaging ${candidates.length} item(s) in ${chunks.length} chunk(s) of ${chunkSize}.`);

  const all: TriageProposal[] = [];
  let failedChunks = 0;
  const unclassifiedIds: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    console.log(`[BacklogTriage] Chunk ${i + 1}/${chunks.length} (${chunks[i].length} items)…`);
    try {
      const proposals = await classifyFn(chunks[i], i, chunks.length, systemPrompt);
      all.push(...proposals);
    } catch (err) {
      failedChunks++;
      unclassifiedIds.push(...chunks[i].map((c) => c.id));
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[BacklogTriage] Chunk ${i + 1}/${chunks.length} failed: ${msg} — skipping.`);
    }
  }

  if (failedChunks === chunks.length && chunks.length > 0) {
    throw new Error(
      `BacklogTriage: all ${chunks.length} chunk(s) failed — zero proposals produced. Check API availability.`
    );
  }

  // Items in successful chunks that the LLM silently omitted also count as unclassified.
  const proposedIds = new Set(all.map((p) => p.id));
  const alreadyTracked = new Set(unclassifiedIds);
  for (const c of candidates) {
    if (!proposedIds.has(c.id) && !alreadyTracked.has(c.id)) {
      unclassifiedIds.push(c.id);
      alreadyTracked.add(c.id);
    }
  }

  if (failedChunks > 0) {
    console.warn(
      `[BacklogTriage] Partial success: ${failedChunks}/${chunks.length} chunk(s) failed, ${all.length} proposal(s) returned.`
    );
  }

  return { proposals: all, unclassifiedIds, failedChunks, totalChunks: chunks.length };
}

// ============================================================================
// Grouping
// ============================================================================

export interface GroupedItem {
  candidate: TriageCandidate;
  proposal: TriageProposal;
}

export type VerdictBucket = Record<TriageVerdict, GroupedItem[]>;

export interface GroupedTriage {
  pipelineByVerdict: VerdictBucket;
  stampedByVerdict: VerdictBucket;
  unclassified: TriageCandidate[];
}

const VERDICT_ORDER: TriageVerdict[] = ["kill", "merge-duplicate", "downgrade-to-executor", "keep-for-grill"];

function emptyVerdictBucket(): VerdictBucket {
  return { kill: [], "merge-duplicate": [], "downgrade-to-executor": [], "keep-for-grill": [] };
}

/** Group candidates by kind then verdict; candidates with no matching proposal go to `unclassified`. */
export function groupProposals(candidates: TriageCandidate[], result: RunTriageResult): GroupedTriage {
  const proposalById = new Map(result.proposals.map((p) => [p.id, p]));
  const pipelineByVerdict = emptyVerdictBucket();
  const stampedByVerdict = emptyVerdictBucket();
  const unclassified: TriageCandidate[] = [];

  for (const c of candidates) {
    const p = proposalById.get(c.id);
    if (!p) {
      unclassified.push(c);
      continue;
    }
    const bucket = c.kind === "pipeline-item" ? pipelineByVerdict : stampedByVerdict;
    bucket[p.verdict].push({ candidate: c, proposal: p });
  }

  return { pipelineByVerdict, stampedByVerdict, unclassified };
}

function computeVerdictCounts(grouped: GroupedTriage): Record<TriageVerdict, number> {
  const counts = emptyVerdictBucket();
  const numeric: Record<TriageVerdict, number> = {
    kill: 0,
    "merge-duplicate": 0,
    "downgrade-to-executor": 0,
    "keep-for-grill": 0,
  };
  for (const bucket of [grouped.pipelineByVerdict, grouped.stampedByVerdict]) {
    for (const v of VERDICT_ORDER) {
      numeric[v] += bucket[v].length;
    }
  }
  void counts; // (kept for symmetry with emptyVerdictBucket; numeric is the real return)
  return numeric;
}

// ============================================================================
// Report rendering — Markdown (Jm review) + JSON (H2 executor input)
// ============================================================================

export interface TriageReportMeta {
  generatedAt: string;
  pipelineDbPath: string;
  lucidDbPath: string;
}

const VERDICT_LABELS: Record<TriageVerdict, string> = {
  kill: "Kill",
  "merge-duplicate": "Merge / Duplicate",
  "downgrade-to-executor": "Downgrade to Executor",
  "keep-for-grill": "Keep for Grill",
};

function renderItem(n: number, g: GroupedItem): string {
  const { candidate: c, proposal: p } = g;
  const lines = [
    `${n}. **${c.title}** \`${c.id}\` — age ${c.ageDays}d`,
    `   - Proposal: **${VERDICT_LABELS[p.verdict]}**${
      p.verdict === "merge-duplicate" && p.survivor_id ? ` → survivor \`${p.survivor_id}\`` : ""
    }`,
    `   - Reasoning: ${p.reasoning}`,
  ];
  const evidence: string[] = [];
  if (c.lucidTaskId) evidence.push(`lucid_task_id=${c.lucidTaskId}`);
  if (c.linkedTaskStatus) evidence.push(`linked task status=${c.linkedTaskStatus}`);
  if (c.executorDelivered) evidence.push(`executor-delivered: "${c.executorEvidenceSnippet ?? ""}"`);
  if (c.approvedByJm) evidence.push("Jm-approved comment present");
  if (c.stampVerdict) evidence.push(`prior triage stamp: ${c.stampVerdict} (conf ${c.stampConfidence})`);
  if (evidence.length > 0) lines.push(`   - Evidence: ${evidence.join("; ")}`);
  return lines.join("\n");
}

function renderVerdictSection(byVerdict: VerdictBucket): string {
  return VERDICT_ORDER.map((v) => {
    const items = byVerdict[v];
    const header = `### ${VERDICT_LABELS[v]} (${items.length})`;
    if (items.length === 0) return `${header}\n\n_none_`;
    return `${header}\n\n${items.map((g, i) => renderItem(i + 1, g)).join("\n\n")}`;
  }).join("\n\n");
}

/**
 * Render the durable Markdown report — grouped by verdict, numbered within
 * each group, so Jm (or an AskUserQuestion-driven H2 flow) can review and
 * approve/reject batch by batch.
 */
export function renderMarkdownReport(
  candidates: TriageCandidate[],
  grouped: GroupedTriage,
  meta: TriageReportMeta
): string {
  const pipelineTotal = candidates.filter((c) => c.kind === "pipeline-item").length;
  const stampedTotal = candidates.filter((c) => c.kind === "stamped-task").length;
  const verdictCounts = computeVerdictCounts(grouped);

  const lines: string[] = [
    `# Backlog Triage Report — ${meta.generatedAt.slice(0, 10)}`,
    "",
    "## Summary",
    "",
    `- Needs-grilling spec-pipeline items analyzed: ${pipelineTotal}`,
    `- Stamped-invisible LucidTasks analyzed: ${stampedTotal}`,
    `- Verdict distribution: kill=${verdictCounts.kill}, merge-duplicate=${verdictCounts["merge-duplicate"]}, downgrade-to-executor=${verdictCounts["downgrade-to-executor"]}, keep-for-grill=${verdictCounts["keep-for-grill"]}`,
  ];
  if (grouped.unclassified.length > 0) {
    lines.push(`- Unclassified (inference gaps — rerun): ${grouped.unclassified.length}`);
  }
  lines.push(
    "",
    "This is a READ-ONLY proposal report. Nothing has been executed — H2 (Jm-approved execution) acts on these proposals in-session, batch by batch.",
    "",
    "## Section A — Needs-Grilling Spec-Pipeline Items",
    "",
    renderVerdictSection(grouped.pipelineByVerdict),
    "",
    "## Section B — Stamped-Invisible LucidTasks (pre-scope-field triage stamps)",
    "",
    `**Re-triage recommendation:** these ${stampedTotal} LucidTasks carry a \`kaya_triage\` stamp written before the \`scope\` field existed. Because the stamp's content-hash still matches, \`hasValidTriageStamp()\` skips them on every IntakeRunner run forever — they are permanently invisible even though the current enqueue path now visibly parks non-clear verdicts instead of silently stamping them. For every item below that is NOT verdict=kill, clear \`kaya_triage\` on the LucidTask (set to NULL) so the next \`IntakeRunner --enqueue\` run re-judges it fresh with the current scope-aware classifier and parks it visibly in needs-grilling.`,
    "",
    renderVerdictSection(grouped.stampedByVerdict)
  );

  if (grouped.unclassified.length > 0) {
    lines.push(
      "",
      "## Unclassified — inference gaps (rerun)",
      "",
      grouped.unclassified.map((c, i) => `${i + 1}. \`${c.id}\` ${c.title} (age ${c.ageDays}d)`).join("\n")
    );
  }

  lines.push(
    "",
    "---",
    `_Generated ${meta.generatedAt} — pipeline db: \`${meta.pipelineDbPath}\`, lucid db: \`${meta.lucidDbPath}\`. Read-only analysis; zero writes to either database._`
  );

  return lines.join("\n");
}

export interface TriageJsonItem {
  id: string;
  kind: CandidateKind;
  title: string;
  ageDays: number;
  createdAt: string;
  lucidTaskId: string | null;
  verdict: TriageVerdict;
  reasoning: string;
  survivorId: string | null;
  evidence: {
    linkedTaskStatus: string | null;
    linkedTaskDisposition: string | null;
    executorDelivered: boolean;
    executorEvidenceSnippet: string | null;
    approvedByJm: boolean;
    stampVerdict: string | null;
    stampConfidence: number | null;
  };
}

export interface TriageJsonOutput {
  generatedAt: string;
  pipelineDbPath: string;
  lucidDbPath: string;
  totals: { pipelineItems: number; stampedInvisible: number; unclassified: number };
  verdictCounts: Record<TriageVerdict, number>;
  items: TriageJsonItem[];
  unclassified: Array<{ id: string; kind: CandidateKind; title: string }>;
}

/** Machine-readable output for H2's executor to consume. */
export function buildJsonOutput(
  candidates: TriageCandidate[],
  grouped: GroupedTriage,
  meta: TriageReportMeta
): TriageJsonOutput {
  const items: TriageJsonItem[] = [];
  for (const bucket of [grouped.pipelineByVerdict, grouped.stampedByVerdict]) {
    for (const v of VERDICT_ORDER) {
      for (const g of bucket[v]) {
        items.push({
          id: g.candidate.id,
          kind: g.candidate.kind,
          title: g.candidate.title,
          ageDays: g.candidate.ageDays,
          createdAt: g.candidate.createdAt,
          lucidTaskId: g.candidate.lucidTaskId,
          verdict: g.proposal.verdict,
          reasoning: g.proposal.reasoning,
          survivorId: g.proposal.survivor_id ?? null,
          evidence: {
            linkedTaskStatus: g.candidate.linkedTaskStatus,
            linkedTaskDisposition: g.candidate.linkedTaskDisposition,
            executorDelivered: g.candidate.executorDelivered,
            executorEvidenceSnippet: g.candidate.executorEvidenceSnippet,
            approvedByJm: g.candidate.approvedByJm,
            stampVerdict: g.candidate.stampVerdict,
            stampConfidence: g.candidate.stampConfidence,
          },
        });
      }
    }
  }

  return {
    generatedAt: meta.generatedAt,
    pipelineDbPath: meta.pipelineDbPath,
    lucidDbPath: meta.lucidDbPath,
    totals: {
      pipelineItems: candidates.filter((c) => c.kind === "pipeline-item").length,
      stampedInvisible: candidates.filter((c) => c.kind === "stamped-task").length,
      unclassified: grouped.unclassified.length,
    },
    verdictCounts: computeVerdictCounts(grouped),
    items,
    unclassified: grouped.unclassified.map((c) => ({ id: c.id, kind: c.kind, title: c.title })),
  };
}

/** Console summary table — quick verdict distribution glance. */
export function printConsoleSummary(grouped: GroupedTriage): void {
  const counts = computeVerdictCounts(grouped);
  console.log("\nBacklog Triage — Verdict Distribution\n");
  for (const v of VERDICT_ORDER) {
    console.log(`  ${VERDICT_LABELS[v].padEnd(24)}${counts[v]}`);
  }
  if (grouped.unclassified.length > 0) {
    console.log(`  ${"Unclassified".padEnd(24)}${grouped.unclassified.length}`);
  }
  console.log("");
}

// ============================================================================
// CLI entry point
// ============================================================================

const USAGE =
  "Usage: bun BacklogTriage.ts [--limit N] [--pipeline-db PATH] [--lucid-db PATH] [--out-dir PATH]";

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

export interface RunCliResult {
  mdPath: string;
  jsonPath: string;
  grouped: GroupedTriage;
  candidates: TriageCandidate[];
}

/** Orchestrate a full run: load → cap → classify → group → render → write files → print summary. */
export async function runCli(argv: string[]): Promise<RunCliResult> {
  const limitRaw = argValue(argv, "--limit");
  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
  const pipelineDbPath = argValue(argv, "--pipeline-db") ?? defaultPipelineDbPath();
  const lucidDbPath = argValue(argv, "--lucid-db") ?? defaultLucidDbPath();
  const outDir = argValue(argv, "--out-dir") ?? defaultReportDir();

  const now = new Date();
  const allCandidates = buildCandidates(pipelineDbPath, lucidDbPath, now);
  const candidates = capCandidates(allCandidates, limit);

  console.log(
    `[BacklogTriage] ${candidates.length}/${allCandidates.length} candidate(s) selected for triage ` +
      `(pipeline-db: ${pipelineDbPath}, lucid-db: ${lucidDbPath}).`
  );

  const result = await runBacklogTriage(candidates);
  const grouped = groupProposals(candidates, result);

  const dateStr = now.toISOString().slice(0, 10);
  const meta: TriageReportMeta = { generatedAt: now.toISOString(), pipelineDbPath, lucidDbPath };

  const md = renderMarkdownReport(candidates, grouped, meta);
  const json = buildJsonOutput(candidates, grouped, meta);

  mkdirSync(outDir, { recursive: true });
  const mdPath = join(outDir, `backlog-triage-${dateStr}.md`);
  const jsonPath = join(outDir, `backlog-triage-${dateStr}.json`);
  writeFileSync(mdPath, md);
  writeFileSync(jsonPath, JSON.stringify(json, null, 2));

  printConsoleSummary(grouped);
  console.log(`[BacklogTriage] Report written: ${mdPath}`);
  console.log(`[BacklogTriage] JSON written:   ${jsonPath}`);

  return { mdPath, jsonPath, grouped, candidates };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }

  runCli(argv)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("FATAL:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
