#!/usr/bin/env bun
/**
 * CacheManager.ts
 *
 * Track generated outputs and detect staleness.
 * Hashes skills/, hooks/, MEMORY/ directories to determine when regeneration is needed.
 *
 * Usage:
 *   bun CacheManager.ts status              # Show cache status
 *   bun CacheManager.ts check               # Check if regeneration needed (exit code 0=stale, 1=fresh)
 *   bun CacheManager.ts update              # Update cache state after generation
 *   bun CacheManager.ts invalidate          # Force invalidate cache
 */

import { readFile, writeFile, stat, readdir, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { generateSystemHash } from './SystemScanner.ts';

const KAYA_DIR = process.env.KAYA_DIR || process.env.KAYA_HOME || join(process.env.HOME || '', '.claude');
const CACHE_FILE = join(KAYA_DIR, 'skills', 'SystemFlowchart', 'Output', '.cache-state.json');

// ============================================================================
// Types
// ============================================================================

export interface CacheState {
  lastGenerated: string;
  systemHash: string;
  generatedFiles: GeneratedFile[];
  stats: {
    skillCount: number;
    hookCount: number;
    memoryDirs: number;
  };
}

export interface GeneratedFile {
  path: string;
  type: 'markdown' | 'png';
  generatedAt: string;
  hash: string;
}

export interface CacheStatus {
  isStale: boolean;
  reason: string;
  lastGenerated: string | null;
  currentHash: string;
  cachedHash: string | null;
  missingFiles: string[];
}

// ============================================================================
// Cache Operations
// ============================================================================

/**
 * Load current cache state from file
 */
export async function loadCacheState(): Promise<CacheState | null> {
  if (!existsSync(CACHE_FILE)) {
    return null;
  }

  try {
    const content = await readFile(CACHE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Save cache state to file
 */
export async function saveCacheState(state: CacheState): Promise<void> {
  const dir = join(KAYA_DIR, 'skills', 'SystemFlowchart', 'Output');
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  await writeFile(CACHE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Hash a file's contents
 */
async function hashFile(filePath: string): Promise<string> {
  if (!existsSync(filePath)) {
    return 'missing';
  }

  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

/**
 * Count items in a directory
 */
async function countDirectory(dirPath: string): Promise<number> {
  if (!existsSync(dirPath)) {
    return 0;
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries.filter(e => !e.name.startsWith('.')).length;
}

/**
 * Check if generated files still exist
 */
async function checkGeneratedFiles(files: GeneratedFile[]): Promise<string[]> {
  const missing: string[] = [];

  for (const file of files) {
    if (!existsSync(file.path)) {
      missing.push(file.path);
    }
  }

  return missing;
}

/**
 * Get current system stats for comparison
 */
async function getCurrentStats(): Promise<{ skillCount: number; hookCount: number; memoryDirs: number }> {
  const skillCount = await countDirectory(join(KAYA_DIR, 'skills'));
  const hookCount = await countDirectory(join(KAYA_DIR, 'hooks'));
  const memoryDirs = await countDirectory(join(KAYA_DIR, 'MEMORY'));

  return { skillCount, hookCount, memoryDirs };
}

/**
 * Check if cache is stale and regeneration is needed
 */
export async function checkCacheStatus(): Promise<CacheStatus> {
  const currentHash = await generateSystemHash();
  const cached = await loadCacheState();

  // No cache exists
  if (!cached) {
    return {
      isStale: true,
      reason: 'No cache exists - first generation needed',
      lastGenerated: null,
      currentHash,
      cachedHash: null,
      missingFiles: [],
    };
  }

  // Check if system hash changed
  if (cached.systemHash !== currentHash) {
    return {
      isStale: true,
      reason: 'System hash changed - skills, hooks, or memory modified',
      lastGenerated: cached.lastGenerated,
      currentHash,
      cachedHash: cached.systemHash,
      missingFiles: [],
    };
  }

  // Check if generated files still exist
  const missing = await checkGeneratedFiles(cached.generatedFiles);
  if (missing.length > 0) {
    return {
      isStale: true,
      reason: `Missing generated files: ${missing.length} files`,
      lastGenerated: cached.lastGenerated,
      currentHash,
      cachedHash: cached.systemHash,
      missingFiles: missing,
    };
  }

  // Check if stats changed significantly
  const currentStats = await getCurrentStats();
  if (
    Math.abs(cached.stats.skillCount - currentStats.skillCount) > 2 ||
    Math.abs(cached.stats.hookCount - currentStats.hookCount) > 2
  ) {
    return {
      isStale: true,
      reason: 'Significant change in skill or hook count',
      lastGenerated: cached.lastGenerated,
      currentHash,
      cachedHash: cached.systemHash,
      missingFiles: [],
    };
  }

  // Cache is fresh
  return {
    isStale: false,
    reason: 'Cache is up to date',
    lastGenerated: cached.lastGenerated,
    currentHash,
    cachedHash: cached.systemHash,
    missingFiles: [],
  };
}

/**
 * Update cache after successful generation
 */
export async function updateCache(generatedFiles: string[]): Promise<CacheState> {
  const systemHash = await generateSystemHash();
  const stats = await getCurrentStats();

  const files: GeneratedFile[] = [];
  for (const filePath of generatedFiles) {
    const fileHash = await hashFile(filePath);
    files.push({
      path: filePath,
      type: filePath.endsWith('.png') ? 'png' : 'markdown',
      generatedAt: new Date().toISOString(),
      hash: fileHash,
    });
  }

  const state: CacheState = {
    lastGenerated: new Date().toISOString(),
    systemHash,
    generatedFiles: files,
    stats,
  };

  await saveCacheState(state);
  return state;
}

/**
 * Invalidate cache (force regeneration on next check)
 */
export async function invalidateCache(): Promise<void> {
  const cached = await loadCacheState();
  if (cached) {
    cached.systemHash = 'invalidated';
    await saveCacheState(cached);
  }
}

/**
 * Get time since last generation in human-readable format
 */
function timeSince(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  return 'just now';
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';

  switch (command) {
    case 'status': {
      const status = await checkCacheStatus();
      const cached = await loadCacheState();

      console.log('\n📊 SystemFlowchart Cache Status\n');

      if (status.isStale) {
        console.log('⚠️  Status: STALE (regeneration needed)');
        console.log(`   Reason: ${status.reason}`);
      } else {
        console.log('✅ Status: FRESH (no regeneration needed)');
      }

      console.log(`\n   Current hash: ${status.currentHash}`);
      console.log(`   Cached hash:  ${status.cachedHash || 'none'}`);

      if (status.lastGenerated) {
        console.log(`   Last generated: ${timeSince(status.lastGenerated)}`);
      }

      if (cached) {
        console.log(`\n   Generated files: ${cached.generatedFiles.length}`);
        console.log(`   - Markdown: ${cached.generatedFiles.filter(f => f.type === 'markdown').length}`);
        console.log(`   - PNG: ${cached.generatedFiles.filter(f => f.type === 'png').length}`);

        console.log(`\n   System stats when generated:`);
        console.log(`   - Skills: ${cached.stats.skillCount}`);
        console.log(`   - Hooks: ${cached.stats.hookCount}`);
        console.log(`   - Memory dirs: ${cached.stats.memoryDirs}`);
      }

      if (status.missingFiles.length > 0) {
        console.log(`\n   Missing files:`);
        for (const file of status.missingFiles) {
          console.log(`   - ${file}`);
        }
      }

      break;
    }

    case 'check': {
      const status = await checkCacheStatus();
      if (status.isStale) {
        console.log(`Stale: ${status.reason}`);
        process.exit(0); // Exit 0 = stale, regeneration needed
      } else {
        console.log('Fresh: No regeneration needed');
        process.exit(1); // Exit 1 = fresh, skip regeneration
      }
      break;
    }

    case 'update': {
      const outputDir = join(KAYA_DIR, 'skills', 'SystemFlowchart', 'Output');
      const files: string[] = [];

      // Collect markdown files
      const mdDir = join(outputDir, 'markdown');
      if (existsSync(mdDir)) {
        const mdFiles = await readdir(mdDir);
        files.push(...mdFiles.filter(f => f.endsWith('.md')).map(f => join(mdDir, f)));
      }

      // Collect image files
      const imgDir = join(outputDir, 'images');
      if (existsSync(imgDir)) {
        const imgFiles = await readdir(imgDir);
        files.push(...imgFiles.filter(f => f.endsWith('.png')).map(f => join(imgDir, f)));
      }

      const state = await updateCache(files);
      console.log(`✅ Cache updated with ${state.generatedFiles.length} files`);
      console.log(`   System hash: ${state.systemHash}`);
      break;
    }

    case 'invalidate': {
      await invalidateCache();
      console.log('✅ Cache invalidated - next check will trigger regeneration');
      break;
    }

    case 'hash': {
      const hash = await generateSystemHash();
      console.log(hash);
      break;
    }

    default:
      console.log(`
CacheManager - Track Generated Output Staleness

Usage:
  bun CacheManager.ts status       Show cache status
  bun CacheManager.ts check        Check if regeneration needed (exit 0=stale, 1=fresh)
  bun CacheManager.ts update       Update cache after generation
  bun CacheManager.ts invalidate   Force invalidate cache
  bun CacheManager.ts hash         Show current system hash
`);
  }
}

main().catch(console.error);
