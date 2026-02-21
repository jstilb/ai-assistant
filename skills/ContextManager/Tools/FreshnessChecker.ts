#!/usr/bin/env bun
/**
 * FreshnessChecker.ts - Context file staleness detection
 *
 * Checks freshness via:
 * 1. YAML frontmatter `last_updated` field
 * 2. File modification time (fallback)
 *
 * Categories:
 * - fresh: < 24 hours
 * - stale: 24-72 hours
 * - outdated: > 72 hours
 *
 * CLI: bun FreshnessChecker.ts <file>
 * API: import { checkFreshness } from "./FreshnessChecker"
 */

import { existsSync, readFileSync, statSync } from 'fs';

export type FreshnessCategory = 'fresh' | 'stale' | 'outdated' | 'unknown';

export interface FreshnessResult {
  file: string;
  category: FreshnessCategory;
  lastUpdated: string | null;
  ageHours: number;
  source: 'frontmatter' | 'mtime' | 'none';
}

const FRESH_THRESHOLD_HOURS = 24;
const STALE_THRESHOLD_HOURS = 72;

/**
 * Extract last_updated from YAML frontmatter
 */
function extractFrontmatterDate(content: string): string | null {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;

  const frontmatter = frontmatterMatch[1];
  // Look for last_updated, lastUpdated, or updated field
  const dateMatch = frontmatter.match(/(?:last_updated|lastUpdated|updated)\s*:\s*(.+)/i);
  if (!dateMatch) return null;

  const dateStr = dateMatch[1].trim().replace(/^["']|["']$/g, '');
  // Validate it's a parseable date
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return null;

  return parsed.toISOString();
}

/**
 * Categorize age in hours
 */
function categorizeAge(ageHours: number): FreshnessCategory {
  if (ageHours < FRESH_THRESHOLD_HOURS) return 'fresh';
  if (ageHours < STALE_THRESHOLD_HOURS) return 'stale';
  return 'outdated';
}

export function checkFreshness(filePath: string): FreshnessResult {
  if (!existsSync(filePath)) {
    return { file: filePath, category: 'unknown', lastUpdated: null, ageHours: -1, source: 'none' };
  }

  const content = readFileSync(filePath, 'utf-8');

  // Try frontmatter first
  const frontmatterDate = extractFrontmatterDate(content);
  if (frontmatterDate) {
    const ageMs = Date.now() - new Date(frontmatterDate).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    return {
      file: filePath,
      category: categorizeAge(ageHours),
      lastUpdated: frontmatterDate,
      ageHours: Math.round(ageHours * 10) / 10,
      source: 'frontmatter',
    };
  }

  // Fall back to file mtime
  const stat = statSync(filePath);
  const ageMs = Date.now() - stat.mtimeMs;
  const ageHours = ageMs / (1000 * 60 * 60);
  return {
    file: filePath,
    category: categorizeAge(ageHours),
    lastUpdated: stat.mtime.toISOString(),
    ageHours: Math.round(ageHours * 10) / 10,
    source: 'mtime',
  };
}

/**
 * Check multiple files and return summary
 */
export function checkMultipleFreshness(filePaths: string[]): {
  results: FreshnessResult[];
  summary: { fresh: number; stale: number; outdated: number; unknown: number };
} {
  const results = filePaths.map(checkFreshness);
  const summary = { fresh: 0, stale: 0, outdated: 0, unknown: 0 };
  for (const r of results) {
    summary[r.category]++;
  }
  return { results, summary };
}

// CLI
if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.log('Usage: bun FreshnessChecker.ts <file1> [file2] ...');
    process.exit(1);
  }

  if (files.length === 1) {
    console.log(JSON.stringify(checkFreshness(files[0]), null, 2));
  } else {
    console.log(JSON.stringify(checkMultipleFreshness(files), null, 2));
  }
}
