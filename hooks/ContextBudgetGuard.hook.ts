#!/usr/bin/env bun
/**
 * ContextBudgetGuard.hook.ts - Context Handoff Nudge (PostToolBatch, UserPromptSubmit)
 *
 * PURPOSE:
 * Main sessions run on the 1M window with compaction off (DISABLE_COMPACT=1).
 * Jm wants long work to move to a fresh session at 40-50% of the window, via
 * the Handoff skill. The model cannot see its own context fill, so this hook
 * measures it from the transcript and tells the model when to hand off.
 *
 * TRIGGER: PostToolBatch (once per batch of tool calls), UserPromptSubmit
 *
 * INPUT:
 * - stdin: hook JSON (session_id, transcript_path, hook_event_name, agent_id?)
 *
 * OUTPUT:
 * - stdout: { hookSpecificOutput: { hookEventName, additionalContext } } when a limit is passed
 * - exit(0): Always
 *
 * BEHAVIOR:
 * - Context = input + cache_read + cache_creation + output tokens of the latest
 *   main-chain assistant message (same sum as statusline-command.sh)
 * - >= SOFT_LIMIT_TOKENS (40% of 1M): one note per session (marker in os.tmpdir())
 * - >= HARD_LIMIT_TOKENS (50% of 1M): a note on every event
 *
 * SKIP CONDITIONS:
 * - KAYA_CONTEXT_GUARD_DISABLED=1
 * - Subagent events (agent_id present)
 * - No transcript, or no assistant usage in it yet
 *
 * PERFORMANCE:
 * - Non-blocking: Yes
 * - Reads the last 1MB of the transcript; whole file only if the tail has no usage
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readObservabilityHookInputSync } from '../lib/hook-utils.ts';

export const SOFT_LIMIT_TOKENS = 400_000;
export const HARD_LIMIT_TOKENS = 500_000;
const WINDOW_TOKENS = 1_000_000;
const TAIL_BYTES = 1024 * 1024;
const HANDOFF_SKILL = '~/.claude/skills/Automation/Handoff/SKILL.md';
const EVENTS = new Set(['PostToolBatch', 'UserPromptSubmit']);

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
  agent_id?: string;
}

interface Usage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

interface TranscriptEntry {
  type?: string;
  isSidechain?: boolean;
  message?: { model?: string; usage?: Usage };
}

/** Tokens in context after the latest main-chain assistant message, or null if none. */
export function latestContextTokens(jsonl: string): number | null {
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.includes('"usage"')) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    if (entry.type !== 'assistant' || entry.isSidechain === true) continue;
    const usage = entry.message?.usage;
    // <synthetic> entries (API errors, interrupts) carry zero usage.
    if (!usage || entry.message?.model === '<synthetic>') continue;
    const tokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.output_tokens ?? 0);
    if (tokens > 0) return tokens;
  }
  return null;
}

function readTail(path: string, bytes: number): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf-8');
    // Drop the first, partial line when the read did not start at the file head.
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } finally {
    closeSync(fd);
  }
}

export function readContextTokens(transcriptPath: string): number | null {
  return (
    latestContextTokens(readTail(transcriptPath, TAIL_BYTES)) ??
    latestContextTokens(readFileSync(transcriptPath, 'utf-8'))
  );
}

/** The note for this context size, or null when no note is due. */
export function budgetNote(tokens: number, softNoteSent: boolean): string | null {
  const used = `${Math.round((tokens / WINDOW_TOKENS) * 100)}% (${Math.round(tokens / 1000)}K of 1M tokens)`;
  if (tokens >= HARD_LIMIT_TOKENS) {
    return [
      `## Context budget: ${used}. Hand off now.`,
      'This session is past 50% of its context window. Start no new work here.',
      `Run the Handoff skill now: \`${HANDOFF_SKILL}\`.`,
      'If the handoff is done and the next session runs, end this session with your final report.',
    ].join('\n');
  }
  if (tokens >= SOFT_LIMIT_TOKENS && !softNoteSent) {
    return [
      `## Context budget: ${used}`,
      'This session passed 40% of its context window. Jm wants long work to continue in a fresh session.',
      '1. Take the current step to a clean point (no half-done edits).',
      `2. Then run the Handoff skill: \`${HANDOFF_SKILL}\`.`,
      'Do not start a new slice or a large task in this session.',
      'If the remaining work is one or two short turns, finish it here instead.',
    ].join('\n');
  }
  return null;
}

export function markerPath(sessionId: string): string {
  return join(tmpdir(), 'kaya-context-budget', `${sessionId.replace(/[^\w-]/g, '_')}.soft-noted`);
}

function main(): void {
  if (process.env.KAYA_CONTEXT_GUARD_DISABLED === '1') return;

  const input = readObservabilityHookInputSync<HookInput>();
  if (!input || input.agent_id) return;
  const { session_id: sessionId, transcript_path: transcriptPath, hook_event_name: event } = input;
  if (!sessionId || !transcriptPath || !event || !EVENTS.has(event)) return;
  if (!existsSync(transcriptPath)) return;

  const tokens = readContextTokens(transcriptPath);
  if (tokens === null) return;

  const marker = markerPath(sessionId);
  const note = budgetNote(tokens, existsSync(marker));
  if (!note) return;

  if (tokens < HARD_LIMIT_TOKENS) {
    mkdirSync(join(tmpdir(), 'kaya-context-budget'), { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()} ${tokens}\n`);
  }
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: note } }) + '\n',
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    // Fail open: a broken guard must never block a session. stderr shows in debug logs.
    console.error('[ContextBudgetGuard] error:', err);
  }
  process.exit(0);
}
