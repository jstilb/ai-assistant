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
 * SCOPE (ADR 032): the slot is for the cron lane only. The cron runner (lib/cron/CronRun.ts) and
 * the bash lane (bin/kaya-common.sh) share one slot dir. Completions (`inference()`) and one-shot
 * agents (AgentSpawner) take no slot: a 300 s wait would break a Telegram reply, hooks call
 * inference() inside interactive sessions, and there is no evidence of non-cron over-subscription.
 *
 * POLICY: proceed-on-timeout. A backstop must NEVER deadlock a job or add a new failure mode.
 * acquireClaudeSlot resolves to a release fn whether or not a slot was obtained; check
 * `.acquired` only for logging. Staggering is the primary fix; this smooths bursts.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getKayaHome } from "./KayaHome.ts";

// Resolved per call, so tests that set KAYA_CLAUDE_SLOT_DIR / MAX_CLAUDE_SLOTS in one process don't race.
function slotDir(): string {
  return process.env.KAYA_CLAUDE_SLOT_DIR || join(getKayaHome(), "MEMORY/MONITORING/state/claude-slots");
}

function maxSlots(): number {
  return Math.max(1, Number(process.env.MAX_CLAUDE_SLOTS ?? "2") || 2);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Remove slots whose recorded owner PID is no longer alive. */
function pruneDead(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!/^slot-\d+$/.test(name)) continue;
    let pid = 0;
    try {
      pid = Number(readFileSync(join(dir, name, "pid"), "utf-8").trim());
    } catch {
      /* no pid file */
    }
    if (!pid || !pidAlive(pid)) {
      try {
        rmSync(join(dir, name), { recursive: true, force: true });
      } catch {
        /* race */
      }
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
export async function acquireClaudeSlot(
  opts: { timeoutMs?: number; pollMs?: number; owner?: number } = {},
): Promise<ClaudeSlot> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 3_000;
  const owner = opts.owner ?? process.pid;
  const dir = slotDir();
  const max = maxSlots();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* exists */
  }

  const noop: ClaudeSlot = { acquired: false, release: () => {} };
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    pruneDead(dir);
    for (let i = 0; i < max; i++) {
      const slot = join(dir, `slot-${i}`);
      try {
        mkdirSync(slot); // atomic: throws if the slot is held
        try {
          writeFileSync(join(slot, "pid"), String(owner));
        } catch {
          /* best effort */
        }
        let released = false;
        return {
          acquired: true,
          release: () => {
            if (released) return;
            released = true;
            try {
              rmSync(slot, { recursive: true, force: true });
            } catch {
              /* best effort */
            }
          },
        };
      } catch {
        /* slot taken — try the next index */
      }
    }
    if (Date.now() >= deadline) return noop;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
