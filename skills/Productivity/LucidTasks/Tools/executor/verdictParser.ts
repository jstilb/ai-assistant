#!/usr/bin/env bun
/**
 * verdictParser.ts — Extract and validate the EXECUTOR_VERDICT block from agent stdout.
 *
 * The agent (now a general work executor, not a research-only agent) is required to emit:
 *   EXECUTOR_VERDICT_START
 *   {"headline": "...", "summary": "...", "deliverables": ["<path>", ...], "check": "...", "forJm": ["..."]}
 *   EXECUTOR_VERDICT_END
 *
 * `summary` is the only REQUIRED field — a human-readable account of what was done, which
 * Jm reviews on the board. The Task Outcome Card fields are all optional and never fail the run:
 *   - `headline`     one plain sentence for Jm (<= HEADLINE_TARGET chars). When missing/blank it
 *                    is derived from the summary's first sentence and `headlineDerived` is true.
 *   - `deliverables` the main files Jm should open first (repo-relative or absolute).
 *   - `check`        one command or step Jm can run to see it works.
 *   - `forJm`        items that need Jm's decision or action (each becomes a task for Jm).
 * `artifacts` (legacy) is a list of external files the agent wrote (e.g. an Obsidian note).
 * Repo code changes live on the executor's worktree branch and are captured by the executor
 * itself, so the agent does not have to report them here.
 *
 * Returns null on ANY failure (markers absent, malformed JSON, missing/empty summary).
 * NEVER returns a default/empty object — null is the hard failure signal.
 * (Avoids the AutoInfo success:true-on-unparseable anti-pattern.)
 *
 * Backward-compat: a legacy `{notePath, summary}` verdict still parses — notePath is folded
 * into artifacts so old research-style deliverables keep producing a wikilink. Legacy
 * `artifacts` and `notePath` are also merged into `deliverables` (deduped).
 */

import { HEADLINE_TARGET } from "../TaskOutcome.ts";

export interface ExecutorVerdict {
  summary: string;
  /** External files the agent wrote (absolute paths). Always an array; [] if none. */
  artifacts: string[];
  /** One plain sentence for Jm. Never empty (derived from the summary when the agent gave none). */
  headline: string;
  /** True when `headline` was derived from the summary rather than written by the agent. */
  headlineDerived: boolean;
  /** Main files Jm should open first: `deliverables` + legacy artifacts/notePath, deduped. */
  deliverables: string[];
  /** One command or step for Jm to check the work. Absent when the agent gave none. */
  check?: string;
  /** Items that need Jm's decision or action. Always an array; [] if none. */
  forJm: string[];
  /** How many items the caps removed (0 = nothing lost). The caller logs a non-zero count. */
  dropped: { deliverables: number; forJm: number };
}

/** Caps: the prompt asks for 1-5 deliverables; OutcomeSchema allows at most 20 forJm items. */
const MAX_DELIVERABLES = 5;
const MAX_FOR_JM = 20;

const START_MARKER = "EXECUTOR_VERDICT_START";
const END_MARKER = "EXECUTOR_VERDICT_END";

function normalizeArtifacts(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((a): a is string => typeof a === "string" && a.trim().length > 0)
      .map((a) => a.trim());
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    return [raw.trim()];
  }
  return [];
}

/**
 * Derive a headline from a summary: its first sentence (or first line), markdown markers
 * stripped, trimmed to HEADLINE_TARGET chars with an ellipsis. Pure — exported for tests and
 * for callers that deliver without a parsed verdict.
 */
export function deriveHeadline(summary: string): string {
  const firstLine =
    summary
      .split("\n")
      .map((l) => l.replace(/^[\s#>*-]+/, "").trim())
      .find((l) => l.length > 0) ?? summary.trim();
  const sentence = firstLine.split(/(?<=[.!?])\s/, 1)[0].trim();
  if (sentence.length <= HEADLINE_TARGET) return sentence;
  return sentence.slice(0, HEADLINE_TARGET - 1).trimEnd() + "…";
}

/**
 * Parse the verdict block from agent stdout.
 * Returns null on ANY parse or validation failure.
 */
export function parseVerdict(stdout: string): ExecutorVerdict | null {
  if (!stdout || stdout.trim().length === 0) return null;

  const startIdx = stdout.indexOf(START_MARKER);
  if (startIdx === -1) return null;

  const endIdx = stdout.indexOf(END_MARKER, startIdx + START_MARKER.length);
  if (endIdx === -1) return null;

  const raw = stdout.slice(startIdx + START_MARKER.length, endIdx).trim();
  if (raw.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;

  const summary = obj.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) return null;

  const artifacts = normalizeArtifacts(obj.artifacts);

  // Legacy {notePath, summary} verdicts: fold notePath into artifacts (dedup).
  if (typeof obj.notePath === "string" && obj.notePath.trim().length > 0) {
    const notePath = obj.notePath.trim();
    if (!artifacts.includes(notePath)) artifacts.unshift(notePath);
  }

  const trimmedSummary = summary.trim();
  const rawHeadline = typeof obj.headline === "string" ? obj.headline.trim() : "";
  const deliverables = normalizeArtifacts(obj.deliverables);
  for (const a of artifacts) if (!deliverables.includes(a)) deliverables.push(a);
  const check = typeof obj.check === "string" && obj.check.trim().length > 0 ? obj.check.trim() : undefined;

  const forJm = normalizeArtifacts(obj.forJm);

  return {
    summary: trimmedSummary,
    artifacts,
    headline: rawHeadline || deriveHeadline(trimmedSummary),
    headlineDerived: rawHeadline.length === 0,
    deliverables: deliverables.slice(0, MAX_DELIVERABLES),
    ...(check ? { check } : {}),
    forJm: forJm.slice(0, MAX_FOR_JM),
    dropped: {
      deliverables: Math.max(0, deliverables.length - MAX_DELIVERABLES),
      forJm: Math.max(0, forJm.length - MAX_FOR_JM),
    },
  };
}
