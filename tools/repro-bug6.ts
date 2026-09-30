#!/usr/bin/env bun
/**
 * repro-bug6.ts — Reproduction script for Bug 6: Context re-injection on turn 2
 *
 * Simulates two consecutive UserPromptSubmit hook invocations with the same
 * session_id and a development-profile prompt. Turn 1 should inject context.
 * Turn 2 should produce zero stdout (no new files).
 *
 * Run:  bun ~/.claude/tools/repro-bug6.ts
 */

import { spawn } from 'bun';
import { join } from 'path';

const HOOK = '~/.claude/hooks/ContextRouter.hook.ts';
const SESSION_ID = `repro-bug6-${Date.now()}`;
const PROMPT = 'implement a new TypeScript function for parsing config files';

async function runHook(label: string, sessionId: string, prompt: string): Promise<{ stdout: string; stderr: string }> {
  const input = JSON.stringify({ session_id: sessionId, prompt });

  const proc = spawn({
    cmd: ['bun', HOOK],
    stdin: new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  console.error(`\n=== ${label} ===`);
  console.error(`STDERR:\n${stderr.trim()}`);
  console.error(`STDOUT (${stdout.length} chars):\n${stdout.length > 0 ? stdout.slice(0, 300) + (stdout.length > 300 ? '...' : '') : '<EMPTY>'}`);

  return { stdout, stderr };
}

async function main() {
  console.error(`[repro-bug6] Using session_id: ${SESSION_ID}`);
  console.error(`[repro-bug6] Prompt: ${PROMPT}`);

  // Turn 1
  const turn1 = await runHook('TURN 1 (should inject context)', SESSION_ID, PROMPT);

  // Brief pause (simulates real inter-message latency)
  await Bun.sleep(200);

  // Turn 2 — same session, same prompt
  const turn2 = await runHook('TURN 2 (should be SILENT / empty stdout)', SESSION_ID, PROMPT);

  // Summary
  console.error('\n=== SUMMARY ===');
  console.error(`Turn 1 stdout: ${turn1.stdout.length} chars — ${turn1.stdout.length > 0 ? 'INJECTED (expected)' : 'SILENT (unexpected)'}`);
  console.error(`Turn 2 stdout: ${turn2.stdout.length} chars — ${turn2.stdout.length === 0 ? 'SILENT (correct)' : 'INJECTED (BUG: re-injected!)'}`);

  const bugReproduced = turn2.stdout.length > 0;
  console.error(`\nBug reproduced: ${bugReproduced ? 'YES ✗' : 'NO ✓'}`);

  process.exit(bugReproduced ? 1 : 0);
}

main();
