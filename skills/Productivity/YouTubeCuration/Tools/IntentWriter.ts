#!/usr/bin/env bun
/**
 * IntentWriter.ts — write CONFIRMED topics to `USER/YouTubeIntent.yaml`
 * (`/youtube steer <prose>`, write half only).
 *
 * WRITE-ONLY, by construction: this module takes `topics: string[]` and
 * never touches the inference seam (no import of `IntentParser.ts` or
 * `lib/core/Inference.ts` anywhere here) — it has no way to turn prose into
 * topics itself. Combined with `IntentParser.ts` never writing, no single
 * tool invocation in this pair can both parse AND write; the caller (the
 * `/youtube steer` command flow) must have already echoed the parsed topics
 * to Jm and gotten confirmation before calling `writeIntent()`.
 *
 * Current-state-only file (spec.md §2, §7): exactly `topics` (string[]) +
 * `declared_at` (ISO timestamp). No in-file history — git history of the
 * auto-committed repo is the archive. Every write REPLACES the whole file;
 * there is no merge/append path anywhere in this module, so "a new
 * declaration replaces the whole topic list" (spec.md §7) holds structurally,
 * not by convention.
 *
 * Path resolution reuses `IntentReader.ts`'s `defaultIntentPath()` directly
 * (rather than re-deriving `join(getKayaHome(), "USER", "YouTubeIntent.yaml")`
 * independently) so the writer and reader can never drift out of sync on
 * where the file lives.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify } from "yaml";
import { defaultIntentPath } from "./IntentReader.ts";

export interface WriteIntentOptions {
  /** Overrides the resolved write path — tests pass a mkdtemp path here,
   *  never the live tree or the worktree's own USER/. */
  path?: string;
  /** Injectable clock for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
}

export interface WriteIntentResult {
  path: string;
  topics: string[];
  declaredAt: string;
}

/**
 * Write confirmed topics as the new (total-replacement) intent state.
 * Throws on an empty/blank topic list rather than silently writing a
 * meaningless file — fail loud, no silent containment.
 */
export function writeIntent(topics: string[], options: WriteIntentOptions = {}): WriteIntentResult {
  const cleaned = topics.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) {
    throw new Error("IntentWriter: refusing to write an empty topic list");
  }

  const intentPath = options.path ?? defaultIntentPath();
  const declaredAt = (options.now ?? new Date()).toISOString();

  mkdirSync(dirname(intentPath), { recursive: true });
  const yaml = stringify({ topics: cleaned, declared_at: declaredAt });
  writeFileSync(intentPath, yaml, "utf8");

  return { path: intentPath, topics: cleaned, declaredAt };
}

async function main(): Promise<void> {
  const topics = process.argv.slice(2);
  if (topics.length === 0) {
    console.error('Usage: bun IntentWriter.ts "topic one" "topic two" ...');
    console.error("Only call this with topics Jm has already confirmed (see IntentParser.ts for the parse step).");
    process.exit(1);
  }
  const result = writeIntent(topics);
  console.log(`Wrote ${result.topics.length} topic(s) to ${result.path} (declared_at ${result.declaredAt})`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
