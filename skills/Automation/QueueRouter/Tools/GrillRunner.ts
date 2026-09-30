#!/usr/bin/env bun
/**
 * GrillRunner.ts — Slice 3: Interactive grill session actions
 *
 * Provides the operations needed by the GrillTask workflow:
 *   - listParkedForGrill   : show top-N needs-grilling items
 *   - finalizeGrillToSpec  : attach interview context → kick off pipeline
 *   - killTask             : archive the spec-pipeline item (+ cancel LucidTask)
 *   - splitTask            : create subtasks via LucidTasks, archive parent
 *   - deferTask            : move item back to awaiting-context with deferUntil
 *   - draftFindings        : G3 — LLM-draft a findings artifact from an interview
 *                             transcript, in the exact format finalizeGrillToSpec
 *                             --findings expects. Draft-only: never persists,
 *                             never calls attachContext/process/finalize. Jm
 *                             reviews the printed draft and finalizes manually.
 *
 * All side-effecting calls are INJECTABLE via `deps` params so tests can stub
 * them without spawning subprocesses or hitting an LLM.
 *
 * @module GrillRunner
 */

import { QueueManager, loadQueueItems, type QueueItem, type AttachContextOptions } from "./QueueManager.ts";
import { processItem as defaultProcessItem } from "./SpecPipelineRunner.ts";
import { inference } from "../../../../lib/core/Inference.ts";
import { getTaskClient } from "../../../../lib/interfaces/QueueTaskIntegration.ts";

// ============================================================================
// Singleton QueueManager (default for non-injected calls)
// ============================================================================

function getQm(): QueueManager {
  return new QueueManager();
}

// ============================================================================
// Types
// ============================================================================

/** Interview answers collected from the Socratic grill session */
export interface GrillInterview {
  notes: string;
  researchGuidance: string;
  scopeHints?: string;
  /**
   * Path to a research findings artifact written by the grill session.
   * When set, runResearchPhase skips the autonomous research spawn and
   * dispatches the verdict directly from this artifact.
   */
  findingsPath?: string;
  /** Explicitly opt into the full autonomous research spawn despite findings. */
  deepResearch?: boolean;
}

/** Result returned by finalizeGrillToSpec */
export interface FinalizeResult {
  ok: boolean;
  status: string;
  specPath?: string;
  message: string;
}

/** Result returned by killTask */
export interface KillResult {
  ok: boolean;
  message: string;
}

/** Result returned by splitTask */
export interface SplitResult {
  ok: boolean;
  childIds: string[];
  message: string;
}

/** Result returned by deferTask */
export interface DeferResult {
  ok: boolean;
  message: string;
}

// ============================================================================
// 1. listParkedForGrill
// ============================================================================

/**
 * Return the top-N spec-pipeline items in `needs-grilling` status,
 * sorted by priority (1 = highest) then by created date ascending.
 *
 * @param limit - Maximum number of items to return (default: 5)
 */
export function listParkedForGrill(limit = 5): QueueItem[] {
  const items = loadQueueItems("spec-pipeline").filter(
    (i) => i.status === "needs-grilling"
  );
  items.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return new Date(a.created).getTime() - new Date(b.created).getTime();
  });
  return items.slice(0, limit);
}

/**
 * Format a "showing N of TOTAL" label for a truncated display list.
 *
 * `listParkedForGrill(limit=5)` silently truncated to 5 with no indication
 * that dozens more items were waiting (74 needs-grilling items were
 * invisible this way). Callers that display a limited slice MUST pair it
 * with this label so the true backlog size is always visible.
 *
 * @param shown - Number of items actually displayed
 * @param total - True total count in the backlog
 */
export function formatBacklogLabel(shown: number, total: number): string {
  return shown < total ? `showing ${shown} of ${total}` : `${shown}`;
}

// ============================================================================
// 1b. getGrillBacklogSummary — backlog visibility (ages, oldest, auto-select)
// ============================================================================

/** Missing-info + suggested questions recorded on a parked item's grillBrief */
export interface GrillBriefView {
  missing: string[];
  suggestedQuestions: string[];
}

/** The auto-selected top candidate for a grill session */
export interface GrillBacklogTopItem {
  id: string;
  title: string;
  ageDays: number;
  whyTop: string;
}

/** Aggregate visibility over the full needs-grilling backlog */
export interface GrillBacklogSummary {
  total: number;
  oldestAgeDays: number;
  medianAgeDays: number;
  topItem: GrillBacklogTopItem | null;
}

/**
 * Summarize the full needs-grilling backlog: total count, oldest/median age
 * in days, and the auto-selected top candidate (oldest-first — the sensible
 * default when nothing else distinguishes items).
 *
 * Ages are computed from `created` (creation date), NEVER `updated`. A bulk
 * archival sweep touched `updated` on all 74 needs-grilling rows on
 * 2026-06-29, which makes `updated` a false staleness signal for this
 * backlog — `created` is the only reliable age source. This is a known trap;
 * do not "fix" this to use `updated` without re-reading that history.
 *
 * @param now - Clock to measure age against (injectable for tests; defaults to real now)
 */
export function getGrillBacklogSummary(now: Date = new Date()): GrillBacklogSummary {
  const items = loadQueueItems("spec-pipeline").filter(
    (i) => i.status === "needs-grilling"
  );

  if (items.length === 0) {
    return { total: 0, oldestAgeDays: 0, medianAgeDays: 0, topItem: null };
  }

  const ageDaysOf = (item: QueueItem): number =>
    (now.getTime() - new Date(item.created).getTime()) / (1000 * 60 * 60 * 24);

  let oldest = items[0];
  let oldestAge = ageDaysOf(oldest);
  const ages: number[] = [];
  for (const item of items) {
    const age = ageDaysOf(item);
    ages.push(age);
    if (age > oldestAge) {
      oldest = item;
      oldestAge = age;
    }
  }

  ages.sort((a, b) => a - b);
  const mid = Math.floor(ages.length / 2);
  const rawMedian =
    ages.length % 2 === 0 ? (ages[mid - 1] + ages[mid]) / 2 : ages[mid];

  const round1 = (n: number): number => Math.round(n * 10) / 10;
  const oldestAgeDays = round1(oldestAge);

  return {
    total: items.length,
    oldestAgeDays,
    medianAgeDays: round1(rawMedian),
    topItem: {
      id: oldest.id,
      title: oldest.payload.title,
      ageDays: oldestAgeDays,
      whyTop: `oldest of ${items.length} waiting items — created ${oldest.created} (${oldestAgeDays}d ago)`,
    },
  };
}

/**
 * Extract the grill brief (missing gaps + suggested questions) recorded on
 * an item by QueueManager.parkForGrill / rejectToGrill.
 */
export function getGrillBrief(item: QueueItem): GrillBriefView {
  const meta = (item.payload.context?._meta as Record<string, unknown>) ?? {};
  const brief = meta.grillBrief as
    | { missing?: string[]; suggested_questions?: string[] }
    | undefined;
  return {
    missing: brief?.missing ?? [],
    suggestedQuestions: brief?.suggested_questions ?? [],
  };
}

/**
 * Look up a spec-pipeline item by id and extract its grill brief.
 * Returns null when the item is not found (e.g. archived/swept).
 */
export function getGrillBriefForId(id: string): GrillBriefView | null {
  const item = loadQueueItems("spec-pipeline").find((i) => i.id === id);
  if (!item) return null;
  return getGrillBrief(item);
}

// ============================================================================
// 2. finalizeGrillToSpec
// ============================================================================

/** Injectable deps for finalizeGrillToSpec */
export interface FinalizeGrillDeps {
  /** Attach context and transition to researching. Defaults to qm.attachContext. */
  attachContext?: (
    id: string,
    notes: string,
    researchGuidance: string,
    scopeHints?: string,
    options?: AttachContextOptions
  ) => Promise<QueueItem | null>;
  /** Process the item through the pipeline. Defaults to SpecPipelineRunner.processItem. */
  process?: (id: string) => Promise<{ success: boolean; message: string }>;
}

/**
 * Attach interview context to a parked item, then drive it through the
 * spec-pipeline until it leaves (transferred to approvals) or stalls.
 *
 * attachContext is ALWAYS called first. Then we loop, calling process(id)
 * while the item is still in spec-pipeline with an advancing status.
 *
 * Loop terminates when:
 *   (a) item is no longer in spec-pipeline (transferred to approvals — success)
 *   (b) status stops changing between iterations (no progress — break)
 *   (c) a process call returns failure
 *   (d) hard cap of 4 iterations
 *
 * @param id        - Item ID (must be in spec-pipeline, status needs-grilling)
 * @param interview - Notes, researchGuidance, and optional scopeHints
 * @param deps      - Injectable dependencies (default: real implementations)
 */
export async function finalizeGrillToSpec(
  id: string,
  interview: GrillInterview,
  deps?: FinalizeGrillDeps
): Promise<FinalizeResult> {
  const qm = getQm();

  const attachContext =
    deps?.attachContext ?? qm.attachContext.bind(qm);

  const process: (id: string) => Promise<{ success: boolean; message: string }> =
    deps?.process ?? defaultProcessItem;

  // Step 1: attach context (transitions → researching)
  // attachContext returns null when the item is missing (e.g. swept to archive
  // by QueueTaskReconciler mid-grill) — proceeding would false-report success.
  const attached = await attachContext(
    id,
    interview.notes,
    interview.researchGuidance,
    interview.scopeHints,
    { findingsPath: interview.findingsPath, deepResearch: interview.deepResearch }
  );
  if (attached === null) {
    return {
      ok: false,
      status: "not-found",
      message: `Item ${id} not found in spec-pipeline — it may have been archived (check archive/spec-pipeline-archive.jsonl and the linked LucidTask status).`,
    };
  }

  // Step 2: loop through pipeline phases until item leaves spec-pipeline or stalls.
  //
  // Per-iteration flow:
  //   1. Re-load status from disk. Check pre-call termination conditions:
  //      (a) item left spec-pipeline → success (early exit after first process call)
  //      (b) status unchanged since last call → stalled, break (condition b)
  //   2. Call process(id).
  //   3. Check post-call termination:
  //      (c) process returned failure → break
  //      (d) hard cap of MAX_ITERATIONS
  //
  // Invariant: process() is always called at least once (first iteration skips
  // the stall check because lastStatus is null).
  const IN_PIPELINE_STATUSES = new Set(["researching", "generating-spec"]);
  const MAX_ITERATIONS = 4;
  let lastStatus: string | null = null;
  let lastResult: { success: boolean; message: string } = { success: false, message: "no iterations ran" };

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // Pre-call: reload current state from disk
    const currentItems = loadQueueItems("spec-pipeline");
    const currentItem = currentItems.find((item) => item.id === id);

    // On iterations after the first: check termination conditions before calling process
    if (i > 0) {
      // (a) Item left spec-pipeline — verify it actually landed in approvals.
      // Absence alone is NOT success: a concurrent sweep (cleanup/reconciler)
      // also removes items from spec-pipeline.
      if (!currentItem) {
        const finalItem = await qm.get(id);
        if (finalItem && finalItem.queue === "approvals") {
          return {
            ok: true,
            status: "transferred-to-approvals",
            specPath: finalItem?.spec?.path,
            message: lastResult.message,
          };
        }
        return {
          ok: false,
          status: finalItem ? `unexpected-queue:${finalItem.queue}` : "vanished",
          message: `Item ${id} left spec-pipeline but is not in approvals (${finalItem ? `found in ${finalItem.queue}` : "not found in any queue — likely swept to archive"}). Last process result: ${lastResult.message}`,
        };
      }

      // Not a pipeline-active status — stop
      if (!IN_PIPELINE_STATUSES.has(currentItem.status)) {
        lastStatus = currentItem.status;
        break;
      }

      // (b) Status stopped changing — stalled, break to avoid infinite loop
      if (lastStatus !== null && currentItem.status === lastStatus) {
        break;
      }
    }

    // Record current status before calling process
    if (currentItem) {
      lastStatus = currentItem.status;
    }

    // Call process(id)
    try {
      lastResult = await process(id);
    } catch (err) {
      const status = lastStatus ?? "unknown";
      return {
        ok: false,
        status,
        message: `processItem threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // (c) Process returned failure — stop
    if (!lastResult.success) {
      break;
    }
  }

  // Step 3: resolve final item state (searches all queues)
  const finalItem = await qm.get(id);

  if (!finalItem) {
    // Item is in no active queue. qm.get does not see archives, so this means
    // the item vanished (swept/clobbered) — never claim transfer without proof.
    return {
      ok: false,
      status: "vanished",
      message: `Item ${id} not found in any active queue after pipeline run — likely swept to archive. Last process result: ${lastResult.message}`,
    };
  }

  // ok = true when all process calls succeeded (item either reached approvals or
  // is progressing; failure = process returned failure or threw).
  const ok = lastResult.success;

  return {
    ok,
    status: finalItem.status,
    specPath: finalItem.spec?.path,
    message: lastResult.message,
  };
}

// ============================================================================
// 3. killTask
// ============================================================================

/** Injectable deps for killTask */
export interface KillTaskDeps {
  /** Archive/remove the spec-pipeline item. Defaults to qm.remove. */
  archive?: (id: string) => Promise<boolean>;
  /** Cancel the linked LucidTask. Defaults to spawning TaskManager update. */
  cancelLucid?: (lucidTaskId: string) => Promise<boolean>;
}

/**
 * Archive a spec-pipeline item and optionally cancel its linked LucidTask.
 *
 * @param id    - Spec-pipeline item ID
 * @param opts  - Optional lucidTaskId to cancel
 * @param deps  - Injectable dependencies
 */
export async function killTask(
  id: string,
  opts?: { lucidTaskId?: string },
  deps?: KillTaskDeps
): Promise<KillResult> {
  const qm = getQm();

  const archive = deps?.archive ?? (async (itemId: string) => qm.remove(itemId));

  const cancelLucid =
    deps?.cancelLucid ??
    (async (lucidTaskId: string): Promise<boolean> => {
      const client = getTaskClient();
      if (!client) {
        console.error(
          "[GrillRunner] No TaskClient registered — cannot cancel LucidTask " +
          `${lucidTaskId}. Import bin/wire-queue-task-integration.ts before calling killTask.`,
        );
        return false;
      }
      return client.updateTaskStatus(lucidTaskId, "cancelled");
    });

  const archived = await archive(id);

  if (opts?.lucidTaskId) {
    await cancelLucid(opts.lucidTaskId);
  }

  return {
    ok: archived,
    message: archived
      ? `Item ${id} archived${opts?.lucidTaskId ? ` and LucidTask ${opts.lucidTaskId} cancelled` : ""}`
      : `Failed to archive item ${id}`,
  };
}

// ============================================================================
// 4. splitTask
// ============================================================================

/** Injectable deps for splitTask */
export interface SplitTaskDeps {
  /**
   * Create a LucidTask and return its ID. Defaults to TaskClient.createTask.
   * `description` carries the child's context (SKILL.md "Task context
   * standard"): what it was split from and where the spec/queue item lives.
   */
  createTask?: (title: string, description: string) => Promise<string>;
  /** Archive/remove the parent spec-pipeline item. Defaults to qm.remove. */
  archive?: (id: string) => Promise<boolean>;
}

/**
 * Split a parked item into multiple LucidTasks and archive the parent.
 *
 * @param id               - Parent spec-pipeline item ID
 * @param subtaskTitles    - Titles for each new LucidTask
 * @param opts             - Optional lucidParentId for the parent LucidTask
 * @param deps             - Injectable dependencies
 */
export async function splitTask(
  id: string,
  subtaskTitles: string[],
  opts?: { lucidParentId?: string },
  deps?: SplitTaskDeps
): Promise<SplitResult> {
  const qm = getQm();

  const createTask =
    deps?.createTask ??
    (async (title: string, description: string): Promise<string> => {
      const client = getTaskClient();
      if (!client) {
        console.error(
          "[GrillRunner] No TaskClient registered — cannot create LucidTask " +
          `"${title}". Import bin/wire-queue-task-integration.ts before calling splitTask.`,
        );
        throw new Error("GrillRunner: TaskClient not registered — cannot create LucidTask");
      }
      // Verbatim title (no AI rewriting) — matches TaskClient.createTask's
      // `--no-ai` contract (see QueueTaskIntegration.ts's TaskClient doc).
      return client.createTask(title, {
        ...(opts?.lucidParentId ? { parentId: opts.lucidParentId } : {}),
        description,
      });
    });

  const archive = deps?.archive ?? (async (itemId: string) => qm.remove(itemId));

  // Context for every child (Jm's ruling: a task must carry or link its
  // context). The parent queue item is archived below, so the spec path and
  // the inspect command are the child's only way back to the source material.
  const parent = deps?.createTask ? null : await qm.get(id);
  const contextLinks = [
    `queue item ${id}${parent ? ` ("${parent.payload.title}")` : ""}`,
    ...(parent?.payload.spec?.path ? [`spec: ${parent.payload.spec.path}`] : []),
    ...(opts?.lucidParentId ? [`parent task ${opts.lucidParentId}`] : []),
    `Inspect: bun ~/.claude/skills/Automation/QueueRouter/Tools/CLI.ts get ${id}`,
  ];

  // Create all child tasks first, then archive parent
  const childIds: string[] = [];
  for (const title of subtaskTitles) {
    const description =
      `WHAT: ${title} (split from queue item ${id}; siblings: ${subtaskTitles.filter((t) => t !== title).join(" / ") || "none"})\n` +
      `CONTEXT: ${contextLinks.join(" | ")}`;
    const childId = await createTask(title, description);
    childIds.push(childId);
  }

  // Archive parent after children are created
  await archive(id);

  return {
    ok: true,
    childIds,
    message: `Created ${childIds.length} subtasks from item ${id}; parent archived`,
  };
}

// ============================================================================
// 5. deferTask
// ============================================================================

/**
 * Defer a parked item by moving it back to `awaiting-context` with deferUntil metadata.
 *
 * @param id   - Spec-pipeline item ID (must be in needs-grilling)
 * @param opts - Optional until: ISO date string
 */
export async function deferTask(
  id: string,
  opts?: { until?: string }
): Promise<DeferResult> {
  const qm = getQm();

  const deferUntil = opts?.until ?? null;
  const deferredAt = new Date().toISOString();

  const updated = await qm.updateSpecPipelineStatus(
    id,
    "awaiting-context",
    undefined,
    { deferUntil, deferredAt }
  );

  if (!updated) {
    return { ok: false, message: `Item ${id} not found in spec-pipeline` };
  }

  return {
    ok: true,
    message: `Item ${id} deferred${deferUntil ? ` until ${deferUntil}` : ""}`,
  };
}

// ============================================================================
// 6. draftFindings — G3: LLM-draft findings from an interview transcript
// ============================================================================

/**
 * Verbatim copy of the template in `Workflows/GrillTask.md` Step 4 — the ONLY
 * source of truth for "the format finalizeGrillToSpec --findings expects".
 * Keep these in sync; a mismatch here silently degrades draft quality (the
 * VERDICT line the LLM emits still satisfies parseResearchVerdict's regex
 * either way, but the other sections stop matching what a human-written
 * findings file looks like).
 */
const FINDINGS_TEMPLATE = `# Research Findings: <item title>

**Item ID:** <id>
**Researched At:** <ISO timestamp>
**Research Method:** Interactive grill session (GrillWithDocs) — findings drafted by \`grill draft-findings\` from the interview transcript, reviewed and confirmed by Jm before finalize.

---

## Premise Verification

- [RESOLVED] <claim> — confirmed in <file>:<line>
- [NEEDS_INPUT: <question>] <open point that required a human decision — record Jm's answer>

## Atomic Outcomes

1. <Deliverable — specific and measurable>

## Acceptance Criteria

- <What "done" looks like, measurable>

## Verification Methods

- <How to confirm each criterion — test / existence / runtime / manual>

## Dependencies and Risks

- <Dependency or risk>

## Scope Constraints

In scope: <explicit in-scope items>
Out of scope: <explicit exclusions>

---

## VERDICT: implement | skip | defer
- Reason: <one sentence>
- Scope estimate: small (<1hr) | medium (1-4hr) | large (4hr+)`;

const DRAFT_FINDINGS_SYSTEM_PROMPT = `You are drafting a grill research findings document from a completed interactive interview transcript between Jm and an interviewer. This file is fed directly into "grill finalize --findings <path>", which requires the exact template structure below (especially the VERDICT line) to route the item through the spec pipeline. Base every claim strictly on the transcript and item description — do not invent facts. Where the transcript leaves something unresolved, use [NEEDS_INPUT: ...] rather than guessing. Output ONLY the filled-in template — no preamble, no commentary before or after it.`;

/**
 * Build the drafting prompt. Pure — exported for tests.
 */
export function buildDraftFindingsPrompt(
  item: { id: string; title: string; description?: string },
  transcript: string
): string {
  return `## Item

Item ID: ${item.id}
Title: ${item.title}
Description: ${item.description ?? ""}

## Interview Transcript

${transcript}

## Task

Synthesize the transcript above into a grill research findings document. Fill in every bracketed placeholder in the template below using ONLY information present in the transcript/description — reproduce every heading exactly as shown, and end with the required VERDICT line. The **Item ID:** field is ALREADY KNOWN (given above as "Item ID") — copy it verbatim, it is never a [NEEDS_INPUT] gap.

${FINDINGS_TEMPLATE}`;
}

/** Minimal shape draftFindings needs from an inference call — decoupled from the full InferenceResult so tests don't have to fake unrelated fields (tokens, cost, latency). lib/core/Inference.ts's `inference()` satisfies this directly. */
export type DraftFindingsInferFn = (opts: {
  systemPrompt: string;
  userPrompt: string;
  level: "standard";
  timeout: number;
}) => Promise<{ success: boolean; output: string; error?: string }>;

/** Injectable deps for draftFindings */
export interface DraftFindingsDeps {
  /** Runs the drafting inference call. Defaults to lib/core/Inference.ts inference(). */
  infer?: DraftFindingsInferFn;
}

/** Result returned by draftFindings */
export interface DraftFindingsResult {
  ok: boolean;
  itemId: string;
  /** The drafted findings markdown (empty string on failure). */
  draft: string;
  message: string;
}

/** Generous — full 9-section findings drafts can run long; matches spec-gen's own standard-tier cap. */
const DRAFT_FINDINGS_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Draft a findings artifact from an interview transcript via ONE inference()
 * call, in the exact format `finalizeGrillToSpec --findings` expects (see
 * FINDINGS_TEMPLATE, sourced verbatim from GrillTask.md Step 4).
 *
 * Draft-only: this function NEVER writes the artifact to disk, never calls
 * attachContext/process/finalize, and never mutates the item. It exists so
 * Jm can review (and edit) the draft before deciding whether to save it and
 * finalize — the human confirmation gate stays intact.
 *
 * @param id         - Spec-pipeline item ID (must exist; any status is fine —
 *                     this is a pure read + inference call, no status check).
 * @param transcript - The interview transcript / notes to synthesize from.
 * @param deps       - Injectable dependencies (default: real inference()).
 */
export async function draftFindings(
  id: string,
  transcript: string,
  deps?: DraftFindingsDeps
): Promise<DraftFindingsResult> {
  const items = loadQueueItems("spec-pipeline");
  const item = items.find((i) => i.id === id);
  if (!item) {
    return { ok: false, itemId: id, draft: "", message: `Item ${id} not found in spec-pipeline` };
  }

  if (!transcript || !transcript.trim()) {
    return { ok: false, itemId: id, draft: "", message: "Empty transcript — nothing to draft findings from." };
  }

  const infer = deps?.infer ?? inference;
  const userPrompt = buildDraftFindingsPrompt(
    { id: item.id, title: item.payload.title, description: item.payload.description },
    transcript
  );

  let result: { success: boolean; output: string; error?: string };
  try {
    result = await infer({
      systemPrompt: DRAFT_FINDINGS_SYSTEM_PROMPT,
      userPrompt,
      level: "standard",
      timeout: DRAFT_FINDINGS_TIMEOUT_MS,
    });
  } catch (err) {
    return {
      ok: false,
      itemId: id,
      draft: "",
      message: `draft-findings inference threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!result.success || !result.output.trim()) {
    return {
      ok: false,
      itemId: id,
      draft: "",
      message: `draft-findings inference failed: ${result.error ?? "empty output"}`,
    };
  }

  return {
    ok: true,
    itemId: id,
    draft: result.output.trim(),
    message: "Draft generated — review before saving and running grill finalize --findings.",
  };
}

// ============================================================================
// CLI Entry (optional — main subcommands live in CLI.ts "grill" case)
// ============================================================================

if (import.meta.main) {
  // Wire the QueueRouter <-> LucidTasks seam before any subcommand runs —
  // kill/split need a registered TaskClient (see lib/interfaces/QueueTaskIntegration.ts).
  await import("../../../../bin/wire-queue-task-integration.ts");

  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help") {
    console.log(`
GrillRunner — subcommands (used by CLI.ts "grill" case)

  list [--limit N]
  next
  finalize <id> --notes "..." --research "..." [--scope "..."] [--findings <path>] [--deep-research]
  kill <id> [--lucid <lucidTaskId>]
  split <id> --titles "a|b|c" [--lucid <parentLtid>]
  defer <id> [--until <iso>]
`);
    process.exit(0);
  }

  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  switch (cmd) {
    case "list": {
      const limit = getArg("limit") ? parseInt(getArg("limit")!) : 5;
      const items = listParkedForGrill(limit);
      const total = getGrillBacklogSummary().total;
      if (items.length === 0) {
        console.log("No items parked for grill.");
      } else {
        console.log(`Parked for Grill (${formatBacklogLabel(items.length, total)}):\n`);
        for (const item of items) {
          const brief = getGrillBrief(item);
          console.log(`  ${item.id}  ${item.payload.title}  [priority:${item.priority}]`);
          if (brief.suggestedQuestions.length) {
            for (const q of brief.suggestedQuestions) {
              console.log(`    ? ${q}`);
            }
          }
        }
      }
      break;
    }

    case "next": {
      // Display-only: auto-selects the oldest-waiting item and prints its
      // grill brief. Never writes/mutates queue state — safe to run anytime.
      const summary = getGrillBacklogSummary();
      if (!summary.topItem) {
        console.log("No items parked for grill.");
        break;
      }
      console.log(`${summary.total} waiting, oldest ${Math.round(summary.oldestAgeDays)} days\n`);
      console.log(`Selected: ${summary.topItem.id}  ${summary.topItem.title}`);
      console.log(`Why: ${summary.topItem.whyTop}\n`);
      const brief = getGrillBriefForId(summary.topItem.id);
      if (brief?.missing.length) {
        console.log(`Missing: ${brief.missing.join("; ")}`);
      }
      if (brief?.suggestedQuestions.length) {
        for (const q of brief.suggestedQuestions) {
          console.log(`  ? ${q}`);
        }
      }
      break;
    }

    case "finalize": {
      const id = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      const notes = getArg("notes");
      const research = getArg("research");
      const scope = getArg("scope");
      const findings = getArg("findings");
      const deepResearch = args.includes("--deep-research");
      if (!id || !notes || !research) {
        console.error("Usage: finalize <id> --notes \"...\" --research \"...\" [--scope \"...\"] [--findings <path>] [--deep-research]");
        process.exit(1);
      }
      finalizeGrillToSpec(id, { notes, researchGuidance: research, scopeHints: scope, findingsPath: findings, deepResearch })
        .then((r) => {
          console.log(r.ok ? `Finalized: ${r.status}` : `Failed: ${r.message}`);
          if (r.specPath) console.log(`Spec: ${r.specPath}`);
        })
        .catch((e) => { console.error(`Error: ${e}`); process.exit(1); });
      break;
    }

    case "kill": {
      const id = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      const lucidTaskId = getArg("lucid");
      if (!id) { console.error("Usage: kill <id> [--lucid <ltid>]"); process.exit(1); }
      killTask(id, { lucidTaskId })
        .then((r) => console.log(r.ok ? r.message : `Failed: ${r.message}`))
        .catch((e) => { console.error(`Error: ${e}`); process.exit(1); });
      break;
    }

    case "split": {
      const id = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      const titlesRaw = getArg("titles");
      const lucidParentId = getArg("lucid");
      if (!id || !titlesRaw) { console.error("Usage: split <id> --titles \"a|b|c\""); process.exit(1); }
      const titles = titlesRaw.split("|").map((s) => s.trim()).filter(Boolean);
      splitTask(id, titles, { lucidParentId })
        .then((r) => {
          console.log(r.ok ? r.message : `Failed: ${r.message}`);
          if (r.childIds.length) console.log(`Child IDs: ${r.childIds.join(", ")}`);
        })
        .catch((e) => { console.error(`Error: ${e}`); process.exit(1); });
      break;
    }

    case "defer": {
      const id = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      const until = getArg("until");
      if (!id) { console.error("Usage: defer <id> [--until <iso>]"); process.exit(1); }
      deferTask(id, { until })
        .then((r) => console.log(r.ok ? r.message : `Failed: ${r.message}`))
        .catch((e) => { console.error(`Error: ${e}`); process.exit(1); });
      break;
    }

    default:
      console.error(`Unknown subcommand: ${cmd}`);
      process.exit(1);
  }
}
