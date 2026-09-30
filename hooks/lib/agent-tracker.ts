/**
 * Agent Lifecycle Tracker
 *
 * Tracks active background subagents per session using a JSON state file.
 * Used by SubagentStart and SubagentStop hooks to determine when all
 * background agents have completed.
 *
 * State file: hooks/lib/.active-agents.json by default (relative to this
 * source file's own location); overridable via KAYA_HOME/KAYA_DIR for tests
 * (see resolveStateFilePath() below) — never overridden in production.
 * Format: { [session_id]: { [agent_id]: { type, description, startedAt } } }
 *
 * Concurrency: Uses atomic write (write-to-temp + rename) for safety.
 * Staleness: Entries older than 30 minutes are auto-pruned on read.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { getKayaHome, defaultKayaHome } from '../../lib/core/KayaHome.ts';

/**
 * State file path (T7-08.4 seam). Default, unchanged production behavior:
 * resolved relative to THIS source file's own on-disk location — so a
 * worktree checkout naturally gets its own copy, separate from the live
 * tree's, exactly as before this seam existed.
 *
 * Does NOT hand-roll an inline `KAYA_HOME`-or-`KAYA_DIR` env fallback
 * (banned by lib/lint/no-inline-kaya-home.ts) and deliberately does NOT
 * unconditionally redirect to getKayaHome() either: an ordinary Kaya
 * session shell exports KAYA_DIR pointing at the LIVE tree root even when
 * no test has overridden anything (confirmed live: `echo $KAYA_DIR` in this
 * worktree's own shell prints `~/.claude`, the live tree — NOT
 * this worktree's path). Since defaultKayaHome() resolves to that exact
 * same live-tree path, `getKayaHome() === defaultKayaHome()` is true in
 * that ordinary case, and ONLY differs when something has explicitly
 * pointed KAYA_HOME/KAYA_DIR somewhere else (a test's mkdtemp scratch dir).
 * That equality check is the seam: no hand-rolled env precedence, and a
 * worktree run with no test override still writes to its OWN copy of
 * `.active-agents.json`, never the live tree's — which is the registry this
 * seam exists to stop tests from clobbering (see the T7-08.4 handback
 * report for the incident). Re-read on every call (getKayaHome() itself is
 * cached-but-live per lib/core/KayaHome.ts's own doc comment), so a test can
 * set process.env.KAYA_HOME mid-run with no manual cache reset.
 */
function resolveStateFilePath(): string {
  const resolvedHome = getKayaHome();
  if (resolvedHome !== defaultKayaHome()) {
    return join(resolvedHome, 'hooks', 'lib', '.active-agents.json');
  }
  return join(dirname(new URL(import.meta.url).pathname), '.active-agents.json');
}

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

interface AgentEntry {
  type: string;
  description: string;
  startedAt: string; // ISO timestamp
  isBackground: boolean; // true = run_in_background agent
}

interface SessionAgents {
  [agentId: string]: AgentEntry;
}

interface TrackerState {
  [sessionId: string]: SessionAgents;
}

function readState(): TrackerState {
  const stateFile = resolveStateFilePath();
  try {
    if (!existsSync(stateFile)) return {};
    const raw = readFileSync(stateFile, 'utf-8');
    return JSON.parse(raw) as TrackerState;
  } catch {
    return {};
  }
}

function writeState(state: TrackerState): void {
  const stateFile = resolveStateFilePath();
  const dir = dirname(stateFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmp = stateFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, stateFile);
}

/** Remove entries older than STALE_THRESHOLD_MS */
function pruneStale(state: TrackerState): TrackerState {
  const now = Date.now();
  for (const sessionId of Object.keys(state)) {
    for (const agentId of Object.keys(state[sessionId])) {
      const entry = state[sessionId][agentId];
      if (now - new Date(entry.startedAt).getTime() > STALE_THRESHOLD_MS) {
        delete state[sessionId][agentId];
      }
    }
    if (Object.keys(state[sessionId]).length === 0) {
      delete state[sessionId];
    }
  }
  return state;
}

/**
 * Register an agent as active. isBackground defaults to true (conservative).
 * At start time we don't know if it's background, so we assume it is.
 * Foreground agents call markForeground() on stop to correct this before
 * unregistering, ensuring they aren't counted as remaining background siblings.
 */
export function registerAgent(
  sessionId: string,
  agentId: string,
  agentType: string,
  description: string,
  isBackground: boolean = true
): void {
  const state = pruneStale(readState());
  if (!state[sessionId]) state[sessionId] = {};
  state[sessionId][agentId] = {
    type: agentType,
    description,
    startedAt: new Date().toISOString(),
    isBackground,
  };
  writeState(state);
}

/** Mark an agent as foreground (called from SubagentStop for non-background agents) */
export function markForeground(
  sessionId: string,
  agentId: string
): void {
  const state = readState();
  if (state[sessionId]?.[agentId]) {
    state[sessionId][agentId].isBackground = false;
    writeState(state);
  }
}

/** Unregister an agent and return remaining *background* siblings only */
export function unregisterAgent(
  sessionId: string,
  agentId: string
): { remaining: AgentEntry[]; remainingCount: number } {
  const state = pruneStale(readState());

  if (state[sessionId]) {
    delete state[sessionId][agentId];
    // Only count background agents as remaining — foreground agents
    // block the turn and resolve before background ones return.
    const remaining = Object.values(state[sessionId]).filter(a => a.isBackground);
    if (Object.keys(state[sessionId]).length === 0) {
      delete state[sessionId];
    }
    writeState(state);
    return { remaining, remainingCount: remaining.length };
  }

  writeState(state);
  return { remaining: [], remainingCount: 0 };
}

/** Get all active agents for a session */
export function getActiveAgents(sessionId: string): { agents: SessionAgents; count: number } {
  const state = pruneStale(readState());
  const agents = state[sessionId] || {};
  return { agents, count: Object.keys(agents).length };
}

/**
 * Look up a single agent's registered entry (undefined if never registered,
 * already unregistered, or pruned as stale). Used by AgentOutputCapture as a
 * transcript-independent source of `isBackground` when the completing
 * agent's original Task/Agent tool_use (and its `run_in_background` field)
 * could not be located in the parent transcript — the tracker's own
 * SubagentStart-time registration (BackgroundAgentStarted.hook.ts) is
 * unaffected by that race, since it never depends on transcript parsing.
 */
export function getAgentEntry(sessionId: string, agentId: string): AgentEntry | undefined {
  const state = pruneStale(readState());
  return state[sessionId]?.[agentId];
}
