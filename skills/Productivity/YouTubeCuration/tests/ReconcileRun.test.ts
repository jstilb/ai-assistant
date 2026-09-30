/**
 * ReconcileRun.test.ts — report-vs-ledger reconciliation (spec.md §12's
 * binding anchor). Read-only, hermetic: every case passes an explicit
 * mkdtemp dbPath, never the live AppUsageTracker CONFIG.dbPath.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// cross-skill-allowed: test seeds a throwaway db via AppUsageTracker's real Db/schema so the ledger rows reconcileRun reads match production shape exactly
import { Db } from "../../AppUsageTracker/Tools/Db.ts";
import { writeLedgerRow } from "../Tools/LedgerWriter.ts";
import { reconcileRun } from "../Tools/ReconcileRun.ts";

const TMP = mkdtempSync(join(tmpdir(), "yt-reconcile-test-"));

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test("reconcileRun(): matches when claimed counts equal what actually landed", async () => {
  const dbPath = join(TMP, "match.db");
  await writeLedgerRow(
    { videoId: "v1", surface: "history", actions: ["deleted", "not-interested", "dont-recommend"], reason: "junk", runId: "run-A" },
    { dbPath },
  );
  await writeLedgerRow(
    { videoId: "v2", surface: "history", actions: ["deleted"], reason: "old junk", runId: "run-A" },
    { dbPath },
  );
  await writeLedgerRow(
    { videoId: "v3", surface: "watch_later", actions: ["wl-removed"], reason: "stale", runId: "run-A" },
    { dbPath },
  );

  const result = await reconcileRun(
    "run-A",
    [
      { surface: "history", action: "deleted", count: 2 },
      { surface: "history", action: "not-interested", count: 1 },
      { surface: "history", action: "dont-recommend", count: 1 },
      { surface: "watch_later", action: "wl-removed", count: 1 },
    ],
    dbPath,
  );

  expect(result.allMatch).toBe(true);
  expect(result.entries.every((e) => e.match)).toBe(true);
  expect(result.unclaimed).toEqual([]);
});

test("reconcileRun(): reports a mismatch when a claimed count is wrong", async () => {
  const dbPath = join(TMP, "mismatch.db");
  await writeLedgerRow(
    { videoId: "v1", surface: "history", actions: ["deleted"], reason: "junk", runId: "run-B" },
    { dbPath },
  );

  const result = await reconcileRun("run-B", [{ surface: "history", action: "deleted", count: 5 }], dbPath);

  expect(result.allMatch).toBe(false);
  expect(result.entries).toEqual([{ surface: "history", action: "deleted", claimed: 5, actual: 1, match: false }]);
});

test("reconcileRun(): flags ledger rows present under the run_id but never claimed", async () => {
  const dbPath = join(TMP, "unclaimed.db");
  await writeLedgerRow(
    { videoId: "v1", surface: "history", actions: ["deleted", "not-interested"], reason: "junk", runId: "run-C" },
    { dbPath },
  );

  // Report only claims "deleted" — omits "not-interested" entirely, even
  // though the same row also carries that action.
  const result = await reconcileRun("run-C", [{ surface: "history", action: "deleted", count: 1 }], dbPath);

  expect(result.allMatch).toBe(false);
  expect(result.unclaimed).toEqual([{ surface: "history", action: "not-interested", actual: 1 }]);
});

test("reconcileRun(): a different run_id's rows never leak into this run's counts", async () => {
  const dbPath = join(TMP, "isolation.db");
  await writeLedgerRow(
    { videoId: "other", surface: "history", actions: ["deleted"], reason: "junk", runId: "run-OTHER" },
    { dbPath },
  );

  const result = await reconcileRun("run-D", [{ surface: "history", action: "deleted", count: 0 }], dbPath);
  expect(result.allMatch).toBe(true);
});

test("reconcileRun(): missing db degrades to zero-actual entries, does not throw", async () => {
  const dbPath = join(TMP, "does-not-exist.db");
  const result = await reconcileRun("run-E", [{ surface: "history", action: "deleted", count: 3 }], dbPath);
  expect(result.entries).toEqual([{ surface: "history", action: "deleted", claimed: 3, actual: 0, match: false }]);
  expect(result.note).not.toBeNull();
});

test("reconcileRun(): table not yet created degrades to zero-actual entries, does not throw", async () => {
  const dbPath = join(TMP, "no-table.db");
  const db = await Db.open(dbPath);
  await db.run("CREATE TABLE placeholder (x INTEGER)");
  db.close();

  const result = await reconcileRun("run-F", [{ surface: "history", action: "deleted", count: 0 }], dbPath);
  expect(result.allMatch).toBe(true);
  expect(result.note).toContain("not yet created");
});
