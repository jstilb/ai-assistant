/**
 * ClaudeSemaphore.test.ts — counting-semaphore behaviour: cap, proceed-on-timeout,
 * release, and dead-owner pruning.
 *
 * Env (slot dir + MAX) is set BEFORE a dynamic import so the module's module-level
 * constants bind to an isolated temp dir. Owners default to process.pid (alive), so held
 * slots are never falsely pruned mid-test.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SLOT_DIR = join(tmpdir(), `claude-sem-test-${process.pid}-${Date.now()}`);
process.env.KAYA_CLAUDE_SLOT_DIR = SLOT_DIR;
process.env.MAX_CLAUDE_SLOTS = "2";

const { acquireClaudeSlot } = await import("./ClaudeSemaphore");

function clearSlots() {
  try {
    for (const n of readdirSync(SLOT_DIR)) rmSync(join(SLOT_DIR, n), { recursive: true, force: true });
  } catch { /* dir may not exist yet */ }
}

function slotCount(): number {
  try { return readdirSync(SLOT_DIR).filter((n) => /^slot-\d+$/.test(n)).length; } catch { return 0; }
}

beforeEach(clearSlots);
afterEach(clearSlots);

describe("ClaudeSemaphore", () => {
  it("acquires up to MAX_CLAUDE_SLOTS slots", async () => {
    const a = await acquireClaudeSlot({ timeoutMs: 500 });
    const b = await acquireClaudeSlot({ timeoutMs: 500 });
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    expect(slotCount()).toBe(2);
    a.release();
    b.release();
  });

  it("proceeds ungated (acquired=false) when all slots are busy", async () => {
    const a = await acquireClaudeSlot({ timeoutMs: 500 });
    const b = await acquireClaudeSlot({ timeoutMs: 500 });
    const c = await acquireClaudeSlot({ timeoutMs: 200, pollMs: 50 });
    expect(c.acquired).toBe(false); // backstop must never block forever
    a.release();
    b.release();
  });

  it("release frees a slot for the next acquirer", async () => {
    const a = await acquireClaudeSlot({ timeoutMs: 500 });
    const b = await acquireClaudeSlot({ timeoutMs: 500 });
    expect((await acquireClaudeSlot({ timeoutMs: 150, pollMs: 50 })).acquired).toBe(false);
    a.release();
    const d = await acquireClaudeSlot({ timeoutMs: 500, pollMs: 50 });
    expect(d.acquired).toBe(true);
    b.release();
    d.release();
  });

  it("prunes a slot whose owner PID is dead, then reuses it", async () => {
    // Manually plant a slot owned by a definitely-dead PID.
    mkdirSync(join(SLOT_DIR, "slot-0"), { recursive: true });
    writeFileSync(join(SLOT_DIR, "slot-0", "pid"), "2000000000");
    const a = await acquireClaudeSlot({ timeoutMs: 500 });
    expect(a.acquired).toBe(true);   // dead slot pruned → free slot acquired
    expect(slotCount()).toBe(1);     // only our live slot remains
    a.release();
  });

  it("release is idempotent", async () => {
    const a = await acquireClaudeSlot({ timeoutMs: 500 });
    a.release();
    expect(() => a.release()).not.toThrow();
    expect(slotCount()).toBe(0);
  });
});
