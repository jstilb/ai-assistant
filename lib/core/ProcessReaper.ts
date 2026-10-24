#!/usr/bin/env bun
/**
 * ProcessReaper.ts — Find and end the processes an agent run left behind.
 *
 * Why: a headless `claude -p` agent can start a server with `cmd &` and then
 * exit. The server is reparented to launchd and lives on. Incident 2026-10-23:
 * executor run t-mum1n34l-kawf1o (2026-10-05) started two BoardServer.ts on
 * :7788 with `cd … && bun run … &` + `echo $! > board.pid`. `$!` was the bash
 * subshell, not bun, so its `kill $(cat board.pid)` missed both servers; they
 * ran for 18 days, one on *:7788.
 *
 * A process-group kill does not reach such leftovers: Claude Code's Bash tool
 * runs each command in its own process group, so they never share the agent's
 * pgid. Two traits do survive, and each has a sweep here:
 *
 *   - Env marker (`reapAgentRun`): AgentSpawner puts a fresh id under
 *     AGENT_RUN_ENV_KEY in each spawn's env. Every descendant inherits it
 *     unless it replaces its env wholesale.
 *   - Cwd (`reapProcessesInDir`): processes whose cwd is inside a worktree that
 *     is about to be removed. Catches descendants started with a scrubbed env.
 *
 * Known blind spot of the env sweep on macOS: `ps -E` shows no env for Apple
 * platform binaries (/bin/sleep, /bin/bash, …). bun/node/Homebrew processes —
 * the usual agent-started servers — are visible. The cwd sweep covers the rest
 * when they run inside the worktree.
 *
 * Both send SIGTERM, wait up to `graceMs`, then SIGKILL what is still alive.
 * Never throw — a failed sweep is reported on stderr and returns what it did.
 */

import { spawnSync } from "child_process";
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "fs";
import { sep } from "path";

/** Env key AgentSpawner sets on every spawn; its value is a per-run UUID. */
export const AGENT_RUN_ENV_KEY = "KAYA_AGENT_RUN_ID";

const DEFAULT_GRACE_MS = 2000;
const POLL_MS = 100;

export interface ProcEnvRow {
  pid: number;
  /** Command line plus env, space-joined (macOS `ps -E` shape). */
  envText: string;
}

export interface ProcCwdRow {
  pid: number;
  cwd: string;
}

export interface ReaperDeps {
  listProcessEnvFn?: () => ProcEnvRow[];
  listProcessCwdFn?: () => ProcCwdRow[];
  /** Same contract as process.kill (throws ESRCH when the pid is gone). */
  killFn?: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleepFn?: (ms: number) => void;
  /** Pids that must never be signalled. Defaults to this process and its parent. */
  protectedPids?: number[];
  graceMs?: number;
}

// ============================================================================
// Process listings (real OS calls — injectable for tests)
// ============================================================================

function listProcessEnvDarwin(): ProcEnvRow[] {
  const res = spawnSync("ps", ["-Eww", "-axo", "pid=,command="], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`ps -E failed: ${res.stderr || res.error?.message}`);
  const rows: ProcEnvRow[] = [];
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), envText: m[2] });
  }
  return rows;
}

function listProcessEnvLinux(): ProcEnvRow[] {
  const rows: ProcEnvRow[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const env = readFileSync(`/proc/${name}/environ`, "utf-8").split("\0").join(" ");
      rows.push({ pid: Number(name), envText: env });
    } catch {
      // intentionally silent: process exited or is not ours — skip it.
    }
  }
  return rows;
}

function listProcessCwdDarwin(): ProcCwdRow[] {
  // lsof exits 1 when some processes deny access; the output is still valid.
  const res = spawnSync("lsof", ["-nP", "-d", "cwd", "-Fpn"], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`lsof failed: ${res.error.message}`);
  const rows: ProcCwdRow[] = [];
  let pid = -1;
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) rows.push({ pid, cwd: line.slice(1) });
  }
  return rows;
}

function listProcessCwdLinux(): ProcCwdRow[] {
  const rows: ProcCwdRow[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      rows.push({ pid: Number(name), cwd: readlinkSync(`/proc/${name}/cwd`) });
    } catch {
      // intentionally silent: process exited or is not ours — skip it.
    }
  }
  return rows;
}

const defaultListProcessEnv = process.platform === "linux" ? listProcessEnvLinux : listProcessEnvDarwin;
const defaultListProcessCwd = process.platform === "linux" ? listProcessCwdLinux : listProcessCwdDarwin;

// ============================================================================
// Matching
// ============================================================================

/** Pids whose env carries `AGENT_RUN_ENV_KEY=<runId>` as a whole token. */
export function findAgentRunPids(runId: string, rows: ProcEnvRow[]): number[] {
  const token = `${AGENT_RUN_ENV_KEY}=${runId}`;
  return rows
    .filter(r => r.envText.split(/\s/).includes(token))
    .map(r => r.pid);
}

/** Pids whose cwd is `dir` or below it. `dir` should already be a real path. */
export function findPidsInDir(dir: string, rows: ProcCwdRow[]): number[] {
  const root = dir.endsWith(sep) ? dir.slice(0, -1) : dir;
  return rows
    .filter(r => r.cwd === root || r.cwd.startsWith(root + sep))
    .map(r => r.pid);
}

// ============================================================================
// Termination
// ============================================================================

function isAlive(pid: number, kill: NonNullable<ReaperDeps["killFn"]>): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * SIGTERM each pid, wait up to graceMs for them to exit, then SIGKILL the rest.
 * Returns the pids that were alive and got signalled.
 */
export function terminatePids(pids: number[], deps: ReaperDeps = {}): number[] {
  const kill = deps.killFn ?? ((pid, sig) => process.kill(pid, sig));
  const sleep = deps.sleepFn ?? ((ms: number) => Bun.sleepSync(ms));
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  const shield = new Set(deps.protectedPids ?? [process.pid, process.ppid]);

  const signalled: number[] = [];
  for (const pid of new Set(pids)) {
    if (pid <= 1 || shield.has(pid)) continue;
    try {
      kill(pid, "SIGTERM");
      signalled.push(pid);
    } catch {
      // intentionally silent: process already exited.
    }
  }

  let waited = 0;
  while (waited < graceMs && signalled.some(p => isAlive(p, kill))) {
    sleep(POLL_MS);
    waited += POLL_MS;
  }

  for (const pid of signalled) {
    if (!isAlive(pid, kill)) continue;
    try {
      kill(pid, "SIGKILL");
    } catch {
      // intentionally silent: exited between the check and the kill.
    }
  }
  return signalled;
}

// ============================================================================
// Sweeps
// ============================================================================

/**
 * End every live process that carries this agent run's env marker. Call it
 * after the agent process has exited. Returns the pids it signalled.
 */
export function reapAgentRun(runId: string, deps: ReaperDeps = {}): number[] {
  try {
    const rows = (deps.listProcessEnvFn ?? defaultListProcessEnv)();
    const pids = findAgentRunPids(runId, rows);
    return pids.length === 0 ? [] : terminatePids(pids, deps);
  } catch (err) {
    console.warn(`[ProcessReaper] agent-run sweep failed for ${runId}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/**
 * End every live process whose cwd is inside `dir` (e.g. a worktree about to
 * be removed). Returns the pids it signalled.
 */
export function reapProcessesInDir(dir: string, deps: ReaperDeps = {}): number[] {
  try {
    let real = dir;
    try {
      real = realpathSync(dir);
    } catch {
      // intentionally silent: dir already gone — match the given path as-is.
    }
    const rows = (deps.listProcessCwdFn ?? defaultListProcessCwd)();
    const pids = findPidsInDir(real, rows);
    return pids.length === 0 ? [] : terminatePids(pids, deps);
  } catch (err) {
    console.warn(`[ProcessReaper] cwd sweep failed for ${dir}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}
