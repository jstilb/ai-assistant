/**
 * ClaudeSemaphore — TS companion to bin/kaya-claude-semaphore.sh.
 *
 * A file-based counting semaphore that caps concurrent heavy `claude -p` spawns across cron
 * jobs. It shares the SAME slot directory + protocol as the bash version, so bash-launched and
 * TS-launched jobs contend on one global gate:
 *   - Numbered lock-dirs slot-0 .. slot-(MAX-1), created atomically with mkdir (a hard cap of
 *     MAX because only MAX numbered slots exist).
 *   - Each slot records its owner PID in slot-<i>/pid; a slot whose owner is no longer alive is
 *     pruned on the next acquire, so a SIGKILL'd holder can't deadlock the gate.
 *
 * POLICY: proceed-on-timeout. A backstop must NEVER deadlock a job or add a new failure mode.
 * acquireClaudeSlot resolves to a release fn whether or not a slot was obtained; check
 * `.acquired` only for logging. Staggering is the primary fix; this smooths bursts.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { getKayaHome } from "./KayaHome.ts";

// frozen at import (getKayaHome cached); no test re-pins this module
const KAYA_HOME = getKayaHome();
const SLOT_DIR = process.env.KAYA_CLAUDE_SLOT_DIR || join(KAYA_HOME, "MEMORY/MONITORING/state/claude-slots");
const MAX_SLOTS = Math.max(1, Number(process.env.MAX_CLAUDE_SLOTS ?? "2") || 2);

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Remove slots whose recorded owner PID is no longer alive. */
function pruneDead(): void {
  let entries: string[];
  try { entries = readdirSync(SLOT_DIR); } catch { return; }
  for (const name of entries) {
    if (!/^slot-\d+$/.test(name)) continue;
    let pid = 0;
    try { pid = Number(readFileSync(join(SLOT_DIR, name, "pid"), "utf-8").trim()); } catch { /* no pid file */ }
    if (!pid || !pidAlive(pid)) {
      try { rmSync(join(SLOT_DIR, name), { recursive: true, force: true }); } catch { /* race */ }
    }
  }
}

export interface ClaudeSlot {
  /** true if a real slot was held; false means we proceeded ungated (timeout). */
  acquired: boolean;
  /** Releases the slot if held; safe no-op otherwise. Idempotent. */
  release: () => void;
}

/**
 * Acquire a claude slot, polling until `timeoutMs`. ALWAYS resolves (never rejects, never
 * blocks forever): on timeout it returns `{ acquired: false }` and the caller proceeds ungated.
 */
export async function acquireClaudeSlot(opts: {
  timeoutMs?: number;
  pollMs?: number;
  owner?: number;
} = {}): Promise<ClaudeSlot> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 3_000;
  const owner = opts.owner ?? process.pid;
  try { mkdirSync(SLOT_DIR, { recursive: true }); } catch { /* exists */ }

  const noop: ClaudeSlot = { acquired: false, release: () => {} };
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    pruneDead();
    for (let i = 0; i < MAX_SLOTS; i++) {
      const slot = join(SLOT_DIR, `slot-${i}`);
      try {
        mkdirSync(slot); // atomic: throws if the slot is held
        try { writeFileSync(join(slot, "pid"), String(owner)); } catch { /* best effort */ }
        let released = false;
        return {
          acquired: true,
          release: () => {
            if (released) return;
            released = true;
            try { rmSync(slot, { recursive: true, force: true }); } catch { /* best effort */ }
          },
        };
      } catch { /* slot taken — try the next index */ }
    }
    if (Date.now() >= deadline) return noop;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Convenience: acquire a slot (waiting up to timeoutMs), run `fn`, then release. Proceeds
 * ungated on timeout (calls `onUngated` for logging). Always releases, even if `fn` throws.
 */
export async function withClaudeSlot<T>(
  opts: { timeoutMs?: number; pollMs?: number; owner?: number; onUngated?: () => void },
  fn: () => Promise<T>,
): Promise<T> {
  const slot = await acquireClaudeSlot(opts);
  if (!slot.acquired && opts.onUngated) {
    try { opts.onUngated(); } catch { /* logging must not break the run */ }
  }
  try {
    return await fn();
  } finally {
    slot.release();
  }
}
