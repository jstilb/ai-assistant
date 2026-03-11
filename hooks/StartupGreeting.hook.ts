#!/usr/bin/env bun
/**
 * StartupGreeting.hook.ts - Display Kaya Banner at Session Start (SessionStart)
 *
 * PURPOSE:
 * Displays the responsive neofetch-style Kaya banner with system statistics.
 * Creates a visual confirmation that Kaya is initialized and shows key metrics
 * like skill count, session count, and learning items.
 *
 * TRIGGER: SessionStart
 *
 * INPUT:
 * - Environment: COLUMNS, KITTY_WINDOW_ID for terminal detection
 * - Settings: settings.json for identity configuration
 *
 * OUTPUT:
 * - stdout: Banner display (captured by Claude Code)
 * - stderr: Error messages on failure
 * - exit(0): Normal completion
 * - exit(1): Banner display failed
 *
 * SIDE EFFECTS:
 * - Spawns Banner.ts tool as child process
 * - Reads settings.json for configuration
 *
 * INTER-HOOK RELATIONSHIPS:
 * - DEPENDS ON: None (runs independently at session start)
 * - COORDINATES WITH: LoadContext (both run at SessionStart)
 * - MUST RUN BEFORE: None (visual feedback only)
 * - MUST RUN AFTER: None
 *
 * ERROR HANDLING:
 * - Missing settings: Error logged, continues with graceful fallback
 * - Banner tool failure: Error logged, continues (session not blocked)
 *
 * PERFORMANCE:
 * - Non-blocking: Yes (banner is informational)
 * - Typical execution: <100ms
 * - Skipped for subagents: Yes
 *
 * BANNER MODES:
 * - nano (<40 cols): Minimal single-line
 * - micro (40-59 cols): Compact with stats
 * - mini (60-84 cols): Medium layout
 * - normal (85+ cols): Full neofetch-style
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync, execSync } from 'child_process';

import { getKayaDir, getSettingsPath } from './lib/paths';

const kayaDir = getKayaDir();
const settingsPath = getSettingsPath();

try {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));

  // Check if this is a subagent session - if so, exit silently
  const claudeProjectDir = process.env.CLAUDE_PROJECT_DIR || '';
  const isSubagent = claudeProjectDir.includes('/.claude/Agents/') ||
                    process.env.CLAUDE_AGENT_TYPE !== undefined;

  if (isSubagent) {
    process.exit(0);
  }

  // Run the banner tool — visual output to stderr (terminal only, not context)
  const bannerPath = join(kayaDir, 'lib/core/Banner.ts');
  const result = spawnSync('bun', ['run', bannerPath], {
    encoding: 'utf-8',
    stdio: ['inherit', 'pipe', 'pipe'],
    env: {
      ...process.env,
      COLUMNS: process.env.COLUMNS,
      KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
    }
  });

  if (result.stdout) {
    // Banner goes to stderr (visible in terminal, not in context window)
    console.error(result.stdout);
  }

  // Get dynamic stats for compact context line
  const statsResult = spawnSync('bun', ['run', bannerPath, '--stats-json'], {
    encoding: 'utf-8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  let statsLine = 'Kaya | Ready';
  try {
    if (statsResult.stdout) {
      const stats = JSON.parse(statsResult.stdout.trim());
      statsLine = `Kaya v${stats.version} | ${stats.skills} skills, ${stats.workflows} workflows, ${stats.hooks} hooks | Ready`;
    }
  } catch {
    // Fallback to simple line
  }

  // Compact stats line goes to stdout (enters context window)
  console.log(statsLine);

  // Set initial tab title - always start fresh
  // New sessions are a clean slate, no context from previous sessions
  const isKitty = process.env.TERM === 'xterm-kitty' || process.env.KITTY_LISTEN_ON;
  if (isKitty) {
    try {
      execSync(`kitty @ set-tab-title "Ready to work..."`, { stdio: 'ignore', timeout: 2000 });
    } catch {
      // Silent failure - tab title is non-critical
    }
  }

  process.exit(0);
} catch (error) {
  console.error('⚠️ StartupGreeting: Failed to display banner (non-fatal):', error);
  // Always exit 0 - banner display failure should not block session initialization
  process.exit(0);
}
