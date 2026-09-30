/**
 * Db.ts — thin wrapper around @duckdb/node-api for AppUsageTracker tools.
 *
 * One connection per tool invocation. Closes on exit. Exposes helpers for the
 * patterns we actually use (run, queryRow, queryAll, insertReplace).
 */

import { DuckDBInstance, type DuckDBConnection, type DuckDBInstance as DuckDBInstanceT } from "@duckdb/node-api";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG } from "../Config.ts";
import { logFailure as _coreLogFailure } from "../../../../lib/core/FailureLog.ts";

const SCHEMA_PATH = join(import.meta.dir, "..", "db", "schema.sql");

export class Db {
  constructor(
    private readonly conn: DuckDBConnection,
    private readonly instance: DuckDBInstanceT,
  ) {}

  static async open(dbPath: string = CONFIG.dbPath): Promise<Db> {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Explicitly NOT using fromCache — caching keeps the OS file lock alive
    // even after connection.disconnectSync(), which breaks tests that spawn a
    // subprocess against the same DB file.
    const instance = await DuckDBInstance.create(dbPath);
    const conn = await instance.connect();
    return new Db(conn, instance);
  }

  /**
   * Read-only open. Multiple read-only processes can share the file, and a
   * read-only handle can never corrupt events.db. Use this for tools that
   * only SELECT (e.g. CalibrationSampler) so they don't take the exclusive
   * write lock the nightly pipeline needs. Note: DuckDB still refuses a
   * read-only open while a read-write holder is active — callers should
   * surface that error, not retry-loop over it.
   */
  static async openReadOnly(dbPath: string = CONFIG.dbPath): Promise<Db> {
    const instance = await DuckDBInstance.create(dbPath, { access_mode: "READ_ONLY" });
    const conn = await instance.connect();
    return new Db(conn, instance);
  }

  async initSchema(): Promise<void> {
    const sql = readFileSync(SCHEMA_PATH, "utf8");
    for (const stmt of sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) {
      await this.conn.run(stmt);
    }
    await this.runMigrations();
  }

  /**
   * Apply forward-only schema migrations gated by `schema_version`. Each step
   * is idempotent so re-running yields zero work after the first success.
   * Failures here propagate — a half-applied migration is better than silent
   * drift, since AWPoller can't safely continue against the old PK shape.
   */
  private async runMigrations(): Promise<void> {
    const row = await this.queryRow<{ v: number | bigint | null }>(
      `SELECT MAX(version) AS v FROM schema_version`,
    );
    const current = row?.v == null ? 0 : Number(row.v);

    if (current < 1) {
      // v1 — embed event timestamp into events.id to survive aw-server local
      // DB wipes. Old PK shape: "<device>:<bucket>:<id-or-ts>". If aw-server
      // resets, ev.id=1 would collide with our stored row keyed at id=1 from
      // before. Appending ts_start makes the PK unique even across resets.
      // The guard skips rows that already contain a `T...Z` segment from a
      // previous partial run.
      await this.conn.run(`
        UPDATE events
           SET id = id || ':' || strftime(ts_start, '%Y-%m-%dT%H:%M:%S.%fZ')
         WHERE position('T' in id) = 0
            OR position('Z' in id) = 0
      `);
      await this.conn.run(
        `INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (1, NOW())`,
      );
    }

    if (current < 2) {
      // v2 — YouTube watched/listened sub-split on daily_metrics. ADD COLUMN
      // IF NOT EXISTS is a no-op on fresh DBs (schema.sql already declares the
      // columns) and applies to the live DB. DuckDB rejects NOT NULL/DEFAULT
      // in ALTER TABLE ADD COLUMN, so the columns land nullable and an
      // explicit UPDATE backfills 0 for pre-existing rows. upsertMetric always
      // writes concrete values, so the missing NOT NULL is never exercised.
      await this.conn.run(
        `ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS yt_watched_minutes INTEGER`,
      );
      await this.conn.run(
        `ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS yt_listened_minutes INTEGER`,
      );
      await this.conn.run(
        `UPDATE daily_metrics SET yt_watched_minutes = 0 WHERE yt_watched_minutes IS NULL`,
      );
      await this.conn.run(
        `UPDATE daily_metrics SET yt_listened_minutes = 0 WHERE yt_listened_minutes IS NULL`,
      );
      await this.conn.run(
        `INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (2, NOW())`,
      );
    }

    if (current < 3) {
      // v3 — total ("all", not just low-value) usage aggregates on daily_metrics:
      //   total_youtube_minutes — ALL YouTube consumed (every verdict), 2x-corrected
      //   total_media_minutes   — foreground screen time on non-utility apps (excl Tier-3)
      //   total_screen_minutes  — all foreground app screen time (currentwindow watcher)
      // Same shape as v2: DuckDB rejects NOT NULL/DEFAULT in ALTER ADD COLUMN, so
      // columns land nullable and an UPDATE backfills 0; MetricCalc --force then
      // recomputes concrete values for every day.
      for (const col of ["total_youtube_minutes", "total_media_minutes", "total_screen_minutes"]) {
        await this.conn.run(`ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS ${col} INTEGER`);
        await this.conn.run(`UPDATE daily_metrics SET ${col} = 0 WHERE ${col} IS NULL`);
      }
      await this.conn.run(
        `INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (3, NOW())`,
      );
    }
  }

  async run(sql: string, params?: Record<string, unknown>): Promise<void> {
    if (params) await this.conn.run(sql, params);
    else await this.conn.run(sql);
  }

  /**
   * Run `fn` inside an explicit BEGIN TRANSACTION / COMMIT, rolling back on
   * any thrown error and rethrowing.
   *
   * WHY: without an explicit transaction, every `conn.run()` auto-commits
   * individually. ChromeTakeoutIngest.ts issued ~129,322 individually
   * auto-committing single-row INSERTs in one nightly run, which crashed with
   * `duckdb::DuckTransaction::Commit -> std::terminate -> SIGTRAP` on a bun
   * N-API worker thread (see ~/Library/Logs/DiagnosticReports/bun.exe-*.ips,
   * 2026-07-07). Batching many statements into ONE commit (see runBatched()
   * below) removes ~129k of the ~129,322 commits that exposed the crash.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.conn.run("BEGIN TRANSACTION");
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      try {
        await this.conn.run("ROLLBACK");
      } catch {
        // intentionally silent: best-effort rollback — the ORIGINAL error
        // (err) is what must propagate to the caller. A rollback failure
        // here would only mask it, and a truly wedged connection will fail
        // loudly on its own at the next statement anyway.
      }
      throw err;
    }
    await this.conn.run("COMMIT");
    return result;
  }

  /**
   * Insert `rows` via the same parameterized `sql` in batches of `batchSize`
   * (default 1000), each batch wrapped in ONE transaction instead of one
   * auto-commit per row. Same per-row SQL/semantics as calling `run(sql,
   * params)` in a loop (e.g. INSERT OR REPLACE idempotency is unaffected) —
   * only the commit granularity changes. If a row in a batch fails, that
   * whole batch rolls back and the error propagates; earlier, already-
   * committed batches are unaffected (see Db.test.ts).
   */
  async runBatched(
    sql: string,
    rows: Record<string, unknown>[],
    batchSize = 1000,
  ): Promise<void> {
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      await this.transaction(async () => {
        for (const params of batch) {
          await this.conn.run(sql, params);
        }
      });
    }
  }

  async queryAll<T = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T[]> {
    const reader = params
      ? await this.conn.runAndReadAll(sql, params)
      : await this.conn.runAndReadAll(sql);
    return reader.getRowObjects() as T[];
  }

  async queryRow<T = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T | null> {
    const rows = await this.queryAll<T>(sql, params);
    return rows[0] ?? null;
  }

  close(): void {
    // Both must be released. disconnectSync alone leaves the underlying
    // DuckDBInstance open, which keeps the OS file lock — fatal for any other
    // process that needs read-write access (poller, classifier, MetricCalc).
    // Discovered 2026-05-05 when the dashboard's per-request open/close cycle
    // was found to hold the lock continuously.
    this.conn.disconnectSync();
    this.instance.closeSync();
  }
}

/**
 * Append a structured failure entry to the central failure log.
 * Used by AWPoller / MetricCalc / Classifier / etc. when something goes wrong.
 *
 * Delegates to the core logFailure (routes via kayaHomePath — honors KAYA_HOME,
 * no hardcoded paths). Adds the "AppUsageTracker:" prefix if not already present
 * so callers can pass bare names ("Classifier") or pre-prefixed ones without
 * double-prefixing. Kept async so existing `await logFailure(...)` callers compile
 * without changes.
 */
export async function logFailure(source: string, error: unknown, context?: Record<string, unknown>): Promise<void> {
  const prefixed = source.startsWith("AppUsageTracker:") ? source : `AppUsageTracker:${source}`;
  _coreLogFailure(prefixed, error, context);
}
