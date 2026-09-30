#!/usr/bin/env bun
/**
 * FollowOnLoops.ts — comprehension-driven "what's next" at the plan→build seam.
 *
 * A multi-phase spec routinely implements only Phase 1 (a thin vertical slice) now
 * and DEFERS later phases. Nothing re-queued that deferred work, so it was orphaned —
 * the "scope keeps shrinking" class (see memory
 * project_followon_engine_never_fires_deferred_orphaned).
 *
 * The fix is NOT a deterministic parser deciding next steps from prose — that was the
 * rejected instinct (determinism at the *interpretation* layer; the same brittleness as
 * reverse-parsing free-form markdown). Instead, when a work item VERIFIES + completes,
 * an LLM READS the spec and decides what follow-on work genuinely remains. The only
 * determinism that earns its place at this seam is the TRIGGER (reportDone calling this)
 * and the enqueue plumbing/gating in WorkOrchestrator.enqueueNextFollowOn — never the
 * interpretation. See memory project_determinism_must_earn_its_place.
 *
 * Two declaration sources, both consumed by WorkOrchestrator.enqueueNextFollowOn:
 *   1. Structured (explicit author/agent declaration): item.metadata.followOnLoops —
 *      a literal list carried forward loop-by-loop; used as-is, no interpretation.
 *   2. Spec comprehension (this module): deriveFollowOnFromSpec() asks an LLM to read
 *      the spec markdown — including any human-readable `## Follow-On Loops` section the
 *      spec generator emitted — and return the phases that remain to be built.
 */

import { existsSync, readFileSync } from "fs";
import { inference, extractJson, type InferenceResult } from "../../../../lib/core/Inference.ts";
import { logFailure } from "../../../../lib/core/FailureLog.ts";

export interface FollowOnLoop {
  /** Title for the next loop's work item. */
  title: string;
  /** Optional spec path for the next loop (resolved relative to KAYA_HOME if not absolute). */
  specPath?: string;
  /** Optional description override. */
  description?: string;
}

/**
 * Injectable inference fn — lets tests drive the comprehension deterministically
 * without spawning a real model. Mirrors the relevant slice of inference()'s options.
 */
export type InferFn = (args: {
  systemPrompt: string;
  userPrompt: string;
  level?: "fast" | "standard" | "smart";
  timeout?: number;
}) => Promise<InferenceResult>;

const SYSTEM_PROMPT =
  "You read a just-completed work specification and identify the follow-on work it deliberately " +
  "DEFERRED to later phases/loops. You report only what genuinely remains to be built — never work " +
  "the spec already delivered, and never invented scope.";

function buildUserPrompt(specContent: string, ctx?: { title?: string }): string {
  return `A work item${ctx?.title ? ` ("${ctx.title}")` : ""} just verified and completed. Below is its spec.

Specs commonly implement only Phase 1 (or a subset) now and DEFER later phases. Your job: decide which follow-on work items should be queued NEXT so the deferred work is not orphaned at the plan→build seam.

Read the spec — especially any "## Follow-On Loops", "Deferred", "Phase 2"/"Phase 3", or "Future"/"Next" markers — and judge what ACTUALLY remains to build beyond what this item delivered. If the spec implemented everything and nothing was deferred, there is no follow-on work.

Return ONLY a JSON array (no prose). Each element is {"title": string, "specPath"?: string}:
  - "title": a concrete next work item (e.g. "KayaScheduler Phase 2 — recurring demand").
  - "specPath": the deferred phase's spec file, ONLY if the spec explicitly names one.
Return [] when the spec was fully delivered with nothing deferred.

SPEC:
${specContent}`;
}

/**
 * Ask an LLM to read the spec and return the follow-on work that remains.
 *
 * Returns [] (never throws) when there is no spec, the inference call fails, or the
 * output is unparseable. The caller (enqueueNextFollowOn) is fail-open by design — a
 * follow-on failure must never block a verified item's completion — so the contract
 * here is: emit a LOUD warning and yield no follow-on rather than silently inventing
 * one or swallowing the failure.
 */
export async function deriveFollowOnFromSpec(
  specPath?: string,
  ctx?: { title?: string; infer?: InferFn },
): Promise<FollowOnLoop[]> {
  if (!specPath || !existsSync(specPath)) return [];

  let specContent: string;
  try {
    specContent = readFileSync(specPath, "utf-8");
  } catch {
    return [];
  }
  if (!specContent.trim()) return [];

  const infer: InferFn = ctx?.infer ?? ((args) => inference(args));

  let result: InferenceResult;
  try {
    result = await infer({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(specContent, { title: ctx?.title }),
      level: "fast",
      timeout: 90 * 1000,
    });
  } catch (e) {
    console.warn(
      `[FollowOnLoops] deriveFollowOnFromSpec inference threw for ${specPath} ` +
        `(treating as no follow-on): ${e instanceof Error ? e.message : String(e)}`,
    );
    // S6: a silently-dropped deferred phase is the false-confidence failure mode — log durably.
    logFailure("FollowOnLoops:deriveFollowOnFromSpec", e, { specPath, reason: "inference threw" });
    return [];
  }

  if (!result.success || !result.output?.trim()) {
    console.warn(
      `[FollowOnLoops] deriveFollowOnFromSpec got no usable output for ${specPath} ` +
        `(treating as no follow-on).`,
    );
    logFailure("FollowOnLoops:deriveFollowOnFromSpec", new Error("no usable inference output"), { specPath });
    return [];
  }

  const parsed = extractJson(result.output);
  if (!Array.isArray(parsed)) {
    console.warn(
      `[FollowOnLoops] deriveFollowOnFromSpec output was not a JSON array for ${specPath} ` +
        `(treating as no follow-on).`,
    );
    logFailure("FollowOnLoops:deriveFollowOnFromSpec", new Error("inference output was not a JSON array"), { specPath });
    return [];
  }

  const loops: FollowOnLoop[] = [];
  for (const el of parsed) {
    if (!el || typeof el !== "object") continue;
    const o = el as Record<string, unknown>;
    if (typeof o.title !== "string" || !o.title.trim()) continue;
    const title = o.title.trim();
    loops.push(
      typeof o.specPath === "string" && o.specPath.trim()
        ? { title, specPath: o.specPath.trim() }
        : { title },
    );
  }
  return loops;
}
