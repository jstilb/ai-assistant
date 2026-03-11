#!/usr/bin/env bun
/**
 * BackfillIndexer.ts - Index unindexed MEMORY/LEARNING/ .md files into MemoryStore
 *
 * Scans MEMORY/LEARNING/ recursively for .md files that aren't already in MemoryStore's
 * index. Parses metadata from YAML frontmatter and filenames, assigns tier by age,
 * and indexes via memoryStore.capture() with hash-based deduplication.
 *
 * Usage:
 *   bun run BackfillIndexer.ts              # Run backfill
 *   bun run BackfillIndexer.ts --dry-run    # Preview without writing
 *   bun run BackfillIndexer.ts --json       # Output results as JSON
 *   bun run BackfillIndexer.ts --stats      # Show index coverage stats only
 */

import { parseArgs } from "util";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import * as path from "path";
import { memoryStore } from "../../../../lib/core/MemoryStore";
import type { MemoryType, MemoryTier } from "../../../../lib/core/MemoryStore";

// ============================================================================
// Configuration
// ============================================================================

const CLAUDE_DIR = path.join(process.env.HOME!, ".claude");
const MEMORY_DIR = path.join(CLAUDE_DIR, "MEMORY");
const LEARNING_DIR = path.join(MEMORY_DIR, "LEARNING");

// Directories to skip — synthesis outputs are already indexed by KnowledgeSynthesizer
const SKIP_DIRS = new Set(["SYNTHESIS", "SIGNALS"]);

// ============================================================================
// Types
// ============================================================================

interface BackfillResult {
  scanned: number;
  indexed: number;
  skippedAlreadyIndexed: number;
  skippedDuplicate: number;
  skippedErrors: number;
  byCategory: Record<string, number>;
}

interface ParsedFile {
  filePath: string;
  title: string;
  content: string;
  category: string;
  type: MemoryType;
  tier: MemoryTier;
  tags: string[];
  timestamp: string;
}

// ============================================================================
// File Discovery
// ============================================================================

/**
 * Recursively find all .md files under LEARNING_DIR, excluding SKIP_DIRS.
 */
function discoverFiles(dir: string): string[] {
  const results: string[] = [];

  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      results.push(...discoverFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      // Skip _Context.md aggregation files
      if (entry.name === "_Context.md") continue;
      // Skip the top-level aggregate file
      if (entry.name === "LearningsAggregateContext.md") continue;
      results.push(fullPath);
    }
  }

  return results;
}

// ============================================================================
// Metadata Parsing
// ============================================================================

/**
 * Parse YAML frontmatter from file content.
 * Returns key-value pairs from the frontmatter block.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  if (!content.startsWith("---")) return result;

  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) return result;

  const frontmatter = content.slice(3, endIdx).trim();
  for (const line of frontmatter.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Handle YAML arrays like [tag1, tag2]
    result[key] = value;
  }

  return result;
}

/**
 * Determine category from file path relative to LEARNING_DIR.
 * e.g., ALGORITHM/2026-02/file.md -> "ALGORITHM"
 */
function categoryFromPath(filePath: string): string {
  const relative = path.relative(LEARNING_DIR, filePath);
  const parts = relative.split(path.sep);
  return parts.length > 1 ? parts[0] : "GENERAL";
}

/**
 * Determine MemoryType based on category and content.
 */
function typeFromCategory(category: string): MemoryType {
  switch (category) {
    case "ALGORITHM":
      return "learning";
    case "FAILURES":
      return "signal";
    case "RESEARCH":
      return "research";
    case "SYSTEM":
      return "learning";
    case "ARCHITECTURE":
      return "insight";
    case "COMPLETIONS":
      return "insight";
    default:
      return "learning";
  }
}

/**
 * Determine tier based on file age.
 * hot: <7 days, warm: <30 days, cold: older
 */
function tierFromAge(mtime: Date): MemoryTier {
  const now = Date.now();
  const ageMs = now - mtime.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (ageDays < 7) return "hot";
  if (ageDays < 30) return "warm";
  return "cold";
}

/**
 * Extract a title from the file content.
 * Tries: frontmatter title > first H1 > filename.
 */
function extractTitle(content: string, filename: string): string {
  // Try frontmatter
  const fm = parseFrontmatter(content);
  if (fm.title) return fm.title;

  // Try first H1
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();

  // Fall back to filename
  return filename
    .replace(/\.md$/, "")
    .replace(/^\d{8}-\d{6}_/, "") // Remove timestamp prefix
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .slice(0, 100);
}

/**
 * Extract tags from frontmatter and path.
 */
function extractTags(content: string, category: string): string[] {
  const tags: string[] = [category.toLowerCase()];

  const fm = parseFrontmatter(content);
  if (fm.tags) {
    // Parse YAML array: [tag1, tag2, tag3]
    const tagStr = fm.tags.replace(/^\[/, "").replace(/\]$/, "");
    const parsedTags = tagStr.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    tags.push(...parsedTags);
  }

  if (fm.capture_type) tags.push(fm.capture_type.toLowerCase());
  if (fm.rating) tags.push(`rating-${fm.rating}`);

  return [...new Set(tags)];
}

/**
 * Extract timestamp from frontmatter or filename or file mtime.
 */
function extractTimestamp(content: string, filename: string, mtime: Date): string {
  const fm = parseFrontmatter(content);
  if (fm.timestamp) {
    // Try to parse the frontmatter timestamp
    const parsed = new Date(fm.timestamp);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }

  // Try to extract date from filename patterns:
  // 2026-02-17-112828_LEARNING_...
  // 20260206-191458_failure-...
  const isoMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    const parsed = new Date(isoMatch[1]);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }

  const compactMatch = filename.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (compactMatch) {
    const [, y, m, d, hh, mm, ss] = compactMatch;
    const parsed = new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }

  return mtime.toISOString();
}

/**
 * Parse a file into structured metadata for indexing.
 */
function parseFile(filePath: string): ParsedFile {
  const content = readFileSync(filePath, "utf-8");
  const stat = statSync(filePath);
  const filename = path.basename(filePath);
  const category = categoryFromPath(filePath);

  return {
    filePath,
    title: extractTitle(content, filename),
    content: content.slice(0, 2000), // Cap content for storage
    category,
    type: typeFromCategory(category),
    tier: tierFromAge(stat.mtime),
    tags: extractTags(content, category),
    timestamp: extractTimestamp(content, filename, stat.mtime),
  };
}

// ============================================================================
// Backfill Engine
// ============================================================================

async function runBackfill(dryRun: boolean): Promise<BackfillResult> {
  const result: BackfillResult = {
    scanned: 0,
    indexed: 0,
    skippedAlreadyIndexed: 0,
    skippedDuplicate: 0,
    skippedErrors: 0,
    byCategory: {},
  };

  const files = discoverFiles(LEARNING_DIR);
  result.scanned = files.length;

  for (const filePath of files) {
    try {
      const parsed = parseFile(filePath);

      // Check for duplicates using findSimilar
      const existing = await memoryStore.findSimilar(parsed.content, 0.8);
      if (existing.length > 0) {
        result.skippedDuplicate++;
        continue;
      }

      if (!dryRun) {
        await memoryStore.capture({
          type: parsed.type,
          category: parsed.category,
          title: parsed.title,
          content: parsed.content,
          tags: [...parsed.tags, "backfilled"],
          tier: parsed.tier,
          source: "BackfillIndexer",
          metadata: { originalPath: filePath },
        });
      }

      result.indexed++;
      result.byCategory[parsed.category] = (result.byCategory[parsed.category] || 0) + 1;
    } catch (err) {
      result.skippedErrors++;
    }
  }

  return result;
}

// ============================================================================
// Stats
// ============================================================================

async function showStats(): Promise<void> {
  const files = discoverFiles(LEARNING_DIR);
  const stats = await memoryStore.getStats();

  const learningEntries = stats.byType.learning + stats.byType.signal + stats.byType.insight;
  const coverage = files.length > 0 ? ((learningEntries / files.length) * 100).toFixed(1) : "N/A";

  console.log(`📊 Index Coverage Stats`);
  console.log(`   .md files in MEMORY/LEARNING/: ${files.length}`);
  console.log(`   Entries in MemoryStore (learning+signal+insight): ${learningEntries}`);
  console.log(`   Coverage: ~${coverage}%`);
  console.log(`   Total MemoryStore entries: ${stats.total}`);
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      stats: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`
BackfillIndexer - Index unindexed MEMORY/LEARNING/ files into MemoryStore

Usage:
  bun run BackfillIndexer.ts              Run backfill
  bun run BackfillIndexer.ts --dry-run    Preview without writing
  bun run BackfillIndexer.ts --json       Output results as JSON
  bun run BackfillIndexer.ts --stats      Show index coverage stats only
`);
    process.exit(0);
  }

  if (values.stats) {
    await showStats();
    process.exit(0);
  }

  const dryRun = values["dry-run"] ?? false;

  console.log(`📚 BackfillIndexer${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`   Scanning MEMORY/LEARNING/ for unindexed .md files...`);
  console.log(``);

  const result = await runBackfill(dryRun);

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`✅ Backfill Complete`);
    console.log(`   Scanned: ${result.scanned} files`);
    console.log(`   Indexed: ${result.indexed} new entries`);
    console.log(`   Skipped (already indexed): ${result.skippedDuplicate}`);
    console.log(`   Skipped (errors): ${result.skippedErrors}`);

    if (Object.keys(result.byCategory).length > 0) {
      console.log(`\n   By Category:`);
      for (const [cat, count] of Object.entries(result.byCategory).sort((a, b) => b[1] - a[1])) {
        console.log(`     ${cat}: ${count}`);
      }
    }
  }
}

if (import.meta.main) {
  main().catch(console.error);
}

export { runBackfill, discoverFiles, parseFile, showStats };
