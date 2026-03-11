#!/usr/bin/env bun
/**
 * MigrateToMemoryStore.ts - Migration helper for legacy MEMORY files
 *
 * Migrates existing MEMORY markdown files to the new MemoryStore:
 * - MEMORY/LEARNING → type: learning
 * - MEMORY/research → type: research
 * - MEMORY/KAYASYSTEMUPDATES → type: artifact
 *
 * Features:
 * - Parses YAML frontmatter from markdown files
 * - Extracts category from directory structure (e.g., LEARNING/ALGORITHM → category: ALGORITHM)
 * - Preserves original file dates as metadata
 * - Auto-deduplication using content hashing
 * - Dry-run mode for preview
 * - Progress reporting
 * - Batch migration with --all flag
 *
 * Usage:
 *   # Preview migration
 *   bun MigrateToMemoryStore.ts --source MEMORY/LEARNING --type learning --dry-run
 *
 *   # Migrate LEARNING directory
 *   bun MigrateToMemoryStore.ts --source MEMORY/LEARNING --type learning
 *
 *   # Migrate research directory
 *   bun MigrateToMemoryStore.ts --source MEMORY/research --type research
 *
 *   # Migrate KAYASYSTEMUPDATES
 *   bun MigrateToMemoryStore.ts --source MEMORY/KAYASYSTEMUPDATES --type artifact
 *
 *   # Migrate everything
 *   bun MigrateToMemoryStore.ts --all
 *
 * @author Kaya Engineering
 * @version 1.0.0
 */

import { parseArgs } from "util";
import { join, basename, dirname } from "path";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { createMemoryStore, type MemoryType, type CaptureOptions } from "./MemoryStore";

// ============================================================================
// Types
// ============================================================================

interface MigrationStats {
  scanned: number;
  imported: number;
  skipped: number;
  failed: number;
  wouldImport: number;
  errors: Array<{ file: string; error: string }>;
}

interface FrontmatterResult {
  frontmatter: Record<string, any>;
  content: string;
}

interface MemoryEntry extends CaptureOptions {
  metadata: {
    originalPath: string;
    originalTimestamp: string;
    migratedAt: string;
    [key: string]: any;
  };
}

// ============================================================================
// Frontmatter Parsing
// ============================================================================

/**
 * Parse YAML frontmatter from markdown content
 * @param content Markdown content with optional YAML frontmatter
 * @returns Parsed frontmatter and remaining content
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: {}, content };
  }

  const [, yamlContent, remainingContent] = match;

  try {
    // Simple YAML parser (handles common cases)
    const frontmatter: Record<string, any> = {};
    const lines = yamlContent.split('\n');

    for (const line of lines) {
      // Skip empty lines and comments
      if (!line.trim() || line.trim().startsWith('#')) continue;

      // Handle key: value pairs
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.slice(0, colonIndex).trim();
      let value: any = line.slice(colonIndex + 1).trim();

      // Parse arrays [item1, item2]
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value
          .slice(1, -1)
          .split(',')
          .map(v => v.trim().replace(/^["']|["']$/g, ''));
      }
      // Parse numbers
      else if (/^\d+$/.test(value)) {
        value = parseInt(value, 10);
      }
      // Parse booleans
      else if (value === 'true') {
        value = true;
      } else if (value === 'false') {
        value = false;
      }
      // Remove quotes from strings
      else {
        value = value.replace(/^["']|["']$/g, '');
      }

      frontmatter[key] = value;
    }

    return { frontmatter, content: remainingContent };
  } catch (error) {
    console.warn('Failed to parse frontmatter:', error);
    return { frontmatter: {}, content };
  }
}

// ============================================================================
// Path Analysis
// ============================================================================

/**
 * Extract category from file path
 * Examples:
 * - /path/LEARNING/ALGORITHM/2026-01/file.md → ALGORITHM
 * - /path/LEARNING/SYSTEM/2026-01/file.md → SYSTEM
 * - /path/research/2026-01/file.md → undefined
 */
export function extractCategory(filePath: string): string | undefined {
  const parts = filePath.split('/');

  // Find LEARNING index
  const learningIdx = parts.indexOf('LEARNING');
  if (learningIdx !== -1 && learningIdx + 1 < parts.length) {
    const category = parts[learningIdx + 1];
    // Category should not be a year-month directory
    if (!/^\d{4}-\d{2}$/.test(category)) {
      return category;
    }
  }

  return undefined;
}

/**
 * Map directory name to MemoryStore type
 */
export function mapToMemoryType(dirName: string): MemoryType {
  const mapping: Record<string, MemoryType> = {
    LEARNING: 'learning',
    research: 'research',
    KAYASYSTEMUPDATES: 'artifact',
    decisions: 'decision',
    learnings: 'learning',
  };

  return mapping[dirName] || 'insight';
}

/**
 * Extract title from markdown content
 * Looks for first # heading
 */
function extractTitle(content: string): string {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      return trimmed.slice(2).trim();
    }
  }

  // Fallback to first non-empty line
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      return trimmed.slice(0, 100);
    }
  }

  return 'Untitled';
}

// ============================================================================
// File Scanning
// ============================================================================

/**
 * Recursively scan directory for markdown files
 */
export async function scanDirectory(dirPath: string): Promise<string[]> {
  const files: string[] = [];

  if (!existsSync(dirPath)) {
    return files;
  }

  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const subFiles = await scanDirectory(fullPath);
      files.push(...subFiles);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

// ============================================================================
// Entry Transformation
// ============================================================================

/**
 * Transform legacy markdown file to MemoryStore entry
 */
export async function transformToEntry(filePath: string): Promise<MemoryEntry> {
  const content = readFileSync(filePath, 'utf-8');
  const { frontmatter, content: bodyContent } = parseFrontmatter(content);
  const stats = statSync(filePath);

  // Determine type from path
  const pathParts = filePath.split('/');
  let dirType = 'insight';
  for (const part of pathParts) {
    if (['LEARNING', 'research', 'KAYASYSTEMUPDATES', 'decisions', 'learnings'].includes(part)) {
      dirType = part;
      break;
    }
  }

  const type = mapToMemoryType(dirType);
  const category = extractCategory(filePath);
  const title = extractTitle(bodyContent) || basename(filePath, '.md');

  // Extract tags from frontmatter
  let tags: string[] = [];
  if (Array.isArray(frontmatter.tags)) {
    tags = frontmatter.tags;
  } else if (typeof frontmatter.tags === 'string') {
    tags = frontmatter.tags.split(',').map(t => t.trim());
  }

  // Add migration tag
  tags.push('migrated-from-legacy');

  // Build metadata
  const metadata: Record<string, any> = {
    originalPath: filePath,
    originalTimestamp: frontmatter.timestamp || stats.mtime.toISOString(),
    migratedAt: new Date().toISOString(),
    ...frontmatter,
  };

  return {
    type,
    category,
    title,
    content: bodyContent.trim(),
    tags,
    tier: 'warm',
    deduplicate: true,
    source: 'MigrationTool',
    metadata,
  };
}

// ============================================================================
// Migration Logic
// ============================================================================

/**
 * Migrate a directory of markdown files to MemoryStore
 */
export async function migrateDirectory(
  sourcePath: string,
  type: MemoryType,
  memoryStoreDir?: string,
  dryRun: boolean = false
): Promise<MigrationStats> {
  const stats: MigrationStats = {
    scanned: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    wouldImport: 0,
    errors: [],
  };

  // Create memory store instance
  const store = createMemoryStore(memoryStoreDir);

  // Scan for files
  console.log(`\nScanning: ${sourcePath}`);
  const files = await scanDirectory(sourcePath);
  stats.scanned = files.length;

  if (files.length === 0) {
    console.log('  No markdown files found');
    return stats;
  }

  console.log(`  Found ${files.length} files`);

  // Process each file
  for (const file of files) {
    try {
      const entry = await transformToEntry(file);

      if (dryRun) {
        stats.wouldImport++;
        console.log(`  [DRY RUN] Would import: ${entry.title}`);
      } else {
        // Import to MemoryStore (with deduplication)
        const result = await store.capture(entry);

        // Check if this was a duplicate by comparing IDs
        const isDuplicate = result.metadata?.originalPath !== file;

        if (isDuplicate) {
          stats.skipped++;
          console.log(`  [SKIP] Duplicate: ${entry.title}`);
        } else {
          stats.imported++;
          console.log(`  [IMPORT] ${result.id}: ${entry.title}`);
        }
      }
    } catch (error) {
      stats.failed++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      stats.errors.push({ file, error: errorMsg });
      console.error(`  [ERROR] ${file}: ${errorMsg}`);
    }
  }

  return stats;
}

/**
 * Migrate all legacy MEMORY directories
 */
export async function migrateAll(
  memoryDir: string,
  memoryStoreDir?: string,
  dryRun: boolean = false
): Promise<Record<string, MigrationStats>> {
  const results: Record<string, MigrationStats> = {};

  const migrations = [
    { source: join(memoryDir, 'LEARNING'), type: 'learning' as MemoryType },
    { source: join(memoryDir, 'research'), type: 'research' as MemoryType },
    { source: join(memoryDir, 'KAYASYSTEMUPDATES'), type: 'artifact' as MemoryType },
    { source: join(memoryDir, 'decisions'), type: 'decision' as MemoryType },
    { source: join(memoryDir, 'learnings'), type: 'learning' as MemoryType },
  ];

  console.log(`${dryRun ? '[DRY RUN] ' : ''}Migrating all legacy MEMORY directories...\n`);

  for (const { source, type } of migrations) {
    if (existsSync(source)) {
      const dirName = basename(source);
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Migrating: ${dirName} → type: ${type}`);
      console.log('='.repeat(60));

      results[dirName] = await migrateDirectory(source, type, memoryStoreDir, dryRun);
    }
  }

  return results;
}

// ============================================================================
// Statistics Reporting
// ============================================================================

/**
 * Print migration statistics
 */
function printStats(stats: MigrationStats | Record<string, MigrationStats>, dryRun: boolean): void {
  console.log('\n' + '='.repeat(60));
  console.log(dryRun ? 'DRY RUN SUMMARY' : 'MIGRATION SUMMARY');
  console.log('='.repeat(60));

  if ('scanned' in stats) {
    // Single directory stats
    console.log(`Scanned:      ${stats.scanned}`);
    if (dryRun) {
      console.log(`Would import: ${stats.wouldImport}`);
    } else {
      console.log(`Imported:     ${stats.imported}`);
      console.log(`Skipped:      ${stats.skipped} (duplicates)`);
      console.log(`Failed:       ${stats.failed}`);
    }

    if (stats.errors.length > 0) {
      console.log('\nErrors:');
      for (const { file, error } of stats.errors) {
        console.log(`  ${file}`);
        console.log(`    ${error}`);
      }
    }
  } else {
    // Multi-directory stats
    let totalScanned = 0;
    let totalImported = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    let totalWouldImport = 0;

    for (const [dir, dirStats] of Object.entries(stats)) {
      console.log(`\n${dir}:`);
      console.log(`  Scanned:      ${dirStats.scanned}`);
      if (dryRun) {
        console.log(`  Would import: ${dirStats.wouldImport}`);
      } else {
        console.log(`  Imported:     ${dirStats.imported}`);
        console.log(`  Skipped:      ${dirStats.skipped}`);
        console.log(`  Failed:       ${dirStats.failed}`);
      }

      totalScanned += dirStats.scanned;
      totalImported += dirStats.imported;
      totalSkipped += dirStats.skipped;
      totalFailed += dirStats.failed;
      totalWouldImport += dirStats.wouldImport;
    }

    console.log('\nTOTAL:');
    console.log(`  Scanned:      ${totalScanned}`);
    if (dryRun) {
      console.log(`  Would import: ${totalWouldImport}`);
    } else {
      console.log(`  Imported:     ${totalImported}`);
      console.log(`  Skipped:      ${totalSkipped} (duplicates)`);
      console.log(`  Failed:       ${totalFailed}`);
    }
  }

  console.log('='.repeat(60) + '\n');
}

// ============================================================================
// CLI Interface
// ============================================================================

async function runCli(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      source: { type: "string", short: "s" },
      type: { type: "string", short: "t" },
      all: { type: "boolean", short: "a" },
      "dry-run": { type: "boolean" },
      "memory-dir": { type: "string" },
      "store-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
MigrateToMemoryStore - Migration helper for legacy MEMORY files

Migrates existing MEMORY markdown files to the new MemoryStore infrastructure.

Usage:
  bun MigrateToMemoryStore.ts --source <path> --type <type> [options]
  bun MigrateToMemoryStore.ts --all [options]

Options:
  --source, -s      Source directory to migrate (e.g., MEMORY/LEARNING)
  --type, -t        Memory type: learning|research|artifact|decision|insight
  --all, -a         Migrate all legacy directories
  --dry-run         Preview migration without importing
  --memory-dir      Base MEMORY directory (default: ~/.claude/MEMORY)
  --store-dir       MemoryStore directory (default: ~/.claude/MEMORY)
  --help, -h        Show this help

Examples:
  # Preview LEARNING migration
  bun MigrateToMemoryStore.ts --source MEMORY/LEARNING --type learning --dry-run

  # Migrate LEARNING directory
  bun MigrateToMemoryStore.ts --source MEMORY/LEARNING --type learning

  # Migrate research directory
  bun MigrateToMemoryStore.ts --source MEMORY/research --type research

  # Migrate KAYASYSTEMUPDATES
  bun MigrateToMemoryStore.ts --source MEMORY/KAYASYSTEMUPDATES --type artifact

  # Migrate everything
  bun MigrateToMemoryStore.ts --all --dry-run

Directory Mapping:
  MEMORY/LEARNING        → type: learning, category extracted from subdirs
  MEMORY/research        → type: research
  MEMORY/KAYASYSTEMUPDATES → type: artifact
  MEMORY/decisions       → type: decision
  MEMORY/learnings       → type: learning

Features:
  - Parses YAML frontmatter from markdown
  - Extracts category from directory structure
  - Preserves original file dates
  - Auto-deduplication via content hashing
  - Progress reporting
`);
    return;
  }

  const dryRun = values['dry-run'] || false;
  const memoryDir = values['memory-dir'] || join(process.env.HOME!, '.claude', 'MEMORY');
  const storeDir = values['store-dir'];

  if (values.all) {
    // Migrate all directories
    const results = await migrateAll(memoryDir, storeDir, dryRun);
    printStats(results, dryRun);
  } else if (values.source && values.type) {
    // Migrate single directory
    let sourcePath = values.source;

    // If relative path, prepend memoryDir unless it already starts with MEMORY/
    if (!sourcePath.startsWith('/')) {
      if (sourcePath.startsWith('MEMORY/')) {
        // User provided full path from Kaya root
        sourcePath = join(process.env.HOME!, '.claude', sourcePath);
      } else {
        // Relative path from memoryDir
        sourcePath = join(memoryDir, sourcePath);
      }
    }

    if (!existsSync(sourcePath)) {
      console.error(`Error: Source directory not found: ${sourcePath}`);
      process.exit(1);
    }

    const type = values.type as MemoryType;
    const stats = await migrateDirectory(sourcePath, type, storeDir, dryRun);
    printStats(stats, dryRun);
  } else {
    console.error('Error: Must specify either --all or both --source and --type');
    console.error('Run with --help for usage information');
    process.exit(1);
  }
}

// Run CLI if executed directly
if (import.meta.main) {
  runCli().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
