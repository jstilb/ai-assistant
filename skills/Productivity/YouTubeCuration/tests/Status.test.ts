/**
 * Status.test.ts — `/youtube` / `/youtube status` composition.
 *
 * Hermetic: every case passes explicit path overrides. Covers rendering
 * behaviors AND the zero-mutation guarantee (spec.md §12.4/§12.5): status
 * must never write to any file or the db, and must never open events.db in
 * anything but READ_ONLY (enforced transitively via LedgerReader.ts).
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
// cross-skill-allowed: test applies AppUsageTracker's REAL schema init path to a throwaway db so status reads run against production-identical DDL
import { Db } from "../../AppUsageTracker/Tools/Db.ts";
import { buildStatusReport } from "../Tools/Status.ts";

const TMP = mkdtempSync(join(tmpdir(), "yt-status-test-"));

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function paths(name: string) {
  return {
    intentPath: join(TMP, `${name}-intent.yaml`),
    statePath: join(TMP, `${name}-state.json`),
    dbPath: join(TMP, `${name}-events.db`),
    fallbackSnapshotPath: join(TMP, `${name}-fallback-snapshot.json`),
  };
}

test("buildStatusReport(): fully-empty tree renders defaults, never throws", async () => {
  const p = paths("empty");
  const lines = await buildStatusReport(p);
  const text = lines.join("\n");
  expect(text).toContain("no intent declared");
  expect(text).toContain("no WL snapshot found");
  expect(text).toContain("events.db not found"); // fully-empty tree: no db file at all
  expect(text.toLowerCase()).toContain("no run state yet");
});

test("buildStatusReport(): recent intent shows no staleness warning", async () => {
  const p = paths("recent-intent");
  writeFileSync(p.intentPath, `topics:\n  - woodworking\ndeclared_at: '${new Date().toISOString().slice(0, 10)}'\n`);
  const lines = await buildStatusReport(p);
  const text = lines.join("\n");
  expect(text).toContain("woodworking");
  expect(text).not.toContain("still current?");
});

test("buildStatusReport(): intent >30 days old leads with a staleness banner", async () => {
  const p = paths("stale-intent");
  const oldDate = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
  writeFileSync(p.intentPath, `topics:\n  - deep learning\ndeclared_at: '${oldDate}'\n`);
  const lines = await buildStatusReport(p);
  const text = lines.join("\n");
  expect(text).toContain("still current?");
  expect(text).toContain("6 week"); // 45 days ~ 6 weeks
});

test("buildStatusReport(): WL snapshot fallback asset renders count + date", async () => {
  const p = paths("wl-snap");
  writeFileSync(p.fallbackSnapshotPath, JSON.stringify({ captured_at: "2026-08-09T12:33:00-0700", items: new Array(1094).fill({}) }));
  const lines = await buildStatusReport(p);
  const text = lines.join("\n");
  expect(text).toContain("1094");
  expect(text).toContain("2026-08-09");
});

test("buildStatusReport(): ledger totals render per surface when rows exist", async () => {
  const p = paths("ledger-rows");
  const db = await Db.open(p.dbPath);
  await db.initSchema();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO youtube_deletions (video_id, title, channel, watched_at, surface, actions, reason, extra, run_id, created_at)
     VALUES ($v, $t, $c, CAST(NULL AS TIMESTAMP), $s, $a, $r, NULL, $rid, $ca::TIMESTAMP)`,
    { v: "v1", t: "t", c: "c", s: "history", a: "deleted", r: "junk", rid: "run-1", ca: now },
  );
  db.close();

  const lines = await buildStatusReport(p);
  const text = lines.join("\n");
  expect(text).toContain("history: 1");
  expect(text).toContain("watch_later: 0");
});

test("buildStatusReport(): held items + last run summary from state file are rendered", async () => {
  const p = paths("state-rich");
  writeFileSync(p.statePath, JSON.stringify({
    held: { history: [{ videoId: "h1", reason: "unsure" }], watch_later: [] },
    lastRun: { mode: "prune", runId: "run-9", at: "2026-08-10T00:00:00Z", summary: "3 deleted, 1 held" },
  }));
  const lines = await buildStatusReport(p);
  const text = lines.join("\n");
  expect(text).toContain("1 history");
  expect(text).toContain("3 deleted, 1 held");
});

test("buildStatusReport(): renders no DPA/grant line anywhere (spec §9 amendment — DPA permanently out)", async () => {
  const p = paths("no-dpa");
  const lines = await buildStatusReport(p);
  const text = lines.join("\n").toLowerCase();
  expect(text).not.toContain("dpa");
  expect(text).not.toContain("grant");
});

test("buildStatusReport(): a locked events.db surfaces a loud, labeled failure line but does not throw or crash the rest of the report", async () => {
  const p = paths("locked-ledger");
  const seed = await Db.open(p.dbPath);
  seed.close();

  const readyPath = join(TMP, "status-locked.ready");
  const releasePath = join(TMP, "status-locked.release");
  const holderScript = join(import.meta.dir, "fixtures", "lock-holder.ts");
  const child = spawn("bun", [holderScript, p.dbPath, readyPath, releasePath], { stdio: "ignore" });

  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(readyPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(readyPath)).toBe(true);

    const lines = await buildStatusReport(p);
    const text = lines.join("\n");
    expect(text).toContain("READ FAILED");
    // Rest of the report still rendered — e.g. the intent section header.
    expect(text).toContain("YouTube curation");
  } finally {
    Bun.write(releasePath, "release");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(resolve, 3000);
    });
  }
});

test("buildStatusReport(): ZERO MUTATION — no files created/modified by a status run over a pre-seeded tree", async () => {
  const p = paths("zero-mutation");
  writeFileSync(p.intentPath, "topics:\n  - cooking\ndeclared_at: '2026-08-01'\n");
  writeFileSync(p.statePath, JSON.stringify({ lastRun: { mode: "wl", runId: "r1", at: "2026-08-01T00:00:00Z", summary: "ok" } }));
  writeFileSync(p.fallbackSnapshotPath, JSON.stringify({ captured_at: "2026-08-09T00:00:00Z", items: [{}] }));
  const db = await Db.open(p.dbPath);
  await db.initSchema();
  db.close();

  const before = {
    intent: readFileSync(p.intentPath, "utf8"),
    state: readFileSync(p.statePath, "utf8"),
    snapshot: readFileSync(p.fallbackSnapshotPath, "utf8"),
    dbMtime: statSync(p.dbPath).mtimeMs,
    treeListing: readdirSync(TMP).sort(),
  };

  await buildStatusReport(p);
  await buildStatusReport(p); // twice, to be sure nothing is created lazily on first-vs-second call

  const after = {
    intent: readFileSync(p.intentPath, "utf8"),
    state: readFileSync(p.statePath, "utf8"),
    snapshot: readFileSync(p.fallbackSnapshotPath, "utf8"),
    dbMtime: statSync(p.dbPath).mtimeMs,
    treeListing: readdirSync(TMP).sort(),
  };

  expect(after.intent).toBe(before.intent);
  expect(after.state).toBe(before.state);
  expect(after.snapshot).toBe(before.snapshot);
  expect(after.dbMtime).toBe(before.dbMtime);
  expect(after.treeListing).toEqual(before.treeListing);
});
