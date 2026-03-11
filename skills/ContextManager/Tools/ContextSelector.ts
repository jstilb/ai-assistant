#!/usr/bin/env bun
/**
 * ContextSelector.ts - Budget-aware context file selection
 *
 * Loads files in priority order (required → recommended → optional)
 * within a token budget. Falls back to compressed versions when needed.
 *
 * CLI: bun ContextSelector.ts <profile-name>
 * API: import { selectContext } from "./ContextSelector"
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { z } from 'zod';
import { createStateManager } from '../../../lib/core/StateManager';
import { estimateTokens, estimateFileTokens } from './TokenEstimator';

const KAYA_DIR = process.env.KAYA_DIR || join(process.env.HOME!, '.claude');
const PROFILES_CONFIG_PATH = join(KAYA_DIR, 'skills/ContextManager/config/profiles.json');

// Types
export interface SelectedFile {
  path: string;
  absolutePath: string;
  tokens: number;
  compressed: boolean;
  tier: 'required' | 'recommended' | 'optional';
  content: string;
}

export interface ContextSelection {
  profile: string;
  files: SelectedFile[];
  totalTokens: number;
  budgetUsed: number;
  budgetRemaining: number;
  tokenBudget: number;
  skippedFiles: Array<{ path: string; reason: string; tokens?: number }>;
}

interface ProfileConfig {
  tokenBudget: number;
  description: string;
  required: string[];
  recommended: string[];
  optional: string[];
  excludes: string[];
}

interface ProfilesConfig {
  profiles: Record<string, ProfileConfig>;
}

const ProfileConfigSchema = z.object({
  tokenBudget: z.number(),
  description: z.string().default(''),
  required: z.array(z.string()).default([]),
  recommended: z.array(z.string()).default([]),
  optional: z.array(z.string()).default([]),
  excludes: z.array(z.string()).default([]),
});

const ProfilesConfigSchema = z.object({
  profiles: z.record(z.string(), ProfileConfigSchema),
});

const profilesState = createStateManager({
  path: PROFILES_CONFIG_PATH,
  schema: ProfilesConfigSchema,
  defaults: { profiles: {} },
});

// Cache profiles config
let cachedProfiles: ProfilesConfig | null = null;

async function loadProfiles(): Promise<ProfilesConfig> {
  if (cachedProfiles) return cachedProfiles;
  cachedProfiles = await profilesState.load();
  return cachedProfiles;
}

/**
 * Get the compressed version path for a file
 */
function getCompressedPath(filePath: string): string {
  const ext = extname(filePath);
  const base = basename(filePath, ext);
  const dir = dirname(filePath);
  return join(dir, `${base}.compressed${ext}`);
}

/**
 * Resolve a relative path to absolute, expanding globs
 */
function resolveFilePaths(relativePath: string): string[] {
  // Handle glob patterns like "USER/TELOS/*.md"
  if (relativePath.includes('*')) {
    // Simple glob expansion for common patterns
    const dir = join(KAYA_DIR, dirname(relativePath));
    const pattern = basename(relativePath);

    if (!existsSync(dir)) return [];

    try {
      const { readdirSync } = require('fs');
      const files = readdirSync(dir) as string[];
      const ext = pattern.replace('*', '');
      return files
        .filter((f: string) => f.endsWith(ext))
        .map((f: string) => join(dir, f));
    } catch {
      return [];
    }
  }

  const absolute = join(KAYA_DIR, relativePath);
  return existsSync(absolute) ? [absolute] : [];
}

/**
 * Try to load a file, optionally preferring compressed version
 */
function loadFileWithBudget(
  relativePath: string,
  remainingBudget: number,
  tier: 'required' | 'recommended' | 'optional',
  preferCompressed = false,
): { file: SelectedFile; skipped?: never } | { file?: never; skipped: { path: string; reason: string; tokens?: number } } {
  const absolutePath = join(KAYA_DIR, relativePath);

  if (!existsSync(absolutePath)) {
    return { skipped: { path: relativePath, reason: 'file not found' } };
  }

  const content = readFileSync(absolutePath, 'utf-8');
  const tokens = estimateTokens(content);

  // When preferCompressed, try compressed first to conserve budget
  if (preferCompressed) {
    const compressedAbsolute = getCompressedPath(absolutePath);
    if (existsSync(compressedAbsolute)) {
      const compressedContent = readFileSync(compressedAbsolute, 'utf-8');
      const compressedTokens = estimateTokens(compressedContent);

      if (compressedTokens <= remainingBudget) {
        return {
          file: {
            path: relativePath,
            absolutePath: compressedAbsolute,
            tokens: compressedTokens,
            compressed: true,
            tier,
            content: compressedContent,
          },
        };
      }
    }
    // Fall through to full version if compressed doesn't exist or still too large
  }

  // File fits within budget
  if (tokens <= remainingBudget) {
    // Optionally TOON-encode JSON array content for token savings (Phase 3b)
    let finalContent = content;
    let finalTokens = tokens;
    if (isToonContextEnabled()) {
      const toonResult = maybeConvertContentToToon(content);
      if (toonResult.converted) {
        finalContent = toonResult.content;
        finalTokens = estimateTokens(finalContent);
      }
    }
    return {
      file: {
        path: relativePath,
        absolutePath,
        tokens: finalTokens,
        compressed: false,
        tier,
        content: finalContent,
      },
    };
  }

  // Try compressed version (fallback when not preferring compressed)
  if (!preferCompressed) {
    const compressedAbsolute = getCompressedPath(absolutePath);
    if (existsSync(compressedAbsolute)) {
      const compressedContent = readFileSync(compressedAbsolute, 'utf-8');
      const compressedTokens = estimateTokens(compressedContent);

      if (compressedTokens <= remainingBudget) {
        return {
          file: {
            path: relativePath,
            absolutePath: compressedAbsolute,
            tokens: compressedTokens,
            compressed: true,
            tier,
            content: compressedContent,
          },
        };
      }
    }
  }

  // Doesn't fit even compressed
  return {
    skipped: {
      path: relativePath,
      reason: `exceeds budget (${tokens} tokens, ${remainingBudget} remaining)`,
      tokens,
    },
  };
}

/**
 * Estimate total raw tokens for a list of file paths
 */
function estimateTierTokens(paths: string[]): number {
  let total = 0;
  for (const relativePath of paths) {
    if (relativePath.includes('*')) {
      const expandedPaths = resolveFilePaths(relativePath);
      for (const absPath of expandedPaths) {
        if (existsSync(absPath)) {
          total += estimateTokens(readFileSync(absPath, 'utf-8'));
        }
      }
    } else {
      const absolutePath = join(KAYA_DIR, relativePath);
      if (existsSync(absolutePath)) {
        total += estimateTokens(readFileSync(absolutePath, 'utf-8'));
      }
    }
  }
  return total;
}

/**
 * Select context files for a profile within token budget
 */
export async function selectContext(profileName: string): Promise<ContextSelection> {
  const config = await loadProfiles();
  const profile = config.profiles[profileName];

  if (!profile) {
    console.error(`[ContextSelector] Profile "${profileName}" not found`);
    return {
      profile: profileName,
      files: [],
      totalTokens: 0,
      budgetUsed: 0,
      budgetRemaining: 0,
      tokenBudget: 0,
      skippedFiles: [{ path: '*', reason: `profile "${profileName}" not found` }],
    };
  }

  const files: SelectedFile[] = [];
  const skippedFiles: ContextSelection['skippedFiles'] = [];
  let remainingBudget = profile.tokenBudget;

  // Process files in priority order
  const tiers: Array<{ paths: string[]; tier: 'required' | 'recommended' | 'optional' }> = [
    { paths: profile.required, tier: 'required' },
    { paths: profile.recommended, tier: 'recommended' },
    { paths: profile.optional, tier: 'optional' },
  ];

  for (const { paths, tier } of tiers) {
    // Pre-scan: if raw total for this tier exceeds remaining budget,
    // prefer compressed versions to fit more files
    const tierRawTokens = estimateTierTokens(paths);
    const preferCompressed = tierRawTokens > remainingBudget;

    for (const relativePath of paths) {
      if (remainingBudget <= 0) {
        skippedFiles.push({ path: relativePath, reason: 'budget exhausted' });
        continue;
      }

      // Expand glob patterns
      if (relativePath.includes('*')) {
        const expandedPaths = resolveFilePaths(relativePath);
        for (const absPath of expandedPaths) {
          const relPath = absPath.replace(KAYA_DIR + '/', '');
          const result = loadFileWithBudget(relPath, remainingBudget, tier, preferCompressed);
          if (result.file) {
            files.push(result.file);
            remainingBudget -= result.file.tokens;
          } else if (result.skipped) {
            skippedFiles.push(result.skipped);
          }
        }
      } else {
        const result = loadFileWithBudget(relativePath, remainingBudget, tier, preferCompressed);
        if (result.file) {
          files.push(result.file);
          remainingBudget -= result.file.tokens;
        } else if (result.skipped) {
          skippedFiles.push(result.skipped);
        }
      }
    }
  }

  const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);

  return {
    profile: profileName,
    files,
    totalTokens,
    budgetUsed: profile.tokenBudget - remainingBudget,
    budgetRemaining: remainingBudget,
    tokenBudget: profile.tokenBudget,
    skippedFiles,
  };
}

// ============================================================================
// TOON ENCODING FOR CONTEXT FILES (Phase 3b)
// ============================================================================

export interface ToonConversionResult {
  /** Whether the content was converted to TOON format */
  converted: boolean;
  /** The (possibly converted) content */
  content: string;
  /** The format of the returned content */
  format: 'toon' | 'original';
}

/**
 * Check if TOON context encoding is enabled in settings.json
 */
function isToonContextEnabled(): boolean {
  try {
    const settingsPath = join(KAYA_DIR, 'settings.json');
    if (!existsSync(settingsPath)) return false;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return settings?.toon?.enableInContext === true;
  } catch {
    return false;
  }
}

/**
 * Attempt to convert file content to TOON format for token savings.
 *
 * Only converts when:
 * 1. Content is valid JSON
 * 2. Parsed result is an array of objects
 * 3. TOON encoding yields significant token savings (>10%)
 *
 * This is a pure function that does NOT check the settings flag --
 * the caller is responsible for gating behind toon.enableInContext.
 *
 * @param content - The file content to potentially convert
 * @returns Object with converted flag, content, and format
 */
export function maybeConvertContentToToon(content: string): ToonConversionResult {
  // Quick check: must start with [ to be a JSON array
  const trimmed = content.trim();
  if (!trimmed.startsWith('[')) {
    return { converted: false, content, format: 'original' };
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { converted: false, content, format: 'original' };
    }

    // Check that items are objects (not primitives)
    if (typeof parsed[0] !== 'object' || parsed[0] === null) {
      return { converted: false, content, format: 'original' };
    }

    // Lazy import ToonHelper to avoid circular dependencies
    const { maybeEncode } = require("../../../lib/core/ToonHelper") as typeof import("../../../lib/core/ToonHelper");

    const result = maybeEncode(parsed);
    if (result.format === 'toon') {
      return { converted: true, content: result.data, format: 'toon' };
    }

    return { converted: false, content, format: 'original' };
  } catch {
    // Not valid JSON, return original
    return { converted: false, content, format: 'original' };
  }
}

/**
 * Get profile configuration
 */
export async function getProfile(profileName: string): Promise<ProfileConfig | null> {
  const config = await loadProfiles();
  return config.profiles[profileName] || null;
}

/**
 * List all available profiles
 */
export async function listProfiles(): Promise<Array<{ name: string; budget: number; description: string }>> {
  const config = await loadProfiles();
  return Object.entries(config.profiles).map(([name, p]) => ({
    name,
    budget: p.tokenBudget,
    description: p.description,
  }));
}

// CLI
if (import.meta.main) {
  const profileName = process.argv[2];

  if (!profileName || profileName === '--list') {
    const profiles = await listProfiles();
    if (profileName === '--list') {
      console.log(JSON.stringify(profiles, null, 2));
    } else {
      console.log('Usage: bun ContextSelector.ts <profile-name>');
      console.log('       bun ContextSelector.ts --list');
      console.log('\nAvailable profiles:');
      for (const p of profiles) {
        console.log(`  ${p.name.padEnd(20)} ${p.budget} tokens - ${p.description}`);
      }
    }
    process.exit(0);
  }

  const selection = await selectContext(profileName);
  // Output without content for CLI display
  const display = {
    ...selection,
    files: selection.files.map(({ content, ...rest }) => rest),
  };
  console.log(JSON.stringify(display, null, 2));
}
