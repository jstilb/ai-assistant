#!/usr/bin/env bun
/**
 * LedgerReader.ts — read-only totals from events.db's `youtube_deletions`
 * ledger, grouped by surface.
 *
 * events.db has a single DuckDB writer lock shared with the AppUsage
 * pipeline (spec.md §5, §13). Every touch here:
 *   - opens READ_ONLY (matches Explore.ts/SqlUI.ts's established idiom for
 *     read-only tools against this same database — guarantees zero writes
 *     at the DB layer, not just "the SQL we happen to send is a SELECT").
 *   - is wrapped in a hard timeout so a stuck open/query fails loud instead
 *     of hanging.
 *   - on real lock contention (verified live: DuckDB throws synchronously
 *     with "Could not set lock..." rather than blocking/retrying — see the
 *     scratch experiment referenced in the build report), throws
 *     LedgerLockError immediately. It NEVER silently queues or retries —
 *     that is the job-reconciler `--dry-run`-still-writes anti-pattern this
 *     deliberately avoids.
 *   - always fully closes the connection in a `finally` (DuckDB only
 *     releases its OS lock on full close, per Db.ts's close() comment).
 *
 * A missing table (fresh events.db, no /youtube run has ever written a
 * ledger row) degrades to zero totals + a note rather than throwing.
 */

import { DuckDBInstance, type DuckDBConnection, type DuckDBInstance as DuckDBInstanceT } from "@duckdb/node-api";
// cross-skill-allowed: youtube_deletions lives in AppUsageTracker's events.db by spec (§5) — CONFIG.dbPath is the single source of truth for that path; one consumer, seam not yet earned (ADR-006)
import { CONFIG } from "../../AppUsageTracker/Config.ts";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface SurfaceTotals {
  history: number;
  watch_later: number;
}

export interface LedgerReadResult {
  totals: SurfaceTotals;
  note: string | null;
}

export class LedgerLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerLockError";
  }
}

export class LedgerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerTimeoutError";
  }
}

// Exported (not just used internally) so LedgerWriter.ts and ReconcileRun.ts
// can classify the exact same DuckDB error shapes instead of duplicating
// this detection — all three files touch the same youtube_deletions table
// through the same DuckDB error surface.
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isLockContention(err: unknown): boolean {
  return errMessage(err).includes("Could not set lock");
}

export function isMissingDb(err: unknown): boolean {
  return errMessage(err).includes("database does not exist");
}

export function isMissingTable(err: unknown): boolean {
  const msg = errMessage(err);
  return msg.includes("Table with name") && msg.includes("does not exist");
}

/**
 * Race `promise` against a `ms`-millisecond timer. Rejects with
 * LedgerTimeoutError (not the raw timer error) if the timer wins, so
 * callers can distinguish "timed out" from "the operation itself failed"
 * without inspecting message text.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LedgerTimeoutError(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Exported so ReconcileRun.ts (a second read-only consumer of this exact
// open-with-timeout, lock-safe pattern) doesn't reimplement it — two real
// consumers is the point where sharing earns its place (deletion test).
export async function openReadOnly(dbPath: string, timeoutMs: number): Promise<{ conn: DuckDBConnection; instance: DuckDBInstanceT }> {
  const instance = await withTimeout(
    DuckDBInstance.create(dbPath, { access_mode: "READ_ONLY" }),
    timeoutMs,
    "events.db open",
  );
  const conn = await withTimeout(instance.connect(), timeoutMs, "events.db connect");
  return { conn, instance };
}

/**
 * Read total ledger row counts per surface (`history`, `watch_later`).
 *
 * Throws LedgerLockError on lock contention or LedgerTimeoutError if the
 * read doesn't complete within `timeoutMs` — both fail loud, neither is
 * swallowed. Degrades (returns, does not throw) to `{ totals: {history: 0,
 * watch_later: 0}, note }` when events.db or the `youtube_deletions` table
 * doesn't exist yet.
 */
export async function readLedgerTotals(
  dbPath: string = CONFIG.dbPath,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<LedgerReadResult> {
  const zero: SurfaceTotals = { history: 0, watch_later: 0 };

  let opened: { conn: DuckDBConnection; instance: DuckDBInstanceT };
  try {
    opened = await openReadOnly(dbPath, timeoutMs);
  } catch (err) {
    if (err instanceof LedgerTimeoutError) throw err;
    if (isMissingDb(err)) {
      return { totals: zero, note: "events.db not found — no AppUsage pipeline run has landed yet" };
    }
    if (isLockContention(err)) {
      throw new LedgerLockError(
        `events.db is locked by another writer (AppUsage pipeline?) — refusing to queue silently: ${errMessage(err)}`,
      );
    }
    throw err;
  }

  const { conn, instance } = opened;
  try {
    const reader = await withTimeout(
      conn.runAndReadAll(`SELECT surface, COUNT(*) AS n FROM youtube_deletions GROUP BY surface`),
      timeoutMs,
      "youtube_deletions query",
    );
    const rows = reader.getRowObjects() as { surface: unknown; n: unknown }[];
    const totals: SurfaceTotals = { history: 0, watch_later: 0 };
    for (const row of rows) {
      const n = typeof row.n === "bigint" ? Number(row.n) : Number(row.n);
      if (row.surface === "history") totals.history = n;
      else if (row.surface === "watch_later") totals.watch_later = n;
    }
    return { totals, note: null };
  } catch (err) {
    if (err instanceof LedgerTimeoutError) throw err;
    if (isMissingTable(err)) {
      return {
        totals: zero,
        note: "youtube_deletions table not yet created — no /youtube run has written a ledger row yet",
      };
    }
    if (isLockContention(err)) {
      throw new LedgerLockError(`events.db lock contention during read: ${errMessage(err)}`);
    }
    throw err;
  } finally {
    // Both must be released — disconnectSync alone leaves the OS lock held
    // (same rule as Db.ts's close()).
    conn.disconnectSync();
    instance.closeSync();
  }
}
