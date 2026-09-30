#!/usr/bin/env bun
/**
 * LedgerWriter.ts — THE one coded invariant (spec.md §5, §6; ticket 04 pt 4).
 *
 * Writes ONE `youtube_deletions` row and CONFIRMS it landed (re-read by
 * run_id + video_id + surface) BEFORE resolving. The caller (SKILL.md's
 * prune/wl runbooks) performs the destructive click ONLY after this promise
 * resolves — "no write, no delete" is the binding invariant this file exists
 * to enforce structurally: there is no path here that could report success
 * without a confirmed re-read, and there is no delete/update API anywhere in
 * this module to accidentally call first.
 *
 * APPEND-ONLY, by construction: this file exports exactly one write
 * function, `writeLedgerRow()`. No updateLedgerRow/deleteLedgerRow export
 * exists anywhere in this module (see LedgerWriter.test.ts's "no such
 * export" assertion) — mirrors IntentParser/IntentWriter's structural
 * parse-only/write-only split elsewhere in this skill.
 *
 * Ensures the table exists via AppUsageTracker's REAL init path
 * (`Db.open()` + `db.initSchema()` — idempotent `CREATE TABLE IF NOT
 * EXISTS`, run on every write per DBInit.ts's own "cheap; no-op when
 * present" doc) rather than reimplementing the DDL here, which would drift
 * from schema.sql over time.
 *
 * events.db discipline (spec.md §5, §13): single DuckDB writer lock shared
 * with the AppUsage pipeline. Open/init/insert/confirm-read are each
 * wrapped in a timeout (reusing LedgerReader.ts's `withTimeout` — the same
 * skill's read side hit and solved this exact problem first). Real lock
 * contention (DuckDB throws synchronously with "Could not set lock...",
 * verified live — see LedgerReader.ts's header) is surfaced as the same
 * `LedgerLockError` the reader throws, never silently retried or queued.
 * The connection is always fully closed in `finally` (DuckDB only releases
 * its OS lock on full close, not on disconnect alone — Db.ts's close()
 * comment).
 */

// cross-skill-allowed: youtube_deletions lives in AppUsageTracker's events.db by spec (§5); Db.open()+initSchema() is the real, idempotent init path — reimplementing the DDL here would drift from schema.sql (ADR-006, one consumer, seam not yet earned)
import { Db } from "../../AppUsageTracker/Tools/Db.ts";
// cross-skill-allowed: CONFIG.dbPath is the single source of truth for events.db's location (ADR-006, same seam as LedgerReader.ts)
import { CONFIG } from "../../AppUsageTracker/Config.ts";
import { errMessage, isLockContention, LedgerLockError, LedgerTimeoutError, withTimeout } from "./LedgerReader.ts";

const DEFAULT_TIMEOUT_MS = 8_000;

/** The only actions the ledger schema's `actions` column is expected to carry (spec.md §5, §6, §7, §8). */
export const VALID_ACTIONS = [
  "deleted",
  "not-interested",
  "dont-recommend",
  "someday-add",
  "wl-removed",
] as const;
export type LedgerAction = (typeof VALID_ACTIONS)[number];
const VALID_ACTION_SET: ReadonlySet<string> = new Set(VALID_ACTIONS);

export type LedgerSurface = "history" | "watch_later";

export interface LedgerRowInput {
  videoId: string;
  title?: string | null;
  channel?: string | null;
  /** As rendered; history surface only. Must be omitted/null for watch_later — WL renders no added-dates (spec.md §5). */
  watchedAt?: string | null;
  surface: LedgerSurface;
  actions: LedgerAction[];
  /** The LLM's one-line judgment, verbatim. No sensitive-marker vocabulary — that's a rubric-level discipline (Rubric.md), not something this module detects or enforces. */
  reason: string;
  /** Surface-specific rendered fields (WL: duration, published-ago, list position, resume fraction). Stored as JSON text. */
  extra?: Record<string, unknown> | null;
  runId: string;
}

export interface LedgerWriteOptions {
  dbPath?: string;
  timeoutMs?: number;
  /** Injectable clock for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
}

export interface LedgerWriteResult {
  videoId: string;
  runId: string;
  surface: LedgerSurface;
  actions: LedgerAction[];
  /** The `created_at` value read back from the confirm re-read — i.e. actually landed, not merely the value this call attempted to write. */
  createdAt: string;
}

function validateInput(input: LedgerRowInput): { videoId: string; reason: string; actionsJoined: string } {
  const videoId = input.videoId.trim();
  if (!videoId) throw new Error("LedgerWriter: videoId is required");

  if (input.surface !== "history" && input.surface !== "watch_later") {
    throw new Error(`LedgerWriter: invalid surface "${String(input.surface)}" (must be "history" or "watch_later")`);
  }

  if (!Array.isArray(input.actions) || input.actions.length === 0) {
    throw new Error("LedgerWriter: at least one action is required");
  }
  for (const a of input.actions) {
    if (!VALID_ACTION_SET.has(a)) {
      throw new Error(`LedgerWriter: unknown action "${String(a)}" (valid: ${VALID_ACTIONS.join(", ")})`);
    }
  }

  const reason = input.reason.trim();
  if (!reason) throw new Error("LedgerWriter: reason is required");

  if (input.surface === "watch_later" && input.watchedAt) {
    throw new Error(
      "LedgerWriter: watchedAt must be omitted for watch_later rows (WL renders no added-dates — spec.md §5)",
    );
  }

  return { videoId, reason, actionsJoined: input.actions.join(",") };
}

/**
 * Write one append-only ledger row and confirm it landed BEFORE resolving.
 *
 * Throws (never silently degrades) on: invalid input, lock contention
 * (`LedgerLockError`), timeout (`LedgerTimeoutError`), or — the case that
 * matters most — an INSERT that reports success but the confirm re-read
 * finds no matching row (refuses to report success; "no write, no delete"
 * has to mean the write is PROVEN, not merely attempted).
 */
export async function writeLedgerRow(
  input: LedgerRowInput,
  options: LedgerWriteOptions = {},
): Promise<LedgerWriteResult> {
  const { videoId, reason, actionsJoined } = validateInput(input);

  const dbPath = options.dbPath ?? CONFIG.dbPath;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const createdAt = (options.now ?? new Date()).toISOString();
  const extraJson = input.extra ? JSON.stringify(input.extra) : null;

  let db: Db;
  try {
    db = await withTimeout(Db.open(dbPath), timeoutMs, "events.db open (write)");
  } catch (err) {
    if (err instanceof LedgerTimeoutError) throw err;
    if (isLockContention(err)) {
      throw new LedgerLockError(
        `events.db is locked by another writer (AppUsage pipeline?) — refusing to queue silently: ${errMessage(err)}`,
      );
    }
    throw err;
  }

  try {
    // Idempotent CREATE TABLE IF NOT EXISTS through the real init path —
    // cheap (DBInit.ts's own doc: "no-op when present") and guarantees the
    // ledger table exists via the SAME DDL production uses, never a second
    // copy of the schema.
    await withTimeout(db.initSchema(), timeoutMs, "events.db schema init");

    await withTimeout(
      db.run(
        `INSERT INTO youtube_deletions
           (video_id, title, channel, watched_at, surface, actions, reason, extra, run_id, created_at)
         VALUES ($video_id, $title, $channel, $watched_at::TIMESTAMP, $surface, $actions, $reason, $extra, $run_id, $created_at::TIMESTAMP)`,
        {
          video_id: videoId,
          title: input.title ?? null,
          channel: input.channel ?? null,
          watched_at: input.watchedAt ?? null,
          surface: input.surface,
          actions: actionsJoined,
          reason,
          extra: extraJson,
          run_id: input.runId,
          created_at: createdAt,
        },
      ),
      timeoutMs,
      "youtube_deletions insert",
    );

    // Confirm-by-re-read BEFORE returning success. CAST(... AS VARCHAR) —
    // DuckDB's node-api returns raw TIMESTAMP columns as BigInt-backed
    // wrapper objects (verified live; see SqlUI.ts's toScalar() for the
    // same discovery), so casting in SQL is simpler and more explicit than
    // relying on the wrapper's toString().
    const confirmRows = await withTimeout(
      db.queryAll<{ created_at: string; actions: string }>(
        `SELECT CAST(created_at AS VARCHAR) AS created_at, actions FROM youtube_deletions
          WHERE run_id = $run_id AND video_id = $video_id AND surface = $surface
          ORDER BY created_at DESC LIMIT 1`,
        { run_id: input.runId, video_id: videoId, surface: input.surface },
      ),
      timeoutMs,
      "youtube_deletions confirm read",
    );

    const confirmed = confirmRows[0];
    if (!confirmed) {
      throw new Error(
        `LedgerWriter: INSERT reported success but the confirm re-read found NO row for ` +
          `run_id="${input.runId}" video_id="${videoId}" surface="${input.surface}" — refusing to ` +
          `report success (no write, no delete).`,
      );
    }
    if (confirmed.actions !== actionsJoined) {
      throw new Error(
        `LedgerWriter: confirm re-read found actions="${confirmed.actions}" but expected ` +
          `"${actionsJoined}" — refusing to report success.`,
      );
    }

    return {
      videoId,
      runId: input.runId,
      surface: input.surface,
      actions: input.actions,
      createdAt: confirmed.created_at,
    };
  } catch (err) {
    if (err instanceof LedgerTimeoutError || err instanceof LedgerLockError) throw err;
    if (isLockContention(err)) {
      throw new LedgerLockError(`events.db lock contention during write: ${errMessage(err)}`);
    }
    throw err;
  } finally {
    // Always fully close — disconnectSync alone leaves the OS lock held
    // (Db.ts's close() comment; same rule LedgerReader.ts follows).
    db.close();
  }
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const videoId = flag(argv, "--video-id");
  const surface = flag(argv, "--surface");
  const actionsRaw = flag(argv, "--actions");
  const reason = flag(argv, "--reason");
  const runId = flag(argv, "--run-id");
  const title = flag(argv, "--title");
  const channel = flag(argv, "--channel");
  const watchedAt = flag(argv, "--watched-at");
  const extraRaw = flag(argv, "--extra");
  // Overrides CONFIG.dbPath, which is hardcoded to the LIVE
  // `~/.claude/MEMORY/AppUsage/events.db` and does NOT honor KAYA_HOME
  // (verified: Config.ts's dbPath is a literal template string, not
  // getKayaHome()-derived). Without this flag there is no way to point the
  // CLI at a throwaway db for a demo/dry-run without risking a live write —
  // real `/youtube prune` runs simply omit it and get the live path.
  const dbPath = flag(argv, "--db-path");

  if (!videoId || !surface || !actionsRaw || !reason || !runId) {
    console.error(
      "Usage: bun LedgerWriter.ts --video-id <id> --surface history|watch_later " +
        `--actions ${VALID_ACTIONS.join("|")}[,...] --reason "<text>" --run-id <id> ` +
        '[--title <t>] [--channel <c>] [--watched-at <iso>] [--extra \'{"k":"v"}\'] [--db-path <path>]',
    );
    process.exit(1);
  }

  const actions = actionsRaw.split(",").map((a) => a.trim()) as LedgerAction[];
  const extra = extraRaw ? (JSON.parse(extraRaw) as Record<string, unknown>) : null;

  const result = await writeLedgerRow(
    {
      videoId,
      surface: surface as LedgerSurface,
      actions,
      reason,
      runId,
      title: title ?? null,
      channel: channel ?? null,
      watchedAt: watchedAt ?? null,
      extra,
    },
    dbPath ? { dbPath } : {},
  );

  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
