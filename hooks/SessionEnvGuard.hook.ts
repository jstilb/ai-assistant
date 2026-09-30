#!/usr/bin/env bun
/**
 * SessionEnvGuard.hook.ts - Detect session-env contamination (SessionStart)
 *
 * PURPOSE:
 * Tripwire for the Terminal.app env-contamination failure mode found 2026-07-03:
 * if a terminal app is relaunched from inside a Claude session, every tab it
 * spawns exports CLAUDE_CODE_CHILD_SESSION=1 (plus a dead CLAUDE_CODE_SESSION_ID),
 * and any interactive `claude` launched there silently runs as a "child session" —
 * no history.jsonl writes, no transcript, invisible to `claude --resume`.
 * See memory project_terminal_env_contamination_child_sessions_20260703 and
 * upstream anthropics/claude-code #67603 / #73294.
 *
 * TRIGGER: SessionStart
 *
 * DETECTION:
 * This hook CANNOT check its own environment — Claude Code auto-sets
 * CLAUDE_CODE_CHILD_SESSION=1 on every hook subprocess, healthy or not.
 * Instead it walks up the process tree to the owning `claude` process and
 * inspects that process's EXEC-TIME environment via `ps eww` (macOS returns the
 * environment as it was at exec, which is exactly what the TUI inherited from
 * its shell). Contamination = the claude process is attached to a real tty
 * (interactive) AND its exec env contains CLAUDE_CODE_CHILD_SESSION=1.
 *
 * OUTPUT:
 * - stdout: loud <system-reminder> warning with rescue steps (added to context)
 * - AlertGate page, key "session-env-contamination", 24h default cooldown
 * - exit(0): Always — fail-open, never blocks session start
 *
 * PERFORMANCE:
 * - Non-blocking semantics, typical execution <100ms (a few ps calls)
 * - Skipped for subagents (CLAUDE_AGENT_TYPE set) and headless sessions (no tty)
 */

import { execSync } from 'child_process';
import { readObservabilityHookInput } from '../lib/hook-utils';

/** Real interactive terminals on macOS show as s000/ttys000; daemons show "??". */
export function isRealTty(tty: string): boolean {
  return /^(s[0-9]|ttys)/.test(tty.trim());
}

/** True when a `ps eww` output blob carries the child-session marker. */
export function envHasChildMarker(psEnvOutput: string): boolean {
  return /(^|\s)CLAUDE_CODE_CHILD_SESSION=1(\s|$)/.test(psEnvOutput);
}

/** True when a ps command field looks like the claude CLI itself. */
export function isClaudeCommand(command: string): boolean {
  return /(^|\/)claude( |$)/.test(command.trim());
}

export function buildWarning(claudePid: number, staleSessionId: string | null): string {
  const stale = staleSessionId ? ` (stale CLAUDE_CODE_SESSION_ID=${staleSessionId})` : '';
  return [
    '<system-reminder>',
    '🚨 SESSION ENV CONTAMINATION DETECTED (SessionEnvGuard)',
    `This interactive claude process (pid ${claudePid}) was launched from a shell whose`,
    `environment contains CLAUDE_CODE_CHILD_SESSION=1${stale}. This session is running as a`,
    '"child session": it will write NO history.jsonl entries, NO transcript, and will be',
    'INVISIBLE to `claude --resume`. Work done here cannot be resumed later.',
    '',
    'Tell Jm IMMEDIATELY, in your first response, to:',
    '1. Wrap up work in this tab (commit / write out anything worth keeping).',
    '2. Fully quit the terminal app (⌘Q) and relaunch it fresh from Dock/Spotlight —',
    '   NEVER from inside a Claude session.',
    '3. Verify with: bin/verify-session-persistence.sh',
    'Root cause: the terminal app was relaunched from inside a Claude session and froze',
    'its env. See memory project_terminal_env_contamination_child_sessions_20260703.',
    '</system-reminder>',
  ].join('\n');
}

function ps(args: string): string {
  try {
    return execSync(`ps ${args}`, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/**
 * Walk up from this hook process to the owning claude process.
 * Hooks may be spawned via an intermediate shell, so allow a few hops.
 */
function findOwningClaudePid(): number | null {
  let pid = process.ppid;
  for (let hop = 0; hop < 5 && pid > 1; hop++) {
    const command = ps(`-o command= -p ${pid}`);
    if (isClaudeCommand(command)) return pid;
    const ppidRaw = ps(`-o ppid= -p ${pid}`).trim();
    const ppid = Number.parseInt(ppidRaw, 10);
    if (!Number.isFinite(ppid) || ppid === pid) return null;
    pid = ppid;
  }
  return null;
}

/**
 * True when the current hook process is running inside a genuine
 * interactive session: `CLAUDE_AGENT_TYPE` is unset (not a subagent) AND
 * the owning `claude` process is attached to a real tty. Reuses the same
 * findOwningClaudePid()/ps()/isRealTty() resolution this file already does
 * for its own contamination check, so other hooks that need to skip
 * headless/subagent work (e.g. `hooks/handlers/ResponseCapture.ts`, gating
 * Stop notifications so headless runs don't pollute the SystemHealth
 * digest with junk rows — S5a) don't reimplement the process-tree walk.
 * This file guards its own `main()` with `import.meta.main`, so importing
 * this pure function from another module is safe (see module header note
 * and hooks/__tests__/session-env-guard.test.ts).
 */
export function isInteractiveSession(): boolean {
  if (process.env.CLAUDE_AGENT_TYPE !== undefined) return false;

  const claudePid = findOwningClaudePid();
  if (claudePid === null) return false;

  const tty = ps(`-o tty= -p ${claudePid}`);
  return isRealTty(tty);
}

async function main(): Promise<void> {
  try {
    // Drain stdin so the parent never blocks on a full pipe; content unused.
    await readObservabilityHookInput({ timeoutMs: 100 });

    // Subagents get their env from the parent session by design — not our signal.
    if (process.env.CLAUDE_AGENT_TYPE !== undefined) process.exit(0);

    const claudePid = findOwningClaudePid();
    if (claudePid === null) process.exit(0);

    // Headless (cron/claude -p/Bash-tool children) have no tty — being a child
    // session there is expected and correct.
    const tty = ps(`-o tty= -p ${claudePid}`);
    if (!isRealTty(tty)) process.exit(0);

    const execEnv = ps(`eww ${claudePid}`);
    if (!envHasChildMarker(execEnv)) process.exit(0);

    const staleSessionId = execEnv.match(/CLAUDE_CODE_SESSION_ID=([0-9a-f-]+)/)?.[1] ?? null;
    console.log(buildWarning(claudePid, staleSessionId));

    try {
      const { sendAlert } = await import('../lib/core/AlertGate');
      await sendAlert(
        `🚨 Kaya: interactive claude session (pid ${claudePid}) started with inherited ` +
          `CLAUDE_CODE_CHILD_SESSION=1 — it is NOT being persisted (no history, no transcript, ` +
          `no --resume). Quit the terminal app fully (⌘Q) and relaunch it from the Dock, then run ` +
          `bin/verify-session-persistence.sh.`,
        { key: 'session-env-contamination', tier: 'page' }
      );
    } catch (err) {
      // Alerting is best-effort; the in-context warning above already fired.
      console.error(`[SessionEnvGuard] failed to send AlertGate page for session contamination: ${err instanceof Error ? err.message : String(err)}`);
    }

    process.exit(0);
  } catch {
    process.exit(0); // Fail-open: never block session start.
  }
}

if (import.meta.main) {
  main();
}
