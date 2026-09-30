/**
 * lock-holder.ts — test fixture (spawned as a subprocess).
 *
 * Opens the given DuckDB file READ_WRITE, writes a ready-sentinel, then
 * polls for a release-sentinel before closing and exiting. Used by
 * LedgerReader.test.ts to reproduce REAL cross-process DuckDB lock
 * contention (same-process double-opens do not conflict — verified
 * separately; only a second OS process racing for the file lock does).
 *
 * argv: <dbPath> <readySentinelPath> <releaseSentinelPath>
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, writeFileSync } from "node:fs";

const [dbPath, readyPath, releasePath] = process.argv.slice(2);

const instance = await DuckDBInstance.create(dbPath as string);
const conn = await instance.connect();
await conn.run("CREATE TABLE IF NOT EXISTS lock_holder_marker (x INTEGER)");

writeFileSync(readyPath as string, String(process.pid));

const deadline = Date.now() + 10_000;
while (!existsSync(releasePath as string) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 25));
}

conn.disconnectSync();
instance.closeSync();
