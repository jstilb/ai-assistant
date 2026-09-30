/**
 * LedgerReader.test.ts — read-only events.db `youtube_deletions` totals.
 *
 * Hermetic: every case passes an explicit mkdtemp dbPath, never the live
 * AppUsageTracker CONFIG.dbPath. Covers: table-not-yet-created degrade,
 * correct per-surface totals, real cross-process lock-contention fail-loud,
 * and the standalone timeout wrapper.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
// cross-skill-allowed: test applies AppUsageTracker's REAL schema init path to a throwaway db so the DDL the ledger reads is the DDL production creates
import { Db } from "../../AppUsageTracker/Tools/Db.ts";
import {
  LedgerLockError,
  LedgerTimeoutError,
  readLedgerTotals,
  withTimeout,
} from "../Tools/LedgerReader.ts";

const TMP = mkdtempSync(join(tmpdir(), "yt-ledger-test-"));

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test("readLedgerTotals(): db file doesn't exist yet -> zero totals + note, does not throw", async () => {
  const dbPath = join(TMP, "does-not-exist.db");
  const result = await readLedgerTotals(dbPath);
  expect(result.totals).toEqual({ history: 0, watch_later: 0 });
  expect(result.note).not.toBeNull();
});

test("readLedgerTotals(): table not yet created -> zero totals + note, does not throw", async () => {
  const dbPath = join(TMP, "no-table.db");
  const db = await Db.open(dbPath);
  // Deliberately do NOT call initSchema() — simulates a fresh events.db
  // before any /youtube run has ever written a ledger row.
  await db.run("CREATE TABLE placeholder (x INTEGER)");
  db.close();

  const result = await readLedgerTotals(dbPath);
  expect(result.totals).toEqual({ history: 0, watch_later: 0 });
  expect(result.note).toContain("not yet created");
});

test("readLedgerTotals(): sums rows per surface correctly", async () => {
  const dbPath = join(TMP, "with-rows.db");
  const db = await Db.open(dbPath);
  await db.initSchema();
  const insert = `INSERT INTO youtube_deletions
      (video_id, title, channel, watched_at, surface, actions, reason, extra, run_id, created_at)
    VALUES ($video_id, $title, $channel, CAST(NULL AS TIMESTAMP), $surface, $actions, $reason, $extra, $run_id, $created_at::TIMESTAMP)`;
  const now = new Date().toISOString();
  await db.run(insert, {
    video_id: "h1", title: "t", channel: "c", surface: "history",
    actions: "deleted", reason: "junk", extra: null, run_id: "r1", created_at: now,
  });
  await db.run(insert, {
    video_id: "h2", title: "t", channel: "c", surface: "history",
    actions: "deleted", reason: "junk", extra: null, run_id: "r1", created_at: now,
  });
  await db.run(insert, {
    video_id: "w1", title: "t", channel: "c", surface: "watch_later",
    actions: "wl-removed", reason: "stale", extra: null, run_id: "r1", created_at: now,
  });
  db.close();

  const result = await readLedgerTotals(dbPath);
  expect(result.totals).toEqual({ history: 2, watch_later: 1 });
  expect(result.note).toBeNull();
});

test("readLedgerTotals(): real cross-process lock contention throws LedgerLockError (fail loud, never silently queued)", async () => {
  const dbPath = join(TMP, "locked.db");
  // Create the file up front (unlocked) so the holder can open it.
  const seed = await Db.open(dbPath);
  seed.close();

  const readyPath = join(TMP, "locked.ready");
  const releasePath = join(TMP, "locked.release");
  const holderScript = join(import.meta.dir, "fixtures", "lock-holder.ts");
  const child = spawn("bun", [holderScript, dbPath, readyPath, releasePath], { stdio: "ignore" });

  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(readyPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(readyPath)).toBe(true);

    let threw: unknown = null;
    try {
      await readLedgerTotals(dbPath);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(LedgerLockError);
    expect((threw as Error).message).toContain("locked");
  } finally {
    Bun.write(releasePath, "release");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(resolve, 3000);
    });
  }
});

test("withTimeout(): rejects with LedgerTimeoutError when the wrapped promise doesn't settle in time", async () => {
  const slow = new Promise((resolve) => setTimeout(resolve, 500));
  let threw: unknown = null;
  try {
    await withTimeout(slow, 10, "synthetic slow op");
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(LedgerTimeoutError);
  expect((threw as Error).message).toContain("synthetic slow op");
});

test("withTimeout(): resolves normally when the wrapped promise settles before the deadline", async () => {
  const fast = Promise.resolve(42);
  const result = await withTimeout(fast, 5_000, "fast op");
  expect(result).toBe(42);
});
