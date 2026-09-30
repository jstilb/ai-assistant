#!/usr/bin/env bun
/**
 * Kaya Memory Cleanup Utility
 *
 * Cleanup targets with retention policies:
 * - debug/: 14 days (ephemeral, no synthesis needed)
 * - file-history/: 30 days (technical, no synthesis needed)
 * - history.jsonl: 30 days (REQUIRES synthesis first)
 * - voice-events.jsonl: 90 days (REQUIRES synthesis first)
 * - ratings.jsonl: 90 days (REQUIRES synthesis first)
 * - security/*.jsonl: 90 days (audit trail, no synthesis needed)
 *
 * CRITICAL: Run synthesis tools BEFORE cleanup for history, voice-events, ratings.
 *
 * Usage:
 *   bun run MemoryCleanup.ts all [--dry-run] [--json]
 *   bun run MemoryCleanup.ts debug [--dry-run]
 *   bun run MemoryCleanup.ts file-history [--dry-run]
 *   bun run MemoryCleanup.ts logs [--dry-run]
 */

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import { getPipelineRepository } from "../../skills/Automation/QueueRouter/Tools/PipelineRepository.ts";
import { getKayaHome, defaultKayaHome } from "./KayaHome.ts";

// ============================================================================
// Configuration
// ============================================================================

// Resolved at call-time (uncached) so test overrides via process.env.KAYA_HOME
// are picked up immediately. Its tests (scanUnregistered + cleanOrphanedCurrentWork)
// re-pin KAYA_HOME per-test with no manual cache reset, so this must NOT use
// the memoized getKayaHome(); defaultKayaHome() is the uncached, env-independent
// fallback that satisfies the no-inline-kaya-home rule while keeping the
// fresh-env-read semantics.
function getClaudeDir(): string {
  return process.env.KAYA_HOME ?? defaultKayaHome();
}
// Module-level constant used by legacy functions (debug, file-history, etc).
// New functions MUST call getClaudeDir() so tests can override via KAYA_HOME.
// frozen at import (getKayaHome cached); no test re-pins this module for the
// legacy CLAUDE_DIR consumers (debug/file-history/security/history/etc. — all
// exercised only via subprocess in MemoryCleanup.test.ts, so a fresh process
// re-reads env regardless of in-process caching here).
const CLAUDE_DIR = getKayaHome();

// Retention policies (days)
const RETENTION = {
  debug: 14,
  fileHistory: 30,
  history: 30,
  voiceEvents: 90,
  ratings: 90,
  security: 90,
};

// ============================================================================
// JSONL Registry (ISC row 2)
// ============================================================================

interface JsonlRegistryEntry {
  /** Path relative to CLAUDE_DIR, or factory returning absolute path */
  path: string | (() => string);
  /** Retention in days */
  retentionDays: number;
  /** Require synthesis before rotating? */
  requiresSynthesis: boolean;
  synthesisType?: "voice" | "sessions";
  /** Category for reporting */
  category: "monitoring" | "notifications" | "learning" | "work" | "voice" | "security" | "eval" | "daemon";
}

const JSONL_REGISTRY: JsonlRegistryEntry[] = [
  // ── Previously covered ─────────────────────────────────────────────────────
  { path: "history.jsonl",                                          retentionDays: 30,  requiresSynthesis: true,  synthesisType: "sessions", category: "learning"       },
  { path: "MEMORY/VOICE/voice-events.jsonl",                        retentionDays: 90,  requiresSynthesis: true,  synthesisType: "voice",    category: "voice"          },
  // ratings.jsonl: synthesis gate removed 2026-07-10 — the wisdom-frame synthesis
  // pipeline that produced MEMORY/LEARNING/SYNTHESIS/<YYYY-MM>/ artifacts was
  // deleted 2026-07-09, so the gate could never pass again. Rows are ingested
  // into the graph daily (DecisionIngester) long before the 90-day cutoff.
  { path: "MEMORY/LEARNING/SIGNALS/ratings.jsonl",                  retentionDays: 90,  requiresSynthesis: false, category: "learning"       },
  // Security handled separately via glob (cleanSecurityLogs)

  // ── Monitoring ─────────────────────────────────────────────────────────────
  { path: "MEMORY/MONITORING/audit/monitor-audit.jsonl",            retentionDays: 60,  requiresSynthesis: false, category: "monitoring"     },
  { path: "MEMORY/MONITORING/audit/alerts.jsonl",                   retentionDays: 90,  requiresSynthesis: false, category: "monitoring"     },
  { path: "MEMORY/MONITORING/traces/a.jsonl",                       retentionDays: 30,  requiresSynthesis: false, category: "monitoring"     },
  { path: "MEMORY/MONITORING/traces/p1.jsonl",                      retentionDays: 30,  requiresSynthesis: false, category: "monitoring"     },
  // Other MEMORY/MONITORING/traces/*.jsonl handled by glob in cleanAll()

  // ── Notifications ──────────────────────────────────────────────────────────
  { path: "MEMORY/NOTIFICATIONS/notifications.jsonl",               retentionDays: 30,  requiresSynthesis: false, category: "notifications"  },

  // ── Learning signals ──────────────────────────────────────────────────────
  // estimation-accuracy.jsonl: small (≤ a few hundred rows), kept whole — it is
  // the full reference class for the estimation-calibration wisdom frame.

  // ── Eval signals ──────────────────────────────────────────────────────────
  { path: "MEMORY/EVAL_SIGNALS/signals.jsonl",                      retentionDays: 90,  requiresSynthesis: false, category: "eval"           },

  // ── Work audit ─────────────────────────────────────────────────────────────
  { path: "MEMORY/WORK/audit.jsonl",                                retentionDays: 90,  requiresSynthesis: false, category: "work"           },

  // NOTE: MEMORY/QUEUES queue JSONL files (approvals, approved-work, spec-pipeline)
  // were removed from this registry (2026-06-24). pipeline.db is now the source of
  // truth for queue items; the JSONL files are non-authoritative shadows. Rotating
  // them by `entry.timestamp` (not `created`/`updated`) silently deleted all items
  // (epoch-0 timestamps). They must not be swept here.
  // (gemini-sync.jsonl was dropped 2026-07-31 with the GeminiSync skill deletion,
  // T7-06 — it had been registered once under Monitoring above.)

  // ── BrightData scrape audit (BrightData skill — P2 arch review) ────────────
  { path: "MEMORY/MONITORING/audit/brightdata-scrapes.jsonl",       retentionDays: 90,  requiresSynthesis: false, category: "monitoring"     },
];

/** Resolve a registry entry path to an absolute path */
function resolveEntryPath(entry: JsonlRegistryEntry): string {
  if (typeof entry.path === "function") return entry.path();
  if (path.isAbsolute(entry.path)) return entry.path;
  return path.join(getClaudeDir(), entry.path);
}

/** Get all JSONL paths known to the registry (absolute paths) */
export function getRegisteredJsonlPaths(): Set<string> {
  return new Set(JSONL_REGISTRY.map(resolveEntryPath));
}

// ============================================================================
// Types
// ============================================================================

interface CleanupResult {
  target: string;
  filesRemoved: number;
  linesRemoved: number;
  bytesFreed: number;
  errors: string[];
  skipped?: boolean;
  skipReason?: string;
}

interface OverallResult {
  success: boolean;
  timestamp: string;
  dryRun: boolean;
  results: CleanupResult[];
  totalBytesFreed: number;
  totalFilesRemoved: number;
  totalLinesRemoved: number;
}

// ============================================================================
// Utility Functions
// ============================================================================

function getFileAgeInDays(filepath: string): number {
  try {
    const stats = fs.statSync(filepath);
    const now = Date.now();
    const mtime = stats.mtime.getTime();
    return (now - mtime) / (1000 * 60 * 60 * 24);
  } catch {
    return 0;
  }
}

function getDirAgeInDays(dirpath: string): number {
  try {
    const stats = fs.statSync(dirpath);
    const now = Date.now();
    const mtime = stats.mtime.getTime();
    return (now - mtime) / (1000 * 60 * 60 * 24);
  } catch {
    return 0;
  }
}

function getDirectorySize(dirpath: string): number {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirpath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirpath, entry.name);
      if (entry.isDirectory()) {
        size += getDirectorySize(fullPath);
      } else {
        size += fs.statSync(fullPath).size;
      }
    }
  } catch {
    // Ignore errors
  }
  return size;
}

function deleteDirectory(dirpath: string): void {
  if (fs.existsSync(dirpath)) {
    fs.rmSync(dirpath, { recursive: true, force: true });
  }
}

function synthesisExists(type: "voice" | "sessions"): boolean {
  const today = new Date().toISOString().split("T")[0];

  // Voice and sessions use direct subdirectories. (The "ratings" variant that
  // checked MEMORY/LEARNING/SYNTHESIS/<YYYY-MM>/ was removed 2026-07-10 — its
  // producer, the wisdom-frame synthesis pipeline, was deleted 2026-07-09.)
  const synthDir = path.join(CLAUDE_DIR, "MEMORY", "LEARNING", "SYNTHESIS", type);

  if (!fs.existsSync(synthDir)) return false;

  // Check for today's synthesis or any recent pattern file
  try {
    const files = fs.readdirSync(synthDir);
    return files.some(f => f.includes(today) || f.includes("-patterns.md"));
  } catch {
    return false;
  }
}

// ============================================================================
// Cleanup Functions
// ============================================================================

async function cleanDebug(dryRun: boolean): Promise<CleanupResult> {
  const debugDir = path.join(CLAUDE_DIR, "debug");
  const result: CleanupResult = {
    target: "debug/",
    filesRemoved: 0,
    linesRemoved: 0,
    bytesFreed: 0,
    errors: [],
  };

  if (!fs.existsSync(debugDir)) {
    return result;
  }

  try {
    const entries = fs.readdirSync(debugDir);

    for (const entry of entries) {
      const fullPath = path.join(debugDir, entry);
      const age = getFileAgeInDays(fullPath);

      if (age > RETENTION.debug) {
        const stats = fs.statSync(fullPath);
        const size = stats.isDirectory() ? getDirectorySize(fullPath) : stats.size;

        if (!dryRun) {
          if (stats.isDirectory()) {
            deleteDirectory(fullPath);
          } else {
            fs.unlinkSync(fullPath);
          }
        }

        result.filesRemoved++;
        result.bytesFreed += size;
      }
    }
  } catch (error) {
    result.errors.push(`Failed to clean debug: ${error}`);
  }

  return result;
}

async function cleanFileHistory(dryRun: boolean): Promise<CleanupResult> {
  const fileHistoryDir = path.join(CLAUDE_DIR, "file-history");
  const result: CleanupResult = {
    target: "file-history/",
    filesRemoved: 0,
    linesRemoved: 0,
    bytesFreed: 0,
    errors: [],
  };

  if (!fs.existsSync(fileHistoryDir)) {
    return result;
  }

  try {
    const entries = fs.readdirSync(fileHistoryDir);

    for (const entry of entries) {
      const fullPath = path.join(fileHistoryDir, entry);
      const age = getDirAgeInDays(fullPath);

      if (age > RETENTION.fileHistory) {
        const size = getDirectorySize(fullPath);

        if (!dryRun) {
          deleteDirectory(fullPath);
        }

        result.filesRemoved++;
        result.bytesFreed += size;
      }
    }
  } catch (error) {
    result.errors.push(`Failed to clean file-history: ${error}`);
  }

  return result;
}

async function rotateJsonl(
  filepath: string,
  retentionDays: number,
  dryRun: boolean,
  requiresSynthesis: boolean,
  synthesisType?: "voice" | "sessions"
): Promise<CleanupResult> {
  const filename = path.basename(filepath);
  const result: CleanupResult = {
    target: filename,
    filesRemoved: 0,
    linesRemoved: 0,
    bytesFreed: 0,
    errors: [],
  };

  if (!fs.existsSync(filepath)) {
    return result;
  }

  // Check synthesis requirement
  if (requiresSynthesis && synthesisType && !synthesisExists(synthesisType)) {
    result.skipped = true;
    result.skipReason = `Synthesis not found for ${synthesisType}. Run synthesis first.`;
    return result;
  }

  try {
    const content = fs.readFileSync(filepath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    const originalSize = fs.statSync(filepath).size;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const keptLines: string[] = [];
    let removedCount = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const timestamp = entry.timestamp
          ? new Date(entry.timestamp)
          : new Date(entry.timestamp_ms || 0);

        if (timestamp >= cutoffDate) {
          keptLines.push(line);
        } else {
          removedCount++;
        }
      } catch {
        // Keep unparseable lines
        keptLines.push(line);
      }
    }

    if (removedCount > 0 && !dryRun) {
      fs.writeFileSync(filepath, keptLines.join("\n") + "\n");
    }

    const newSize = dryRun ? originalSize : fs.statSync(filepath).size;

    result.linesRemoved = removedCount;
    result.bytesFreed = originalSize - newSize;
  } catch (error) {
    result.errors.push(`Failed to rotate ${filename}: ${error}`);
  }

  return result;
}

async function cleanSecurityLogs(dryRun: boolean): Promise<CleanupResult> {
  const securityDir = path.join(CLAUDE_DIR, "MEMORY", "security");
  const result: CleanupResult = {
    target: "security/*.jsonl",
    filesRemoved: 0,
    linesRemoved: 0,
    bytesFreed: 0,
    errors: [],
  };

  if (!fs.existsSync(securityDir)) {
    return result;
  }

  try {
    const files = fs.readdirSync(securityDir).filter(f => f.endsWith(".jsonl"));

    for (const file of files) {
      const filepath = path.join(securityDir, file);
      const subResult = await rotateJsonl(filepath, RETENTION.security, dryRun, false);
      result.linesRemoved += subResult.linesRemoved;
      result.bytesFreed += subResult.bytesFreed;
      result.errors.push(...subResult.errors);
    }
  } catch (error) {
    result.errors.push(`Failed to clean security logs: ${error}`);
  }

  return result;
}

// ── ISC row 2: clean all JSONL files from registry ────────────────────────
// Exported: wired into AutoMaintenance `--tier weekly-cleanup` (Monday crontab
// via bin/kaya-weekly-mon.sh) since 2026-07-10 — before that, registry rotation
// was only reachable through this file's own CLI and never ran on a schedule.
export async function cleanAllJsonlFromRegistry(dryRun: boolean): Promise<CleanupResult[]> {
  const results: CleanupResult[] = [];
  for (const entry of JSONL_REGISTRY) {
    const absPath = resolveEntryPath(entry);
    const synthType = entry.requiresSynthesis ? entry.synthesisType : undefined;
    results.push(await rotateJsonl(absPath, entry.retentionDays, dryRun, entry.requiresSynthesis, synthType));
  }
  return results;
}

// ── ISC row 3: scan for JSONL files not in registry ───────────────────────
export interface UnregisteredScanResult {
  unregistered: string[];
  registered: number;
  warnings: string[];
}

export function scanUnregistered(): UnregisteredScanResult {
  const claudeDir = getClaudeDir();
  const memoryDir = path.join(claudeDir, "MEMORY");
  const registered = getRegisteredJsonlPaths();
  const unregistered: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip archive subdirectories (those contain old rotated data)
        if (entry.name === "archive") continue;
        walk(fullPath);
      } else if (entry.name.endsWith(".jsonl") && !registered.has(fullPath)) {
        unregistered.push(fullPath);
      }
    }
  }

  // Also check root .jsonl files (like history.jsonl)
  try {
    for (const f of fs.readdirSync(claudeDir)) {
      if (f.endsWith(".jsonl")) {
        const fullPath = path.join(claudeDir, f);
        if (!registered.has(fullPath)) unregistered.push(fullPath);
      }
    }
  } catch { /* ignore */ }

  if (fs.existsSync(memoryDir)) walk(memoryDir);

  return {
    unregistered,
    registered: registered.size,
    warnings: unregistered.map(p => `WARN: unregistered JSONL: ${p}`),
  };
}

// ── ISC row 4: clean WORK/ directories by TTL ─────────────────────────────
export interface WorkDirCleanupResult extends CleanupResult {
  dirsRemoved: number;
  dirsSkipped: number;
}

/** Read active in-progress work item directory names from pipeline.db */
function getActiveWorkItemDirs(): Set<string> {
  try {
    const repo = getPipelineRepository();
    const items = repo.list({ stage: "in-progress" });
    const dirs = new Set<string>();
    for (const item of items) {
      // Protect by item id
      dirs.add(item.id);
      // Protect by worktree path basename
      if (item.worktree_path) dirs.add(path.basename(item.worktree_path));
      // Protect by sessionDir from rawQueueItem metadata (legacy items stored in metadata)
      const raw = item.metadata?.rawQueueItem as Record<string, unknown> | undefined;
      const sessionDir = (raw?.sessionDir ?? raw?.session_dir) as string | undefined;
      if (sessionDir) dirs.add(path.basename(sessionDir));
    }
    return dirs;
  } catch {
    return new Set();
  }
}

export async function cleanWorkDirs(dryRun: boolean): Promise<WorkDirCleanupResult> {
  const activeItems = getActiveWorkItemDirs();
  const claudeDir = getClaudeDir();
  const targets = [
    { dir: path.join(claudeDir, "MEMORY", "WORK"), ttlDays: 30 },
    { dir: path.join(claudeDir, "MEMORY", "archive", "WORK"), ttlDays: 90 },
  ];

  const result: WorkDirCleanupResult = {
    target: "WORK/",
    filesRemoved: 0,
    linesRemoved: 0,
    bytesFreed: 0,
    errors: [],
    dirsRemoved: 0,
    dirsSkipped: 0,
  };

  for (const { dir, ttlDays } of targets) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      result.errors.push(`Failed to read ${dir}: ${e}`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      const ageDays = getDirAgeInDays(fullPath);
      // Skip in-progress work items
      if (activeItems.has(entry.name)) {
        result.dirsSkipped++;
        continue;
      }
      if (ageDays > ttlDays) {
        const size = getDirectorySize(fullPath);
        if (!dryRun) {
          try { deleteDirectory(fullPath); } catch (e) { result.errors.push(`Failed to delete ${fullPath}: ${e}`); continue; }
        }
        result.dirsRemoved++;
        result.filesRemoved++;
        result.bytesFreed += size;
      }
    }
  }

  return result;
}

// ── ISC row 11: clean orphaned current-work-{uuid}.json files ─────────────
export async function cleanOrphanedCurrentWork(dryRun: boolean): Promise<CleanupResult> {
  const stateDir = path.join(getClaudeDir(), "MEMORY", "State");
  const TTL_HOURS = 24;
  const uuidPattern = /^current-work-[0-9a-f-]{36}\.json$/;

  const result: CleanupResult = {
    target: "current-work orphans",
    filesRemoved: 0,
    linesRemoved: 0,
    bytesFreed: 0,
    errors: [],
  };

  if (!fs.existsSync(stateDir)) return result;

  let entries: string[];
  try {
    entries = fs.readdirSync(stateDir).filter(f => uuidPattern.test(f));
  } catch (e) {
    result.errors.push(`Failed to read ${stateDir}: ${e}`);
    return result;
  }

  for (const file of entries) {
    const fullPath = path.join(stateDir, file);
    const ageHours = getFileAgeInDays(fullPath) * 24;
    if (ageHours > TTL_HOURS) {
      const size = fs.statSync(fullPath).size;
      if (!dryRun) {
        try { fs.unlinkSync(fullPath); } catch (e) { result.errors.push(`Failed to delete ${fullPath}: ${e}`); continue; }
      }
      result.filesRemoved++;
      result.bytesFreed += size;
    }
  }

  return result;
}

// ── ISC row 12: clean stale prompt-context-*.json / context-session-*.json ──
/**
 * Sweep stale context state files from MEMORY/State.
 *
 * These files accumulate indefinitely after sessions end. They are used for
 * cross-session context loading but have no value after ~14 days. Same dir as
 * current-work-{uuid}.json; same dry-run semantics.
 */
export async function cleanStaleContextFiles(dryRun: boolean): Promise<CleanupResult> {
  const stateDir = path.join(getClaudeDir(), "MEMORY", "State");
  const TTL_DAYS = 14;
  const patterns = [
    /^prompt-context-[0-9a-f-]{36}\.json$/,
    /^context-session-[0-9a-f-]{36}\.json$/,
  ];

  const result: CleanupResult = {
    target: "stale context files",
    filesRemoved: 0,
    linesRemoved: 0,
    bytesFreed: 0,
    errors: [],
  };

  if (!fs.existsSync(stateDir)) return result;

  let entries: string[];
  try {
    entries = fs.readdirSync(stateDir).filter(f => patterns.some(p => p.test(f)));
  } catch (e) {
    result.errors.push(`Failed to read ${stateDir}: ${e}`);
    return result;
  }

  for (const file of entries) {
    const fullPath = path.join(stateDir, file);
    const ageDays = getFileAgeInDays(fullPath);
    if (ageDays > TTL_DAYS) {
      const size = fs.statSync(fullPath).size;
      if (!dryRun) {
        try { fs.unlinkSync(fullPath); } catch (e) { result.errors.push(`Failed to delete ${fullPath}: ${e}`); continue; }
      }
      result.filesRemoved++;
      result.bytesFreed += size;
    }
  }

  return result;
}

async function cleanAll(dryRun: boolean): Promise<OverallResult> {
  const results: CleanupResult[] = [];

  // Ephemeral directories (no synthesis required)
  results.push(await cleanDebug(dryRun));
  results.push(await cleanFileHistory(dryRun));

  // All registered JSONL files
  const jsonlResults = await cleanAllJsonlFromRegistry(dryRun);
  results.push(...jsonlResults);

  // Security logs (no synthesis required - audit trail, handled separately via glob)
  results.push(await cleanSecurityLogs(dryRun));

  // WORK/ directory cleanup
  results.push(await cleanWorkDirs(dryRun));

  // Orphaned current-work-{uuid}.json files
  results.push(await cleanOrphanedCurrentWork(dryRun));

  // Stale prompt-context-*.json / context-session-*.json files
  results.push(await cleanStaleContextFiles(dryRun));

  const totalBytesFreed = results.reduce((sum, r) => sum + r.bytesFreed, 0);
  const totalFilesRemoved = results.reduce((sum, r) => sum + r.filesRemoved, 0);
  const totalLinesRemoved = results.reduce((sum, r) => sum + r.linesRemoved, 0);

  return {
    success: results.every(r => r.errors.length === 0 && !r.skipped),
    timestamp: new Date().toISOString(),
    dryRun,
    results,
    totalBytesFreed,
    totalFilesRemoved,
    totalLinesRemoved,
  };
}

// ============================================================================
// CLI
// ============================================================================

// Guard: only run CLI when this file is executed directly (not imported as a module)
if (import.meta.main) {

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "dry-run": { type: "boolean" },
    "scan-unregistered": { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`
Kaya Memory Cleanup Utility

Usage:
  bun run MemoryCleanup.ts all [--dry-run] [--json]
  bun run MemoryCleanup.ts debug [--dry-run]
  bun run MemoryCleanup.ts file-history [--dry-run]
  bun run MemoryCleanup.ts logs [--dry-run]

Targets:
  all           Clean all targets
  debug         Clean debug/ directory (14-day retention)
  file-history  Clean file-history/ directory (30-day retention)
  logs          Rotate JSONL log files (30-90 day retention)

Options:
  --dry-run     Preview changes without executing
  --json        Output results as JSON

Retention Policies:
  debug/              14 days  (ephemeral)
  file-history/       30 days  (technical)
  history.jsonl       30 days  (requires synthesis)
  voice-events.jsonl  90 days  (requires synthesis)
  ratings.jsonl       90 days
  security/*.jsonl    90 days  (audit trail)

IMPORTANT: Run synthesis tools BEFORE cleanup for history and voice-events.
`);
  process.exit(0);
}

const command = positionals[0] || "all";
const dryRun = values["dry-run"] ?? false;
const jsonOutput = values.json ?? false;
const scanUnregisteredFlag = values["scan-unregistered"] ?? false;

async function main() {
  // --scan-unregistered can be combined with any command
  if (scanUnregisteredFlag) {
    const scanResult = scanUnregistered();
    if (jsonOutput) {
      console.log(JSON.stringify(scanResult, null, 2));
    } else {
      console.log(`Registered JSONL paths: ${scanResult.registered}`);
      if (scanResult.unregistered.length === 0) {
        console.log("✓ No unregistered JSONL files found.");
      } else {
        for (const w of scanResult.warnings) console.warn(w);
      }
    }
    if (command === "scan-unregistered") process.exit(0);
  }

  let result: OverallResult | CleanupResult;

  switch (command) {
    case "scan-unregistered":
      process.exit(0); // already handled above
      break;
    case "all":
      result = await cleanAll(dryRun);
      break;
    case "debug":
      result = await cleanDebug(dryRun);
      break;
    case "file-history":
      result = await cleanFileHistory(dryRun);
      break;
    case "logs": {
      const results: CleanupResult[] = [];
      const historyFile = path.join(CLAUDE_DIR, "history.jsonl");
      results.push(await rotateJsonl(historyFile, RETENTION.history, dryRun, true, "sessions"));

      const voiceEventsFile = path.join(CLAUDE_DIR, "MEMORY", "VOICE", "voice-events.jsonl");
      results.push(await rotateJsonl(voiceEventsFile, RETENTION.voiceEvents, dryRun, true, "voice"));

      const ratingsFile = path.join(CLAUDE_DIR, "MEMORY", "LEARNING", "SIGNALS", "ratings.jsonl");
      results.push(await rotateJsonl(ratingsFile, RETENTION.ratings, dryRun, false));

      result = {
        success: results.every(r => r.errors.length === 0 && !r.skipped),
        timestamp: new Date().toISOString(),
        dryRun,
        results,
        totalBytesFreed: results.reduce((sum, r) => sum + r.bytesFreed, 0),
        totalFilesRemoved: 0,
        totalLinesRemoved: results.reduce((sum, r) => sum + r.linesRemoved, 0),
      };
      break;
    }
    case "work-dirs":
      result = await cleanWorkDirs(dryRun);
      break;
    case "orphaned-current-work":
      result = await cleanOrphanedCurrentWork(dryRun);
      break;
    case "context-files":
      result = await cleanStaleContextFiles(dryRun);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if ("results" in result) {
      // Overall result
      console.log(`Memory Cleanup ${dryRun ? "[DRY RUN]" : ""}`);
      console.log(`═══════════════════════════════════════`);

      for (const r of result.results) {
        const status = r.skipped ? `SKIPPED: ${r.skipReason}` : "OK";
        console.log(`\n${r.target}: ${status}`);
        if (!r.skipped) {
          if (r.filesRemoved > 0) console.log(`  Files removed: ${r.filesRemoved}`);
          if (r.linesRemoved > 0) console.log(`  Lines removed: ${r.linesRemoved}`);
          if (r.bytesFreed > 0) console.log(`  Bytes freed: ${(r.bytesFreed / 1024).toFixed(1)} KB`);
        }
        if (r.errors.length > 0) {
          console.log(`  Errors: ${r.errors.join(", ")}`);
        }
      }

      console.log(`\n═══════════════════════════════════════`);
      console.log(`Total bytes freed: ${(result.totalBytesFreed / 1024).toFixed(1)} KB`);
      console.log(`Total files removed: ${result.totalFilesRemoved}`);
      console.log(`Total lines removed: ${result.totalLinesRemoved}`);
    } else {
      // Single result
      console.log(`${result.target}: ${dryRun ? "[DRY RUN] " : ""}${result.skipped ? "SKIPPED" : "OK"}`);
      if (result.skipped) console.log(`  Reason: ${result.skipReason}`);
      if (result.filesRemoved > 0) console.log(`  Files removed: ${result.filesRemoved}`);
      if (result.linesRemoved > 0) console.log(`  Lines removed: ${result.linesRemoved}`);
      if (result.bytesFreed > 0) console.log(`  Bytes freed: ${(result.bytesFreed / 1024).toFixed(1)} KB`);
      if (result.errors.length > 0) console.log(`  Errors: ${result.errors.join(", ")}`);
    }
  }
}

main().catch(console.error);

} // end if (import.meta.main)
