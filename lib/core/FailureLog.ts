/**
 * FailureLog — Centralized failure logging for the Kaya pipeline.
 *
 * Appends one JSON line to MEMORY/MONITORING/failure-log.jsonl for every
 * caught error. Shared infra: consumed by QueueRouter, SpecSheet, and the
 * parallel LucidTasks+AutoInfo effort.
 *
 * MUST NEVER THROW — wrap everything in try/catch.
 *
 * ## Entry points
 *
 *   logFailure(source, error, context)  — backward-compat thin wrapper;
 *     always silent (tier 'log'). All ~30 existing callers use this.
 *
 *   recordFailure(event)  — unified entry point introduced in Slice 1.
 *     Writes the forensic JSONL line AND, for tier 'digest'/'page', bridges
 *     to AlertGate via a static import. AlertGate.send() is async (T2-01)
 *     and never throws (see AlertGate.ts) — this bridge deliberately does
 *     NOT await it: recordFailure() stays synchronous, the send() promise
 *     runs to completion in the background regardless, and it still
 *     correctly gates its own cooldown by the time it resolves. Wrapped
 *     defensively anyway (belt-and-suspenders).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { kayaHomePath, assertNotLiveHomeUnderTest } from './KayaHome.ts';
import { createAppendLog } from './AppendLog.ts';
import { getAlertGate, type AlertTier } from './AlertGate.ts';

const LOG_RELPATH = 'MEMORY/MONITORING/failure-log.jsonl';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Unified failure event. `logFailure` is a thin wrapper that calls
 * recordFailure({ source, error, context }) — identical on-disk schema.
 */
export interface FailureEvent {
  /** Module/caller identifier, e.g. "SpecPipelineRunner:runResearchPhase". */
  source: string;
  /** The caught error (Error instance, string, or any unknown value). */
  error?: unknown;
  /** Optional key/value context (item id, phase, etc.). */
  context?: Record<string, unknown>;
  /**
   * Alert routing tier. Default 'log' — forensic only, no notification.
   * 'digest' → spooled to daily SystemHealthDigest.
   * 'page'   → immediate Telegram page (edge-triggered, cooldown-gated).
   */
  tier?: AlertTier;
  /**
   * Stable alert key for dedup/cooldown in AlertGate.
   * Default: event.source.
   */
  alertKey?: string;
  /**
   * Message sent to AlertGate. Default: derived from error.message.
   */
  alertMessage?: string;
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

/**
 * Unified entry point: append a forensic JSONL line and, for tier 'digest'
 * or 'page', bridge synchronously to AlertGate.
 *
 * MUST NEVER THROW in production. Exception: under NODE_ENV=test, throws if
 * KAYA_HOME resolves to the live default instead of a pinned test sandbox —
 * see assertNotLiveHomeUnderTest() in KayaHome.ts. That is a deliberate
 * hermetic-guard tripwire, not a violation of the never-throw contract: it
 * exists precisely so a misconfigured test fails loudly instead of silently
 * writing into the live Kaya home.
 */
export function recordFailure(e: FailureEvent): void {
  assertNotLiveHomeUnderTest('FailureLog.recordFailure');
  try {
    const tier = e.tier ?? 'log';

    // Build the error sub-object — matches original schema exactly.
    const errorField =
      e.error === undefined
        ? { message: '' }
        : e.error instanceof Error
          ? { message: e.error.message, stack: e.error.stack }
          : { message: String(e.error) };

    // JSONL line — strict superset of original schema.
    // Write `tier` only when non-default so existing readers see no new field.
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      source: e.source,
      error: errorField,
      context: e.context ?? {},
    };
    if (tier !== 'log') record['tier'] = tier;

    const logPath = kayaHomePath(LOG_RELPATH);
    // maxSizeBytes disabled — this module's own rotateFailureLog() (below)
    // owns rotation on a content-aware (record age) policy that AppendLog's
    // generic size-based rotation cannot express; AppendLog is used here
    // purely as the safe, lint-compliant write primitive.
    createAppendLog(logPath, { maxSizeBytes: Number.MAX_SAFE_INTEGER }).append(record);

    // Bridge to AlertGate for digest/page tiers — async, fire-and-forget
    // (see the static `getAlertGate` import above; AlertGate.send() became
    // async under T2-01). Deliberately not awaited: this call's own promise
    // still runs to completion in the background, and AlertGate.send() never
    // throws on its own (see AlertGate.ts), but wrapped defensively anyway so
    // a bridge failure can never affect the forensic write above, which has
    // already completed by this point.
    if (tier === 'digest' || tier === 'page') {
      const msg = e.alertMessage ?? errorField.message;
      const key = e.alertKey ?? e.source;
      const fingerprint = `${e.source}:${errorField.message}`;
      try {
        getAlertGate().send(msg, { key, tier, fingerprint });
      } catch {
        // intentionally silent: AlertGate.send() catches its own errors; this
        // belt-and-suspenders guard would only fire on a programming error, and
        // must never affect the forensic write already completed above.
      }
    }
  } catch (err) {
    // fable-audit batch2 (same shape as AlertGate.ts's Finding A): this used
    // to swallow with zero trace — a genuine failure to write the forensic
    // JSONL line (e.g. ENOSPC/EACCES, a future bug in the record-building
    // above) was indistinguishable from working as intended. Fix ADDS
    // visibility only — recordFailure() still never throws (contract
    // unchanged; see this function's own doc comment), it now just says so
    // loudly instead of silently.
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    console.error(
      `[FailureLog] INTERNAL ERROR in recordFailure() (source="${e.source}") — this failure ` +
        `event was just silently dropped by an unexpected exception: ${detail}`,
    );
  }
}

/**
 * Append a structured failure entry to the central failure log.
 *
 * Backward-compatible thin wrapper over recordFailure. Tier is always 'log'
 * (silent/forensic). All ~30 existing callers use this; do not change them.
 *
 * @param source  - Module/caller identifier, e.g. "SpecPipelineRunner:runResearchPhase"
 * @param error   - The caught error (Error instance or unknown)
 * @param context - Optional key/value context (item id, phase, etc.)
 */
export function logFailure(
  source: string,
  error: unknown,
  context?: Record<string, unknown>
): void {
  recordFailure({ source, error, context });
}

// ---------------------------------------------------------------------------
// Slice 1b: Rotation helper
//
// Called by AutoMaintenance daily workflow. NOT in the hot append path.
//
// Policy:
//   - Lines older than ROTATE_AGE_DAYS → archive to failure-log-YYYY-MM.jsonl
//   - Rotation triggered when the live file is over ROTATE_SIZE_BYTES OR any
//     line qualifies for archival.
//   - Archive files are appended (idempotent across re-runs that don't advance
//     the clock), live file is rewritten atomically (tmp → rename).
//   - MUST NEVER THROW — errors logged via console.warn.
// ---------------------------------------------------------------------------

const ROTATE_AGE_DAYS = 90;
const ROTATE_SIZE_BYTES = 500 * 1024; // 500 KB

export interface RotationResult {
  skipped: boolean;
  linesRetained: number;
  linesArchived: number;
  archiveFiles: string[];
}

/**
 * Rotate the failure log: archive lines older than 90 days, rewrite the live
 * file with recent entries. Idempotent — safe to call every day.
 *
 * @param overrideLogPath  - For tests: absolute path to the live log file.
 *   Defaults to kayaHomePath('MEMORY/MONITORING/failure-log.jsonl').
 */
export function rotateFailureLog(overrideLogPath?: string): RotationResult {
  const logPath = overrideLogPath ?? kayaHomePath(LOG_RELPATH);
  const logDir = dirname(logPath);

  try {
    if (!existsSync(logPath)) return { skipped: true, linesRetained: 0, linesArchived: 0, archiveFiles: [] };

    const raw = readFileSync(logPath, 'utf-8');
    const fileSize = Buffer.byteLength(raw, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);

    // Determine cutoff timestamp.
    const cutoffMs = Date.now() - ROTATE_AGE_DAYS * 24 * 60 * 60 * 1000;

    // Partition: recent vs old.
    const recent: string[] = [];
    const old: string[] = [];
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as { ts?: string };
        const tsMs = rec.ts ? Date.parse(rec.ts) : NaN;
        if (Number.isFinite(tsMs) && tsMs < cutoffMs) {
          old.push(line);
        } else {
          recent.push(line);
        }
      } catch {
        // Unparseable line → keep in live file rather than lose it.
        recent.push(line);
      }
    }

    // Skip rotation if live file is small and nothing to archive.
    if (old.length === 0 && fileSize < ROTATE_SIZE_BYTES) {
      return { skipped: true, linesRetained: recent.length, linesArchived: 0, archiveFiles: [] };
    }

    // Group old lines by YYYY-MM for per-month archive files.
    const byMonth = new Map<string, string[]>();
    for (const line of old) {
      try {
        const rec = JSON.parse(line) as { ts?: string };
        const month = (rec.ts ?? '').substring(0, 7); // "YYYY-MM"
        const key = month || 'unknown';
        if (!byMonth.has(key)) byMonth.set(key, []);
        byMonth.get(key)!.push(line);
      } catch {
        // Put in 'unknown' bucket.
        if (!byMonth.has('unknown')) byMonth.set('unknown', []);
        byMonth.get('unknown')!.push(line);
      }
    }

    // Append old lines to per-month archive files.
    const archiveFiles: string[] = [];
    for (const [month, archiveLines] of Array.from(byMonth.entries())) {
      const archivePath = join(logDir, `failure-log-${month}.jsonl`);
      try {
        // maxSizeBytes disabled — archive files are append-only monthly
        // buckets with no size-based rotation of their own; AppendLog is
        // used here purely as the safe write primitive (dir creation +
        // the underlying fs append call), not for its rotation policy.
        createAppendLog(archivePath, { maxSizeBytes: Number.MAX_SAFE_INTEGER }).appendRaw(archiveLines.join('\n'));
        if (!archiveFiles.includes(archivePath)) archiveFiles.push(archivePath);
      } catch (err) {
        console.warn(`[FailureLog] rotation: failed to write archive ${archivePath}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Atomically rewrite live file: write to .tmp then rename.
    const tmpPath = logPath + '.tmp';
    try {
      writeFileSync(tmpPath, recent.length > 0 ? recent.join('\n') + '\n' : '', 'utf-8');
      renameSync(tmpPath, logPath);
    } catch (err) {
      console.warn(`[FailureLog] rotation: failed to rewrite live log: ${err instanceof Error ? err.message : err}`);
      // Don't leave a .tmp behind.
      try { if (existsSync(tmpPath)) renameSync(tmpPath, logPath); } catch { /* best effort */ }
    }

    return { skipped: false, linesRetained: recent.length, linesArchived: old.length, archiveFiles };
  } catch (err) {
    console.warn(`[FailureLog] rotation failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    return { skipped: true, linesRetained: 0, linesArchived: 0, archiveFiles: [] };
  }
}
