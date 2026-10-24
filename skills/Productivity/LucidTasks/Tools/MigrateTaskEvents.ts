#!/usr/bin/env bun
/**
 * MigrateTaskEvents.ts — run (or undo) ontology ruling D10 on one database:
 * the LucidTasks history table `activity_log` becomes `task_events`.
 *
 * TaskDB applies the same migration automatically on open, so after the D10
 * code is live the first CLI/board/executor open migrates the live database.
 * This tool exists to do it deliberately instead: prove it on a copy, take a
 * backup, report row counts, and roll back if needed.
 *
 *   bun MigrateTaskEvents.ts --db /tmp/copy.db              # migrate a copy
 *   bun MigrateTaskEvents.ts --db /tmp/copy.db --rollback   # undo on the copy
 *   bun MigrateTaskEvents.ts --db <path> --check            # report only
 *   bun MigrateTaskEvents.ts --live                         # the live db (Jm-gated)
 *
 * --live refuses while the Tasks Board or an executor is running (they hold
 * pre-D10 code and would recreate activity_log); --force overrides. Every
 * write is preceded by a `VACUUM INTO` backup next to the database. Never
 * prunes, so the row count before must equal the row count after.
 *
 * @module MigrateTaskEvents
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import {
  migrateActivityLogToTaskEvents,
  rollbackTaskEventsToActivityLog,
  TASK_EVENTS_TABLE,
  LEGACY_TASK_EVENTS_TABLE,
  TASK_EVENTS_SCHEMA_VERSION,
  type TaskEventsMigrationResult,
} from "./TaskDB.ts";

interface Args {
  db: string | null;
  live: boolean;
  rollback: boolean;
  check: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { db: null, live: false, rollback: false, check: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") args.db = argv[++i] ?? null;
    else if (a === "--live") args.live = true;
    else if (a === "--rollback") args.rollback = true;
    else if (a === "--check") args.check = true;
    else if (a === "--force") args.force = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function liveDbPath(): string {
  return join(getKayaHome(), "skills/Productivity/LucidTasks/Data/lucidtasks.db");
}

/** Processes that hold the live database open with long-lived code. */
const LIVE_HOLDERS = ["LucidTasks/Tools/BoardServer.ts", "LucidTasks/Tools/executor/executor.ts"];

function runningHolders(): string[] {
  const found: string[] = [];
  for (const pattern of LIVE_HOLDERS) {
    const proc = Bun.spawnSync(["pgrep", "-f", pattern]);
    const pids = proc.stdout.toString().trim();
    if (pids) found.push(`${pattern} (pid ${pids.split("\n").join(", ")})`);
  }
  return found;
}

interface Snapshot {
  tables: string[];
  userVersion: number;
  counts: Record<string, number>;
}

function snapshot(db: Database): Snapshot {
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)")
      .all(TASK_EVENTS_TABLE, LEGACY_TASK_EVENTS_TABLE) as { name: string }[]
  ).map((r) => r.name);
  const counts: Record<string, number> = {};
  for (const t of tables) {
    counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  const userVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  return { tables, userVersion, counts };
}

function total(s: Snapshot): number {
  return Object.values(s.counts).reduce((a, b) => a + b, 0);
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const path = args.live ? liveDbPath() : args.db;
  if (!path) {
    console.error("usage: MigrateTaskEvents.ts (--db <path> | --live) [--rollback] [--check] [--force]");
    return 2;
  }
  if (!existsSync(path)) {
    console.error(`no database at ${path}`);
    return 2;
  }

  const db = new Database(path);
  db.exec("PRAGMA busy_timeout=5000");
  const before = snapshot(db);
  console.log(`db:      ${path}`);
  console.log(`before:  ${JSON.stringify(before)}`);
  if (args.check) {
    db.close();
    return 0;
  }

  if (args.live && !args.force) {
    const holders = runningHolders();
    if (holders.length > 0) {
      console.error(`refusing: live holders running — stop them first (or --force):\n  ${holders.join("\n  ")}`);
      db.close();
      return 3;
    }
  }

  const nothingToDo = args.rollback
    ? !before.tables.includes(TASK_EVENTS_TABLE)
    : !before.tables.includes(LEGACY_TASK_EVENTS_TABLE) && before.userVersion >= TASK_EVENTS_SCHEMA_VERSION;
  if (nothingToDo) {
    console.log(`noop:    already ${args.rollback ? "rolled back" : "migrated"}`);
    db.close();
    return 0;
  }

  const backup = `${path}.pre-d10-${args.rollback ? "rollback" : "migrate"}-${Date.now()}.bak`;
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  console.log(`backup:  ${backup}`);

  let result: TaskEventsMigrationResult;
  try {
    result = args.rollback ? rollbackTaskEventsToActivityLog(db) : migrateActivityLogToTaskEvents(db);
  } catch (err) {
    console.error(`FAILED (transaction rolled back): ${err instanceof Error ? err.message : String(err)}`);
    db.close();
    return 1;
  }
  const after = snapshot(db);
  db.close();

  console.log(`result:  ${JSON.stringify(result)}`);
  console.log(`after:   ${JSON.stringify(after)}`);
  if (total(before) !== total(after)) {
    console.error(`ROW COUNT CHANGED: ${total(before)} -> ${total(after)}`);
    return 1;
  }
  console.log(`rows:    ${total(before)} before == ${total(after)} after`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
