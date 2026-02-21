#!/usr/bin/env bun
/**
 * ContextLoadTool.ts - Active context management tool
 *
 * Self-editing memory pattern: Claude calls this tool to actively
 * manage its own context loading mid-session.
 *
 * Commands:
 *   load <profile>  - Load a context profile
 *   file <path>     - Load a specific file with freshness check
 *   status          - Show what's currently loaded (budget dashboard)
 *   unload <set>    - Mark context as no longer needed
 *
 * CLI: bun ContextLoadTool.ts load scheduling
 * CLI: bun ContextLoadTool.ts file context/CalendarContext.md
 * CLI: bun ContextLoadTool.ts status
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { selectContext, getProfile } from './ContextSelector';
import { checkFreshness } from './FreshnessChecker';
import { estimateTokens, estimateFileTokens } from './TokenEstimator';
import {
  getSessionState,
  updateSessionState,
  recordLoadedFile,
  setProfile,
  type SessionState,
  type LoadedFile,
} from './ContextManagerState';

const KAYA_DIR = process.env.KAYA_DIR || join(process.env.HOME!, '.claude');

/**
 * Load a context profile - outputs file contents to stdout
 */
async function loadProfile(profileName: string): Promise<void> {
  const profile = getProfile(profileName);
  if (!profile) {
    console.error(`Profile "${profileName}" not found`);
    process.exit(1);
  }

  const selection = selectContext(profileName);
  const state = await getSessionState();

  // Track what's already loaded to avoid duplicates
  const alreadyLoaded = new Set(state.loadedFiles.map(f => f.path));

  let output = `\n## Context Profile: ${profileName} (${profile.tokenBudget} token budget)\n\n`;
  let newTokens = 0;

  for (const file of selection.files) {
    if (alreadyLoaded.has(file.path)) {
      console.error(`[ContextLoad] Skipping already-loaded: ${file.path}`);
      continue;
    }

    // Freshness check
    const freshness = checkFreshness(file.absolutePath);
    const freshnessNote = freshness.category === 'outdated'
      ? ` [OUTDATED - ${freshness.ageHours.toFixed(0)}h old]`
      : freshness.category === 'stale'
      ? ` [stale - ${freshness.ageHours.toFixed(0)}h old]`
      : '';

    output += `### ${file.path}${freshnessNote}${file.compressed ? ' (compressed)' : ''}\n\n`;
    output += file.content + '\n\n---\n\n';
    newTokens += file.tokens;

    // Record in state
    await recordLoadedFile({
      path: file.path,
      tokens: file.tokens,
      compressed: file.compressed,
      loadedAt: new Date().toISOString(),
      tier: 'on-demand',
    });
  }

  // Update profile in state
  await setProfile(profileName, profile.tokenBudget, {
    profile: profileName,
    confidence: 1.0,
    stage: 'keyword',
    reasoning: 'Manual profile load via ContextLoadTool',
    timestamp: new Date().toISOString(),
  });

  // Output to stdout for Claude to capture
  console.log(output);

  // Status to stderr
  console.error(`[ContextLoad] Loaded ${selection.files.length} files, ${newTokens} new tokens`);
  if (selection.skippedFiles.length > 0) {
    console.error(`[ContextLoad] Skipped: ${selection.skippedFiles.map(s => s.path).join(', ')}`);
  }
}

/**
 * Load a specific file with freshness check
 */
async function loadFile(relativePath: string): Promise<void> {
  const absolutePath = relativePath.startsWith('/')
    ? relativePath
    : join(KAYA_DIR, relativePath);

  if (!existsSync(absolutePath)) {
    console.error(`File not found: ${absolutePath}`);
    process.exit(1);
  }

  const content = readFileSync(absolutePath, 'utf-8');
  const tokens = estimateTokens(content);
  const freshness = checkFreshness(absolutePath);

  const relPath = absolutePath.replace(KAYA_DIR + '/', '');

  // Freshness warning
  if (freshness.category === 'outdated') {
    console.error(`⚠️ [ContextLoad] ${relPath} is OUTDATED (${freshness.ageHours.toFixed(0)}h old)`);
  } else if (freshness.category === 'stale') {
    console.error(`⚠️ [ContextLoad] ${relPath} is stale (${freshness.ageHours.toFixed(0)}h old)`);
  }

  // Output content
  console.log(`\n### ${relPath} (${tokens} tokens, ${freshness.category})\n\n${content}`);

  // Record in state
  await recordLoadedFile({
    path: relPath,
    tokens,
    compressed: false,
    loadedAt: new Date().toISOString(),
    tier: 'on-demand',
  });

  console.error(`[ContextLoad] Loaded ${relPath}: ${tokens} tokens, ${freshness.category}`);
}

/**
 * Show current context budget dashboard
 */
async function showStatus(): Promise<void> {
  const state = await getSessionState();

  const output: Record<string, unknown> = {
    profile: state.currentProfile,
    classification: state.classification,
    tokenBudget: state.tokenBudget,
    tokensUsed: state.totalTokensUsed,
    tokensRemaining: state.tokenBudget - state.totalTokensUsed,
    profileChanges: state.profileChanges,
    loadedFiles: state.loadedFiles.map(f => ({
      path: f.path,
      tokens: f.tokens,
      compressed: f.compressed,
      tier: f.tier,
    })),
    summary: {
      totalFiles: state.loadedFiles.length,
      byTier: {
        boot: state.loadedFiles.filter(f => f.tier === 'boot').length,
        profile: state.loadedFiles.filter(f => f.tier === 'profile').length,
        'on-demand': state.loadedFiles.filter(f => f.tier === 'on-demand').length,
      },
      compressed: state.loadedFiles.filter(f => f.compressed).length,
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

/**
 * Mark context as no longer needed
 */
async function unloadContext(contextSet: string): Promise<void> {
  await updateSessionState((state) => ({
    ...state,
    loadedFiles: state.loadedFiles.filter(f => {
      // Match by tier name, profile name, or path prefix
      if (f.tier === contextSet) return false;
      if (f.path.toLowerCase().includes(contextSet.toLowerCase())) return false;
      return true;
    }),
    totalTokensUsed: state.loadedFiles
      .filter(f => {
        if (f.tier === contextSet) return false;
        if (f.path.toLowerCase().includes(contextSet.toLowerCase())) return false;
        return true;
      })
      .reduce((sum, f) => sum + f.tokens, 0),
  }));

  console.error(`[ContextLoad] Unloaded context matching: ${contextSet}`);
}

// CLI
if (import.meta.main) {
  const cmd = process.argv[2];
  const arg = process.argv[3];

  switch (cmd) {
    case 'load':
      if (!arg) {
        console.error('Usage: bun ContextLoadTool.ts load <profile-name>');
        process.exit(1);
      }
      await loadProfile(arg);
      break;

    case 'file':
      if (!arg) {
        console.error('Usage: bun ContextLoadTool.ts file <relative-path>');
        process.exit(1);
      }
      await loadFile(arg);
      break;

    case 'status':
      await showStatus();
      break;

    case 'unload':
      if (!arg) {
        console.error('Usage: bun ContextLoadTool.ts unload <context-set>');
        process.exit(1);
      }
      await unloadContext(arg);
      break;

    default:
      console.log('ContextLoadTool - Active context management');
      console.log('');
      console.log('Usage:');
      console.log('  bun ContextLoadTool.ts load <profile>   Load a context profile');
      console.log('  bun ContextLoadTool.ts file <path>      Load a specific file');
      console.log('  bun ContextLoadTool.ts status           Show budget dashboard');
      console.log('  bun ContextLoadTool.ts unload <set>     Unload context');
      break;
  }
}
