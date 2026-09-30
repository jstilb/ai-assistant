#!/usr/bin/env bun
/**
 * IntentReader.ts — read `USER/YouTubeIntent.yaml` (current curation intent).
 *
 * Current-state-only file: `topics` (free-text strings) + `declared_at`
 * (spec.md §2). No in-file history — git history of the auto-committed repo
 * is the archive. The file won't exist until Jm's first `/youtube steer`
 * declare, so a missing/malformed file degrades to "no intent declared"
 * rather than throwing — every other mode (status, preview, prune) must be
 * able to run before any intent has ever been set.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

export interface YouTubeIntent {
  topics: string[];
  /** ISO date/time as declared, verbatim. */
  declaredAt: string;
}

export interface IntentReadResult {
  intent: YouTubeIntent | null;
  /** Human-readable reason when `intent` is null (missing/malformed/absent). */
  note: string | null;
}

/**
 * Resolved per call, not module-level — a module-level const would pin the
 * first import's KAYA_HOME for the whole process, breaking test sandboxes
 * that repoint it between imports (see WigTargets.ts's defaultWigStatusPath
 * for the same reasoning).
 */
export function defaultIntentPath(): string {
  return join(getKayaHome(), "USER", "YouTubeIntent.yaml");
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");
}

/**
 * Read + validate `USER/YouTubeIntent.yaml`. Never throws — degrades to
 * `{ intent: null, note }` on any missing/malformed/unreadable input.
 */
export function readIntent(path?: string): IntentReadResult {
  const intentPath = path ?? defaultIntentPath();
  if (!existsSync(intentPath)) {
    return { intent: null, note: "no intent declared" };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(intentPath, "utf8"));
  } catch {
    return { intent: null, note: "YouTubeIntent.yaml is malformed — treating as no intent declared" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { intent: null, note: "YouTubeIntent.yaml is malformed — treating as no intent declared" };
  }

  const obj = parsed as Record<string, unknown>;
  if (!isStringArray(obj.topics) || typeof obj.declared_at !== "string") {
    return {
      intent: null,
      note: "YouTubeIntent.yaml is missing topics/declared_at — treating as no intent declared",
    };
  }

  return { intent: { topics: obj.topics, declaredAt: obj.declared_at }, note: null };
}
