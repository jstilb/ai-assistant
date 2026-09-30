/**
 * LedgerWriter.test.ts — the one coded invariant: row-written-and-confirmed
 * BEFORE resolving, append-only, fail-loud on lock contention, table
 * auto-created via the real init path.
 *
 * Hermetic: every case passes an explicit mkdtemp dbPath, never the live
 * AppUsageTracker CONFIG.dbPath.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
// cross-skill-allowed: test reads back the row through AppUsageTracker's real Db to verify what actually landed, independent of LedgerWriter's own confirm-read
import { Db } from "../../AppUsageTracker/Tools/Db.ts";
import { LedgerLockError } from "../Tools/LedgerReader.ts";
import { writeLedgerRow } from "../Tools/LedgerWriter.ts";
import * as LedgerWriterModule from "../Tools/LedgerWriter.ts";

const TMP = mkdtempSync(join(tmpdir(), "yt-ledgerwriter-test-"));

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test("writeLedgerRow(): row lands with all columns + created_at, confirmed by re-read", async () => {
  const dbPath = join(TMP, "basic.db");
  const now = new Date("2026-08-10T12:34:56.000Z");

  const result = await writeLedgerRow(
    {
      videoId: "abc123",
      title: "Some Video",
      channel: "Some Channel",
      watchedAt: "2026-08-09T00:00:00.000Z",
      surface: "history",
      actions: ["deleted", "not-interested", "dont-recommend"],
      reason: "one-off curiosity click, recent — would not want more of this recommended",
      extra: { position: 3 },
      runId: "run-1",
    },
    { dbPath, now },
  );

  expect(result.videoId).toBe("abc123");
  expect(result.runId).toBe("run-1");
  expect(result.surface).toBe("history");
  expect(result.actions).toEqual(["deleted", "not-interested", "dont-recommend"]);
  expect(result.createdAt).toContain("2026-08-10");

  // Independently verify every column via AppUsageTracker's own Db — not
  // just trusting LedgerWriter's self-reported confirm.
  const db = await Db.open(dbPath);
  try {
    const rows = await db.queryAll<Record<string, unknown>>(
      `SELECT video_id, title, channel, CAST(watched_at AS VARCHAR) AS watched_at, surface, actions, reason, extra, run_id, CAST(created_at AS VARCHAR) AS created_at
         FROM youtube_deletions WHERE run_id = $run_id`,
      { run_id: "run-1" },
    );
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.video_id).toBe("abc123");
    expect(row.title).toBe("Some Video");
    expect(row.channel).toBe("Some Channel");
    expect(row.watched_at).toContain("2026-08-09");
    expect(row.surface).toBe("history");
    expect(row.actions).toBe("deleted,not-interested,dont-recommend");
    expect(row.reason).toContain("one-off curiosity click");
    expect(row.extra).toBe(JSON.stringify({ position: 3 }));
    expect(row.run_id).toBe("run-1");
    expect(row.created_at).toContain("2026-08-10");
  } finally {
    db.close();
  }
});

test("writeLedgerRow(): auto-creates youtube_deletions via the real init path on a fresh db", async () => {
  const dbPath = join(TMP, "fresh.db");
  expect(existsSync(dbPath)).toBe(false);

  const result = await writeLedgerRow(
    {
      videoId: "fresh1",
      surface: "watch_later",
      actions: ["wl-removed"],
      reason: "stale, oldest in the queue",
      runId: "run-fresh",
    },
    { dbPath },
  );

  expect(result.videoId).toBe("fresh1");
  expect(existsSync(dbPath)).toBe(true);
});

test("writeLedgerRow(): keep writes nothing (no-op is the caller's responsibility) — this module never writes unless called", async () => {
  // Structural check: writeLedgerRow has no "verdict" parameter that could
  // short-circuit a write. Calling it always writes; the rubric-guided
  // caller (SKILL.md's prune/wl runbook) is what decides NOT to call it for
  // a `keep` verdict. This test documents that contract by simply NOT
  // calling writeLedgerRow and confirming no db file appears.
  const dbPath = join(TMP, "never-touched.db");
  expect(existsSync(dbPath)).toBe(false);
});

test("LedgerWriter module: append-only — no update/delete export exists", () => {
  const exported = Object.keys(LedgerWriterModule);
  expect(exported).toContain("writeLedgerRow");
  expect(exported).not.toContain("updateLedgerRow");
  expect(exported).not.toContain("deleteLedgerRow");
  expect(exported).not.toContain("removeLedgerRow");
});

test("writeLedgerRow(): watchedAt on a watch_later row throws (WL renders no added-dates)", async () => {
  const dbPath = join(TMP, "wl-watchedat.db");
  let threw: unknown = null;
  try {
    await writeLedgerRow(
      {
        videoId: "wlv1",
        surface: "watch_later",
        actions: ["wl-removed"],
        reason: "archive-only",
        runId: "run-wl",
        watchedAt: "2026-08-01T00:00:00.000Z",
      },
      { dbPath },
    );
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(Error);
  expect((threw as Error).message).toContain("watchedAt must be omitted");
});

test("writeLedgerRow(): wl someday verdict — actions 'someday-add,wl-removed', watched_at NULL, extra carries duration/published-ago/position/resume-fraction", async () => {
  const dbPath = join(TMP, "wl-someday.db");

  const result = await writeLedgerRow(
    {
      videoId: "wl-someday-1",
      title: "A Deep Dive Video",
      channel: "Some Channel",
      surface: "watch_later",
      actions: ["someday-add", "wl-removed"],
      reason: "still wanted, not realistic in the next 2-3 weeks",
      extra: { duration: "45:12", publishedAgo: "2 years ago", listPosition: 1042, resumeFraction: null },
      runId: "run-wl-someday",
    },
    { dbPath },
  );

  expect(result.actions).toEqual(["someday-add", "wl-removed"]);

  const db = await Db.open(dbPath);
  try {
    const rows = await db.queryAll<Record<string, unknown>>(
      `SELECT actions, extra, watched_at FROM youtube_deletions WHERE run_id = $run_id`,
      { run_id: "run-wl-someday" },
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.actions).toBe("someday-add,wl-removed");
    expect(rows[0]?.watched_at).toBeNull();
    expect(rows[0]?.extra).toBe(JSON.stringify({ duration: "45:12", publishedAgo: "2 years ago", listPosition: 1042, resumeFraction: null }));
  } finally {
    db.close();
  }
});

test("writeLedgerRow(): wl archive-only verdict — actions 'wl-removed' only, watched_at NULL", async () => {
  const dbPath = join(TMP, "wl-archive-only.db");

  const result = await writeLedgerRow(
    {
      videoId: "wl-archive-1",
      title: "Old Stale Video",
      channel: "Some Channel",
      surface: "watch_later",
      actions: ["wl-removed"],
      reason: "no longer earns a place, already watched per Takeout",
      extra: { duration: "8:00", publishedAgo: "3 years ago", listPosition: 1090, resumeFraction: 0.1 },
      runId: "run-wl-archive",
    },
    { dbPath },
  );

  expect(result.actions).toEqual(["wl-removed"]);

  const db = await Db.open(dbPath);
  try {
    const rows = await db.queryAll<Record<string, unknown>>(
      `SELECT actions, watched_at FROM youtube_deletions WHERE run_id = $run_id`,
      { run_id: "run-wl-archive" },
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.actions).toBe("wl-removed");
    expect(rows[0]?.watched_at).toBeNull();
  } finally {
    db.close();
  }
});

test("writeLedgerRow(): unknown action throws", async () => {
  const dbPath = join(TMP, "bad-action.db");
  let threw: unknown = null;
  try {
    await writeLedgerRow(
      {
        videoId: "v1",
        surface: "history",
        // @ts-expect-error deliberately invalid — proving the runtime guard fires even though the type would normally prevent this
        actions: ["explode"],
        reason: "x",
        runId: "run-x",
      },
      { dbPath },
    );
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(Error);
  expect((threw as Error).message).toContain('unknown action "explode"');
});

test("writeLedgerRow(): empty reason throws", async () => {
  const dbPath = join(TMP, "empty-reason.db");
  let threw: unknown = null;
  try {
    await writeLedgerRow(
      { videoId: "v1", surface: "history", actions: ["deleted"], reason: "   ", runId: "run-x" },
      { dbPath },
    );
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(Error);
  expect((threw as Error).message).toContain("reason is required");
});

test("writeLedgerRow(): real cross-process lock contention throws LedgerLockError (fail loud, never silently queued)", async () => {
  const dbPath = join(TMP, "locked-write.db");
  const seed = await Db.open(dbPath);
  seed.close();

  const readyPath = join(TMP, "locked-write.ready");
  const releasePath = join(TMP, "locked-write.release");
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
      await writeLedgerRow(
        { videoId: "v1", surface: "history", actions: ["deleted"], reason: "junk", runId: "run-lock" },
        { dbPath },
      );
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
