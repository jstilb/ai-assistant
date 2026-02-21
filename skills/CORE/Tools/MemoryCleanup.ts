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
 *   bun run MemoryCleanup.ts consolidate [--dry-run]
 */

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Configuration
// ============================================================================

const CLAUDE_DIR = path.join(process.env.HOME!, ".claude");

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

function synthesisExists(type: "voice" | "sessions" | "ratings"): boolean {
  const today = new Date().toISOString().split("T")[0];
  const yearMonth = today.slice(0, 7); // YYYY-MM

  // Ratings uses YYYY-MM subdirectories (from LearningPatternSynthesis)
  // Voice and sessions use direct subdirectories
  const synthDir = type === "ratings"
    ? path.join(CLAUDE_DIR, "MEMORY", "LEARNING", "SYNTHESIS", yearMonth)
    : path.join(CLAUDE_DIR, "MEMORY", "LEARNING", "SYNTHESIS", type);

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
  synthesisType?: "voice" | "sessions" | "ratings"
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

async function cleanAll(dryRun: boolean): Promise<OverallResult> {
  const results: CleanupResult[] = [];

  // Ephemeral directories (no synthesis required)
  results.push(await cleanDebug(dryRun));
  results.push(await cleanFileHistory(dryRun));

  // JSONL files (synthesis required for some)
  const historyFile = path.join(CLAUDE_DIR, "history.jsonl");
  results.push(await rotateJsonl(historyFile, RETENTION.history, dryRun, true, "sessions"));

  const voiceEventsFile = path.join(CLAUDE_DIR, "MEMORY", "VOICE", "voice-events.jsonl");
  results.push(await rotateJsonl(voiceEventsFile, RETENTION.voiceEvents, dryRun, true, "voice"));

  const ratingsFile = path.join(CLAUDE_DIR, "MEMORY", "LEARNING", "SIGNALS", "ratings.jsonl");
  results.push(await rotateJsonl(ratingsFile, RETENTION.ratings, dryRun, true, "ratings"));

  // Security logs (no synthesis required - audit trail)
  results.push(await cleanSecurityLogs(dryRun));

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

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "dry-run": { type: "boolean" },
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
  ratings.jsonl       90 days  (requires synthesis)
  security/*.jsonl    90 days  (audit trail)

IMPORTANT: Run synthesis tools BEFORE cleanup for history, voice-events, ratings.
`);
  process.exit(0);
}

const command = positionals[0] || "all";
const dryRun = values["dry-run"] ?? false;
const jsonOutput = values.json ?? false;

async function main() {
  let result: OverallResult | CleanupResult;

  switch (command) {
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
      results.push(await rotateJsonl(ratingsFile, RETENTION.ratings, dryRun, true, "ratings"));

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
