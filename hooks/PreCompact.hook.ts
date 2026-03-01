#!/usr/bin/env bun
/**
 * PreCompact.hook.ts - Pre-Compaction State Preservation
 *
 * PURPOSE:
 * Fires before Claude Code compresses the context window (compaction). Captures
 * critical session state — active work item, classification data, in-flight tool
 * calls — to MEMORY/STATE/ so that post-compaction context can be restored by
 * ContextRouter and AutoWorkCreation on the next turn.
 *
 * Without this hook, compaction silently discards all injected system-reminders,
 * meaning the next UserPromptSubmit sees a cold-start state even mid-session.
 *
 * TRIGGER: PreCompact (fires before Claude Code compresses the context)
 *
 * INPUT (stdin JSON):
 * - session_id: Current session identifier
 * - transcript_path: Path to the JSONL transcript
 * - hook_event_name: "PreCompact"
 *
 * OUTPUT:
 * - stdout: None (no context injection at this lifecycle event)
 * - stderr: Status messages for observability
 * - exit(0): Always (fail-open, compaction must not be blocked)
 *
 * SIDE EFFECTS:
 * - Writes MEMORY/STATE/pre-compact-state.json with:
 *   - session_id
 *   - active_work_dir (from current-work.json)
 *   - context_classification (from context-session.json)
 *   - compacted_at timestamp
 *
 * INTER-HOOK RELATIONSHIPS:
 * - COORDINATES WITH: ContextRouter (restores classification after compaction)
 * - COORDINATES WITH: AutoWorkCreation (preserves work dir reference)
 * - MUST COMPLETE BEFORE: Compaction proceeds (blocking lifecycle event)
 *
 * PERFORMANCE:
 * - File reads only — no inference, no network calls
 * - Target: <5ms (P99)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// ========================================
// Types
// ========================================

interface HookInput {
  session_id: string;
  transcript_path?: string;
  hook_event_name?: string;
}

interface PreCompactState {
  session_id: string;
  active_work_dir: string | null;
  context_classification: string | null;
  compacted_at: string;
}

// ========================================
// Helpers
// ========================================

function getKayaDir(): string {
  return process.env.KAYA_DIR ?? join(import.meta.dir, '..');
}

function readJsonSafe<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

// ========================================
// Main
// ========================================

async function main(): Promise<void> {
  const rawInput = await Bun.stdin.text();
  let input: HookInput = { session_id: 'unknown' };

  try {
    input = JSON.parse(rawInput || '{}') as HookInput;
  } catch {
    // Fail-open: malformed stdin should not block compaction
    process.exit(0);
  }

  const kayaDir = getKayaDir();
  const stateDir = join(kayaDir, 'MEMORY', 'State');

  // Ensure state dir exists
  if (!existsSync(stateDir)) {
    try {
      mkdirSync(stateDir, { recursive: true });
    } catch {
      process.exit(0);
    }
  }

  // Read active work dir from current-work.json
  const currentWork = readJsonSafe<{ work_dir?: string }>(
    join(stateDir, 'current-work.json'),
  );

  // Read last context classification from context-session.json
  const contextSession = readJsonSafe<{ classification?: string }>(
    join(stateDir, 'context-session.json'),
  );

  const state: PreCompactState = {
    session_id: input.session_id ?? 'unknown',
    active_work_dir: currentWork?.work_dir ?? null,
    context_classification: contextSession?.classification ?? null,
    compacted_at: new Date().toISOString(),
  };

  try {
    writeFileSync(
      join(stateDir, 'pre-compact-state.json'),
      JSON.stringify(state, null, 2),
    );
    console.error(`[PreCompact] State preserved for session ${state.session_id} (work_dir=${state.active_work_dir ?? 'none'}, class=${state.context_classification ?? 'none'})`);
  } catch (err) {
    console.error(`[PreCompact] Warning: could not write pre-compact state: ${err}`);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
