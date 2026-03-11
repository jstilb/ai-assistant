#!/usr/bin/env bun
/**
 * ============================================================================
 * OrphanRecovery.ts - MEMORY orphan detection for AutoInfoManager
 * ============================================================================
 *
 * PURPOSE:
 * Scans MEMORY/ directories for orphaned files that are not referenced by
 * any session, work item, or other MEMORY artifacts. Reports findings with
 * metrics and optional cleanup suggestions.
 *
 * This implements the OrphanRecovery workflow documented in
 * Workflows/OrphanRecovery.md - previously vaporware (200 lines of docs,
 * zero implementation).
 *
 * USAGE:
 *   bun OrphanRecovery.ts                    # Full scan
 *   bun OrphanRecovery.ts --dry-run          # Preview without changes
 *   bun OrphanRecovery.ts --json             # JSON output
 *   bun OrphanRecovery.ts --days 30          # Only files older than 30 days
 *
 * ============================================================================
 */

import { join, relative, basename, extname } from "path";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";

// ============================================================================
// Types
// ============================================================================

export interface OrphanFile {
  /** Absolute path to the orphaned file */
  path: string;
  /** Relative path from MEMORY/ */
  relativePath: string;
  /** Which MEMORY subdirectory it belongs to */
  category: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Last modified date */
  lastModified: string;
  /** Age in days */
  ageDays: number;
  /** Why it was flagged as orphan */
  reason: string;
}

export interface OrphanRecoveryResult {
  /** Whether the scan completed successfully */
  success: boolean;
  /** Total files scanned */
  totalScanned: number;
  /** Total orphans found */
  orphansFound: number;
  /** Orphan files grouped by category */
  orphansByCategory: Record<string, OrphanFile[]>;
  /** Total size of orphaned files in bytes */
  totalOrphanSizeBytes: number;
  /** Scan duration in ms */
  durationMs: number;
  /** List of all orphan files */
  orphans: OrphanFile[];
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_DIR = process.env.KAYA_DIR || join(homedir(), ".claude");
const MEMORY_DIR = join(KAYA_DIR, "MEMORY");

/** Directories to scan for orphans */
const SCAN_DIRS = [
  "WORK",
  "LEARNING",
  "research",
  "VALIDATION",
  "AUTOINFO",
  "BRIEFINGS",
  "VOICE",
];

/** Files/patterns that are never orphans (infrastructure files) */
const NEVER_ORPHAN_PATTERNS = [
  /^\./, // Hidden files
  /state\.json$/,
  /integrity-state\.json$/,
  /tab-title\.json$/,
  /work-queue-state\.json$/,
  /voice-events\.jsonl$/,
  /ratings\.jsonl$/,
  /approvals\.jsonl$/,
  /approved-work\.jsonl$/,
];

/** Directories to skip entirely */
const SKIP_DIRS = [
  "State",
  "daemon",
  "QUEUES",
  "SIGNALS",
  "KAYASYSTEMUPDATES",
];

// ============================================================================
// Implementation
// ============================================================================

/**
 * Collect all markdown and JSONL files from a MEMORY subdirectory
 */
function collectFiles(dir: string): string[] {
  const files: string[] = [];

  if (!existsSync(dir)) {
    return files;
  }

  function walk(currentDir: string): void {
    try {
      const entries = readdirSync(currentDir);
      for (const entry of entries) {
        const fullPath = join(currentDir, entry);

        // Skip hidden directories
        if (entry.startsWith(".")) continue;

        // Skip infrastructure directories
        const relToMemory = relative(MEMORY_DIR, fullPath);
        const topDir = relToMemory.split("/")[1] || relToMemory.split("/")[0];
        if (SKIP_DIRS.includes(topDir) || SKIP_DIRS.includes(entry)) continue;

        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath);
          } else if (stat.isFile()) {
            const ext = extname(entry).toLowerCase();
            if ([".md", ".jsonl", ".json"].includes(ext)) {
              files.push(fullPath);
            }
          }
        } catch {
          // Skip unreadable entries
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  walk(dir);
  return files;
}

/**
 * Build a set of referenced file paths by scanning for cross-references
 * within MEMORY/ files. A file is "referenced" if another file mentions
 * its name or path.
 */
function buildReferenceIndex(allFiles: string[]): Set<string> {
  const referenced = new Set<string>();

  // All filenames (without extension) that could be references
  const filenameSet = new Map<string, string>();
  for (const file of allFiles) {
    const name = basename(file, extname(file));
    filenameSet.set(name.toLowerCase(), file);
  }

  // Scan each file's content for references to other files
  for (const file of allFiles) {
    try {
      const content = readFileSync(file, "utf-8");

      // Check if this file references other MEMORY files
      for (const [name, path] of filenameSet) {
        if (path === file) continue; // Don't self-reference

        // Look for filename mentions in content
        if (content.toLowerCase().includes(name)) {
          referenced.add(path);
        }
      }

      // Check for explicit path references (MEMORY/WORK/..., etc.)
      const pathMatches = content.match(/MEMORY\/[A-Za-z0-9_\-\/]+\.[a-z]+/g);
      if (pathMatches) {
        for (const match of pathMatches) {
          const fullPath = join(KAYA_DIR, match);
          if (existsSync(fullPath)) {
            referenced.add(fullPath);
          }
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return referenced;
}

/**
 * Check if a file matches any "never orphan" pattern
 */
function isNeverOrphan(filePath: string): boolean {
  const name = basename(filePath);
  return NEVER_ORPHAN_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Check if a WORK directory entry has a corresponding work queue reference
 */
function isWorkDirReferenced(dirName: string): boolean {
  // Work directories follow pattern: YYYYMMDD-HHMMSS_task-name/
  // Check if the work-queue-state.json references this task
  const workQueuePath = join(MEMORY_DIR, "WORK/work-queue-state.json");
  if (existsSync(workQueuePath)) {
    try {
      const content = readFileSync(workQueuePath, "utf-8");
      if (content.includes(dirName)) {
        return true;
      }
    } catch {
      // Fall through
    }
  }

  // Check approved-work.jsonl
  const approvedPath = join(MEMORY_DIR, "QUEUES/approved-work.jsonl");
  if (existsSync(approvedPath)) {
    try {
      const content = readFileSync(approvedPath, "utf-8");
      if (content.includes(dirName)) {
        return true;
      }
    } catch {
      // Fall through
    }
  }

  return false;
}

/**
 * Run orphan recovery scan
 */
export async function runOrphanRecovery(options: {
  dryRun?: boolean;
  minAgeDays?: number;
}): Promise<OrphanRecoveryResult> {
  const startTime = Date.now();
  const orphans: OrphanFile[] = [];
  let totalScanned = 0;

  if (!existsSync(MEMORY_DIR)) {
    return {
      success: true,
      totalScanned: 0,
      orphansFound: 0,
      orphansByCategory: {},
      totalOrphanSizeBytes: 0,
      durationMs: Date.now() - startTime,
      orphans: [],
    };
  }

  // Phase 1: Collect all MEMORY files
  const allFiles: string[] = [];
  for (const scanDir of SCAN_DIRS) {
    const dirPath = join(MEMORY_DIR, scanDir);
    const files = collectFiles(dirPath);
    allFiles.push(...files);
  }
  totalScanned = allFiles.length;

  // Phase 2: Build reference index
  const referenced = buildReferenceIndex(allFiles);

  // Phase 3: Identify orphans
  const now = Date.now();
  const minAgeMs = (options.minAgeDays || 0) * 24 * 60 * 60 * 1000;

  for (const file of allFiles) {
    // Skip infrastructure files
    if (isNeverOrphan(file)) continue;

    // Skip if referenced by another file
    if (referenced.has(file)) continue;

    try {
      const stat = statSync(file);
      const ageMs = now - stat.mtime.getTime();
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));

      // Skip files newer than minimum age
      if (ageMs < minAgeMs) continue;

      const relPath = relative(MEMORY_DIR, file);
      const category = relPath.split("/")[0];

      // For WORK directories, check if the parent task dir is referenced
      if (category === "WORK") {
        const parts = relPath.split("/");
        if (parts.length >= 2) {
          const taskDir = parts[1];
          if (isWorkDirReferenced(taskDir)) continue;
        }
      }

      // For LEARNING files, check if they are recent (< 7 days = not orphan)
      if (category === "LEARNING" && ageDays < 7) continue;

      // For VALIDATION files, check age (< 3 days = not orphan)
      if (category === "VALIDATION" && ageDays < 3) continue;

      orphans.push({
        path: file,
        relativePath: relPath,
        category,
        sizeBytes: stat.size,
        lastModified: stat.mtime.toISOString(),
        ageDays,
        reason: `No references found in ${totalScanned} scanned files`,
      });
    } catch {
      // Skip files we can't stat
    }
  }

  // Phase 4: Group by category
  const orphansByCategory: Record<string, OrphanFile[]> = {};
  let totalOrphanSizeBytes = 0;

  for (const orphan of orphans) {
    if (!orphansByCategory[orphan.category]) {
      orphansByCategory[orphan.category] = [];
    }
    orphansByCategory[orphan.category].push(orphan);
    totalOrphanSizeBytes += orphan.sizeBytes;
  }

  return {
    success: true,
    totalScanned,
    orphansFound: orphans.length,
    orphansByCategory,
    totalOrphanSizeBytes,
    durationMs: Date.now() - startTime,
    orphans,
  };
}

/**
 * Format results as a markdown report
 */
function formatReport(result: OrphanRecoveryResult): string {
  const lines: string[] = [
    "# Orphan Recovery Report",
    "",
    `**Date:** ${new Date().toISOString().split("T")[0]}`,
    `**Files Scanned:** ${result.totalScanned}`,
    `**Orphans Found:** ${result.orphansFound}`,
    `**Total Orphan Size:** ${formatBytes(result.totalOrphanSizeBytes)}`,
    `**Scan Duration:** ${result.durationMs}ms`,
    "",
  ];

  if (result.orphansFound === 0) {
    lines.push("No orphaned files detected. All MEMORY files are referenced.");
    return lines.join("\n");
  }

  lines.push("## Orphans by Category");
  lines.push("");

  for (const [category, orphans] of Object.entries(result.orphansByCategory)) {
    const totalSize = orphans.reduce((sum, o) => sum + o.sizeBytes, 0);
    lines.push(`### ${category} (${orphans.length} files, ${formatBytes(totalSize)})`);
    lines.push("");
    lines.push("| File | Age (days) | Size |");
    lines.push("|------|-----------|------|");

    for (const orphan of orphans.sort((a, b) => b.ageDays - a.ageDays)) {
      lines.push(`| ${orphan.relativePath} | ${orphan.ageDays} | ${formatBytes(orphan.sizeBytes)} |`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(`*Generated by OrphanRecovery at ${new Date().toISOString()}*`);

  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ============================================================================
// CLI Interface
// ============================================================================

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
OrphanRecovery - Detect orphaned files in MEMORY/ directories

USAGE:
  bun OrphanRecovery.ts [options]

OPTIONS:
  --dry-run        Preview scan without any changes
  --json           Output results as JSON
  --days <n>       Only flag files older than n days (default: 0)
  --help, -h       Show this help

EXAMPLES:
  bun OrphanRecovery.ts
  bun OrphanRecovery.ts --json
  bun OrphanRecovery.ts --days 30
`);
    return;
  }

  const dryRun = args.includes("--dry-run");
  const jsonOutput = args.includes("--json");
  const daysIndex = args.indexOf("--days");
  const minAgeDays = daysIndex !== -1 ? parseInt(args[daysIndex + 1]) : 0;

  const result = await runOrphanRecovery({ dryRun, minAgeDays });

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatReport(result));
  }

  process.exit(result.success ? 0 : 1);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
