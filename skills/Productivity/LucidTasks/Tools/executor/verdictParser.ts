#!/usr/bin/env bun
/**
 * verdictParser.ts — Extract and validate the EXECUTOR_VERDICT block from agent stdout.
 *
 * The agent (now a general work executor, not a research-only agent) is required to emit:
 *   EXECUTOR_VERDICT_START
 *   {"summary": "...", "artifacts": ["<path>", ...]}
 *   EXECUTOR_VERDICT_END
 *
 * `summary` is the only REQUIRED field — a human-readable account of what was done, which
 * Jm reviews on the board. `artifacts` is optional: a list of external files the agent wrote
 * (e.g. an Obsidian note). Repo code changes live on the executor's worktree branch and are
 * captured by the executor itself, so the agent does not report them here.
 *
 * Returns null on ANY failure (markers absent, malformed JSON, missing/empty summary).
 * NEVER returns a default/empty object — null is the hard failure signal.
 * (Avoids the AutoInfo success:true-on-unparseable anti-pattern.)
 *
 * Backward-compat: a legacy `{notePath, summary}` verdict still parses — notePath is folded
 * into artifacts so old research-style deliverables keep producing a wikilink.
 */

export interface ExecutorVerdict {
  summary: string;
  /** External files the agent wrote (absolute paths). Always an array; [] if none. */
  artifacts: string[];
}

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

  return {
    summary: summary.trim(),
    artifacts,
  };
}
