#!/usr/bin/env bun
/**
 * ProcessReaper.test.ts — leftover-process sweeps for agent runs.
 *
 * The "real process" tests start only `sleep` children in throwaway mkdtemp
 * dirs and always end them in afterEach, so a failure cannot leak a process.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

import {
  AGENT_RUN_ENV_KEY,
  findAgentRunPids,
  findPidsInDir,
  terminatePids,
  reapAgentRun,
  reapProcessesInDir,
} from "./ProcessReaper.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Pids of `sleep <secs>` processes, found by their unique duration argument. */
function sleepPids(secs: number): number[] {
  const res = spawnSync("pgrep", ["-f", `^sleep ${secs}$`], { encoding: "utf-8" });
  return res.stdout.split("\n").filter(Boolean).map(Number);
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function tempDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "reaper-")));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/**
 * Start an orphaned bun process the way an agent's `bun run Server.ts &` does:
 * the parent shell exits at once. bun, not `sleep`: macOS hides the env of
 * Apple platform binaries from `ps -E` (see ProcessReaper.ts header).
 */
function startOrphanBun(tag: string, opts: { env: Record<string, string>; cwd: string }): number {
  const script = `setTimeout(() => {}, 600000) // ${tag}`;
  spawnSync("sh", ["-c", `"${process.execPath}" -e '${script}' > /dev/null 2>&1 &`], { env: opts.env, cwd: opts.cwd });
  Bun.sleepSync(200);
  const res = spawnSync("pgrep", ["-f", tag], { encoding: "utf-8" });
  const pids = res.stdout.split("\n").filter(Boolean).map(Number);
  cleanup.push(() => pids.forEach(p => { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }));
  expect(pids.length).toBe(1);
  return pids[0];
}

describe("findAgentRunPids", () => {
  it("matches the marker only as a whole env token", () => {
    const rows = [
      { pid: 10, envText: `bun run x.ts PATH=/bin ${AGENT_RUN_ENV_KEY}=abc HOME=/h` },
      { pid: 11, envText: `bun run y.ts ${AGENT_RUN_ENV_KEY}=abcd` },
      { pid: 12, envText: `bun run z.ts ${AGENT_RUN_ENV_KEY}=abc` },
      { pid: 13, envText: `grep abc` },
    ];
    expect(findAgentRunPids("abc", rows)).toEqual([10, 12]);
  });
});

describe("findPidsInDir", () => {
  it("matches the dir and its children, not a sibling with the same prefix", () => {
    const rows = [
      { pid: 1, cwd: "/w/executor-task-a" },
      { pid: 2, cwd: "/w/executor-task-a/skills/x" },
      { pid: 3, cwd: "/w/executor-task-ab" },
      { pid: 4, cwd: "/" },
    ];
    expect(findPidsInDir("/w/executor-task-a", rows)).toEqual([1, 2]);
    expect(findPidsInDir("/w/executor-task-a/", rows)).toEqual([1, 2]);
  });
});

describe("terminatePids", () => {
  it("sends SIGTERM, then SIGKILL only to pids still alive after the grace period", () => {
    const sent: Array<[number, string | number]> = [];
    const live = new Set([100, 200]);
    const killFn = (pid: number, sig: NodeJS.Signals | 0) => {
      if (!live.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      sent.push([pid, sig]);
      if (sig === "SIGTERM" && pid === 100) live.delete(100); // 100 obeys SIGTERM, 200 ignores it
      if (sig === "SIGKILL") live.delete(pid);
    };
    const out = terminatePids([100, 200, 300], { killFn, sleepFn: () => {}, graceMs: 300, protectedPids: [] });
    expect(out).toEqual([100, 200]);
    expect(sent.filter(([, s]) => s === "SIGKILL")).toEqual([[200, "SIGKILL"]]);
  });

  it("never signals protected pids or pid 1", () => {
    const sent: number[] = [];
    const killFn = (pid: number) => { sent.push(pid); throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); };
    terminatePids([1, 42, 43], { killFn, sleepFn: () => {}, protectedPids: [42] });
    expect(sent).toEqual([43]);
  });
});

describe("real processes", () => {
  it("the incident pattern: `cd … && cmd &` + kill $! misses the real process", () => {
    const dir = tempDir();
    const pidFile = join(dir, "srv.pid");
    spawnSync("bash", ["-c", `cd ${dir} && sleep 7301 > /dev/null 2>&1 &\necho $! > ${pidFile}`]);
    const pids = sleepPids(7301);
    cleanup.push(() => pids.forEach(p => { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }));
    const bang = Number(readFileSync(pidFile, "utf-8").trim());
    try { process.kill(bang, "SIGTERM"); } catch { /* subshell may be gone */ }
    expect(pids.length).toBe(1);
    expect(pids[0]).not.toBe(bang); // $! named the subshell, not sleep
    Bun.sleepSync(200);
    expect(alive(pids[0])).toBe(true); // so the "kill" left the real process running

    // The cwd sweep the executor runs before removing a worktree ends it.
    expect(reapProcessesInDir(dir, { graceMs: 2000 })).toEqual([pids[0]]);
    expect(alive(pids[0])).toBe(false);
  });

  it("reapAgentRun ends an orphan that inherited the run marker, and only that one", () => {
    const dir = tempDir();
    const runId = crypto.randomUUID();
    const PATH = process.env.PATH ?? "/bin:/usr/bin";
    const marked = startOrphanBun(`reaper-marked-${runId}`, { env: { PATH, [AGENT_RUN_ENV_KEY]: runId }, cwd: dir });
    const other = startOrphanBun(`reaper-other-${runId}`, { env: { PATH, [AGENT_RUN_ENV_KEY]: "someone-else" }, cwd: dir });

    expect(reapAgentRun(runId)).toEqual([marked]);
    expect(alive(marked)).toBe(false);
    expect(alive(other)).toBe(true);
  });

  it("reapProcessesInDir returns [] and signals nothing when no process is inside", () => {
    expect(reapProcessesInDir(tempDir())).toEqual([]);
  });
});
