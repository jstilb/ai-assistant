/**
 * MemoryPaths — Canonical constants and typed accessors for MEMORY/ files.
 *
 * Two layers:
 *   1. Lazy-getter constants (MEMORY.STATE(), MEMORY.WORK_QUEUE_JSON(), etc.)
 *      — when the caller only needs the path string.
 *   2. Typed accessors under MEMORY.state.* and MEMORY.work.*
 *      — when the caller needs to read/write the file. Each accessor owns
 *      the path AND the JSON.parse AND the Zod validation, so callers do not
 *      hand-roll readFileSync + JSON.parse + ad-hoc shape access.
 *
 * Every path under MEMORY/ that is accessed by more than one file must be
 * defined here. Files that access only their own skill-local state are exempt.
 *
 * All values are getter functions (not string constants) because getKayaHome()
 * must be evaluated at call time — not module load time — so that test overrides
 * via process.env.KAYA_HOME work correctly.
 *
 * Using title-case 'State' to match the existing directory on disk.
 * Note: P2-HooksConsolidation spec Item 8 references 'MEMORY/STATE/' (all caps)
 * as the canonical form — that spec's casing guidance is superseded by this module.
 * Use MEMORY.STATE() which resolves to MEMORY/State/ on all platforms.
 *
 * Usage:
 *   import { MEMORY, memPath } from 'lib/core/MemoryPaths.ts';
 *   const dir = MEMORY.NOTIFICATIONS();        // absolute path to directory
 *   const file = MEMORY.NOTIFICATIONS_JSONL(); // absolute path to file
 *   const custom = memPath('LEARNING', 'SIGNALS', 'foo.jsonl');
 *
 *   // Typed accessor (Slices 1+ add concrete accessors under .state and .work):
 *   const limits = MEMORY.state.rateLimits.read();   // RateLimits | null
 *   MEMORY.state.rateLimits.write(next);             // atomic tmp+rename
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { z, type ZodType } from 'zod';
import { getKayaHome } from './KayaHome.ts';

function lazyPath(...segments: string[]): string {
  return [getKayaHome(), 'MEMORY', ...segments].join('/');
}

// ── Typed file-accessor factory (Slice 0 of candidate #2) ────────────────────

/**
 * Typed accessor for a single MEMORY/ file. Owns path resolution, JSON
 * parsing, and schema validation behind one seam.
 *
 * `read()` is forgiving by design: missing file, JSON parse failure, and
 * Zod validation failure all return null. Parse and validation failures
 * also log a `[MemoryPaths:<label>]` warning so corruption is observable.
 * Callers that need stricter semantics use `readStrict()`.
 *
 * `update()` is the read-mutate-write pattern over a known-existing file.
 * For files that may be missing, compose `read() ?? default` + `write()`.
 */
export interface FileAccessor<T> {
  /** Absolute path to the file (lazy — respects KAYA_HOME override). */
  path(): string;
  /** Returns the parsed + validated value, or null on missing/corrupt/invalid. */
  read(): T | null;
  /** Returns the parsed + validated value, or throws. */
  readStrict(): T;
  /** Atomic write via tmp file + rename. Creates parent directory if missing. */
  write(value: T): void;
  /** Read → mutate → write. Throws if the file is missing or invalid. */
  update(mutator: (current: T) => T): T;
  /** Underlying Zod schema (exposed for callers that want their own validation). */
  readonly schema: ZodType<T, unknown>;
}

/**
 * Build a typed accessor over a single JSON file under MEMORY/.
 *
 * The label is used in warning messages — keep it short and unique
 * (e.g. "rateLimits", "workQueue"). Path is resolved at call time so
 * KAYA_HOME overrides take effect inside tests.
 */
export function defineFileAccessor<T>(
  label: string,
  pathFn: () => string,
  schema: ZodType<T, unknown>,
): FileAccessor<T> {
  const accessor: FileAccessor<T> = {
    path: pathFn,
    schema,
    read(): T | null {
      const filepath = pathFn();
      if (!existsSync(filepath)) return null;
      let raw: string;
      try {
        raw = readFileSync(filepath, 'utf-8');
      } catch (err) {
        console.warn(`[MemoryPaths:${label}] read failed: ${(err as Error).message}`);
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.warn(`[MemoryPaths:${label}] JSON parse failed: ${(err as Error).message}`);
        return null;
      }
      const result = schema.safeParse(parsed);
      if (!result.success) {
        console.warn(`[MemoryPaths:${label}] validation failed: ${result.error.message}`);
        return null;
      }
      return result.data;
    },
    readStrict(): T {
      const filepath = pathFn();
      if (!existsSync(filepath)) {
        throw new Error(`[MemoryPaths:${label}] missing file: ${filepath}`);
      }
      const raw = readFileSync(filepath, 'utf-8');
      const parsed = JSON.parse(raw);
      return schema.parse(parsed);
    },
    write(value: T): void {
      const filepath = pathFn();
      const dir = dirname(filepath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmpPath = `${filepath}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
      renameSync(tmpPath, filepath);
    },
    update(mutator: (current: T) => T): T {
      const current = accessor.readStrict();
      const next = mutator(current);
      accessor.write(next);
      return next;
    },
  };
  return accessor;
}

// Re-export Zod for downstream slices that define schemas alongside accessors.
// (The former `ZodSchema` type re-export had zero importers — deleted, F7.)
export { z };
export type { ZodType };

// ── Schemas for typed accessors ──────────────────────────────────────────────

/**
 * MEMORY/State/rate-limits.json — written by statusline-command.sh, read by
 * RateLimitGuard and WorkQueue's rate-limit gate. Both windows are nullable
 * (no recent measurement) and so is updatedAt (tolerated absent for legacy
 * fixtures), but any present field must match the shape.
 */
export const RateLimitWindowSchema = z.object({
  usedPercentage: z.number(),
  resetsAt: z.string(),
});
export type RateLimitWindow = z.infer<typeof RateLimitWindowSchema>;

export const RateLimitsSchema = z.object({
  fiveHour: RateLimitWindowSchema.nullable(),
  sevenDay: RateLimitWindowSchema.nullable(),
  updatedAt: z.string().optional(),
});
export type RateLimits = z.infer<typeof RateLimitsSchema>;

/**
 * MEMORY/WORK/work-queue.json — the autonomous work queue.
 *
 * Items use a permissive `Record<string, unknown>` shape because the canonical
 * `WorkItem` type lives in `skills/Automation/AutonomousWork/Tools/WorkQueue.ts`
 * and `lib/core/` must not depend on `skills/`. Consumers that need the rich
 * `WorkItem` shape (the WorkQueue class itself, its tests) cast at the seam.
 * Consumers that read a small subset (CommitWorkReminder, MemoryCleanup) keep
 * their own narrow local type.
 *
 * Use `.passthrough()` so additional top-level keys (added later) survive a
 * read→write round-trip.
 */
export const WorkQueueStateSchema = z
  .object({
    items: z.array(z.record(z.string(), z.unknown())).default([]),
    lastUpdated: z.string().optional(),
    totalProcessed: z.number().optional(),
    totalFailed: z.number().optional(),
  })
  .passthrough();
export type WorkQueueState = z.infer<typeof WorkQueueStateSchema>;

/**
 * MEMORY/State/integrity-state.json — written by SystemIntegrity hook,
 * read by change-detection helpers (cooldown / dedup checks). Two readers
 * + one writer share this shape, so it earns a typed accessor.
 */
export const IntegrityStateSchema = z.object({
  last_run: z.string(),
  last_changes_hash: z.string(),
  cooldown_until: z.string().nullable(),
});
export type IntegrityState = z.infer<typeof IntegrityStateSchema>;

export const MEMORY = {
  // Root
  ROOT: () => lazyPath(),

  // Top-level dirs
  STATE:           () => lazyPath('State'),
  DAEMON:          () => lazyPath('daemon'),
  NOTIFICATIONS:   () => lazyPath('NOTIFICATIONS'),
  WORK:            () => lazyPath('WORK'),
  MONITORING:      () => lazyPath('MONITORING'),
  SECURITY:        () => lazyPath('security'),
  LEARNING:        () => lazyPath('LEARNING'),
  KNOWLEDGE:       () => lazyPath('KNOWLEDGE'),
  BRIEFINGS:       () => lazyPath('BRIEFINGS'),
  AUTOMAINTENANCE: () => lazyPath('AutoMaintenance'),
  EVAL_SIGNALS:    () => lazyPath('EVAL_SIGNALS'),
  QUEUES:          () => lazyPath('QUEUES'),
  ENTRIES:         () => lazyPath('entries'),
  VOICE:           () => lazyPath('VOICE'),
  PROGRESS:        () => lazyPath('State', 'progress'),

  // Well-known files
  NOTIFICATIONS_JSONL:    () => lazyPath('NOTIFICATIONS', 'notifications.jsonl'),
  WORK_QUEUE_JSON:        () => lazyPath('WORK', 'work-queue.json'),
  AGENT_SESSIONS_JSON:    () => lazyPath('State', 'agent-sessions.json'),
  CONTEXT_CLASSIFICATION: () => lazyPath('State', 'context-classification.json'),
  CONTEXT_SESSION:        () => lazyPath('State', 'context-session.json'),
  INTEGRITY_STATE:        () => lazyPath('State', 'integrity-state.json'),
  RATE_LIMITS:            () => lazyPath('State', 'rate-limits.json'),
  TAB_TITLE:              () => lazyPath('State', 'tab-title.json'),
  VOICE_EVENTS:           () => lazyPath('VOICE', 'voice-events.jsonl'),
  DAEMON_MESSAGE_QUEUE:   () => lazyPath('daemon', 'message-queue.json'),
  DAEMON_CRON_STATE:      () => lazyPath('daemon', 'cron', 'state.json'),
  PIPELINE_LOCK:          () => lazyPath('MONITORING', 'state', 'pipeline.lock'),
  ACTIVE_ANOMALIES:       () => lazyPath('MONITORING', 'state', 'active-anomalies.json'),
  ALERTS_JSONL:           () => lazyPath('MONITORING', 'audit', 'alerts.jsonl'),
  MONITOR_AUDIT:          () => lazyPath('MONITORING', 'audit', 'monitor-audit.jsonl'),

  // Typed accessor namespaces — Slices 1+ of candidate #2.
  // Each property holds a FileAccessor<T> built via defineFileAccessor().
  // Lookups go through .read() / .write() / .update() instead of hand-rolled
  // readFileSync + JSON.parse + ad-hoc shape access.
  state: {
    rateLimits: defineFileAccessor(
      'rateLimits',
      () => lazyPath('State', 'rate-limits.json'),
      RateLimitsSchema,
    ),
    integrity: defineFileAccessor(
      'integrity',
      () => lazyPath('State', 'integrity-state.json'),
      IntegrityStateSchema,
    ),
  },
  work: {
    queue: defineFileAccessor(
      'workQueue',
      () => lazyPath('WORK', 'work-queue.json'),
      WorkQueueStateSchema,
    ),
  },
} as const;

/**
 * Build a path under MEMORY/ from segments.
 * Evaluated at call time — respects KAYA_HOME override.
 */
export function memPath(...segments: string[]): string {
  return lazyPath(...segments);
}

/**
 * Build a path under <root>/MEMORY/ for an EXPLICITLY injected root.
 * For classes that take a kayaHome option so tests can stay hermetic
 * without touching process.env (e.g. NotificationDispatcher) — the MEMORY
 * layout knowledge still lives here, not at the call site.
 */
export function memPathUnder(root: string, ...segments: string[]): string {
  return [root, 'MEMORY', ...segments].join('/');
}

// ── Spec-P1 canonical named exports (matches ISC row 9 verification command) ──

export const RATINGS_PATH      = () => lazyPath('LEARNING', 'SIGNALS', 'ratings.jsonl');
export const MONITORING_DIR    = () => lazyPath('MONITORING');
export const SEMANTIC_INDEX_PATH = () => lazyPath('State', 'semantic-index.json');
export const KNOWLEDGE_GRAPH_PATH = () => lazyPath('State', 'knowledge-graph.json');
export const HEALTH_STATE_PATH = () => lazyPath('AutoMaintenance', 'health-state.json');
export const QUEUE_STATE_PATH  = () => lazyPath('QUEUES', 'state.json');
export const MEMORY_INDEX_PATH = () => lazyPath('index.json');
export const APPROVED_WORK_PATH = () => lazyPath('QUEUES', 'approved-work.jsonl');
export const APPROVALS_PATH    = () => lazyPath('QUEUES', 'approvals.jsonl');
export const PENDING_APPROVAL_QUEUE_PATH = () => lazyPath('WORK', 'pending-approval', 'queue.json');
export const RUN_LEDGER_PATH   = () => lazyPath('daemon', 'cron', 'run-ledger.jsonl');
