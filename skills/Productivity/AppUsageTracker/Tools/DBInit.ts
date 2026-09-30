#!/usr/bin/env bun
/**
 * DBInit.ts — idempotent schema initializer.
 *
 * Run on every poll (cheap; CREATE TABLE IF NOT EXISTS is a no-op when present).
 * Also a useful manual smoke-test: `bun DBInit.ts` prints all table names.
 */

import { Db } from "./Db.ts";

async function main(): Promise<void> {
  const db = await Db.open();
  try {
    await db.initSchema();
    const tables = await db.queryAll<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='main' ORDER BY table_name"
    );
    console.log(JSON.stringify({ ok: true, tables: tables.map(t => t.table_name) }, null, 2));
  } finally {
    db.close();
  }
}

if (import.meta.main) main().catch(err => { console.error(err); process.exit(1); });
