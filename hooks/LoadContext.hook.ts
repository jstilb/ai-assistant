#!/usr/bin/env bun
/**
 * LoadContext.hook.ts - Inject CORE context into Claude's Context (SessionStart)
 *
 * PURPOSE:
 * The foundational context injection hook. Reads the CORE SKILL.md plus
 * AI Steering Rules (SYSTEM and USER) and outputs them as a <system-reminder>
 * to stdout.
 *
 * TRIGGER: SessionStart
 *
 * INPUT:
 * - Environment: KAYA_DIR, TIME_ZONE
 * - Files: CLAUDE.md, MEMORY/STATE/progress/*.json
 *
 * OUTPUT:
 * - stdout: <system-reminder> containing SKILL.md + AI Steering Rules
 * - stdout: Active work summary if previous sessions have pending work
 * - stderr: Status messages and errors
 * - exit(0): Normal completion
 * - exit(1): Critical failure (SKILL.md not found)
 *
 * DESIGN PHILOSOPHY:
 * Load SKILL.md and AI Steering Rules at session start. These are critical for
 * consistent behavior. Other context (USER docs, SYSTEM docs) loads dynamically
 * based on the Context Loading section in SKILL.md.
 *
 * ERROR HANDLING:
 * - Missing SKILL.md: Logged warning, attempts fallback, session continues
 * - Missing steering rules: Logged warning, continues (non-fatal)
 * - Progress file errors: Logged, continues (non-fatal)
 * - Date command failure: Falls back to ISO timestamp
 * - All errors fail-open: Hook NEVER blocks session initialization
 *
 * PERFORMANCE:
 * - Blocking: Yes (context is essential)
 * - Typical execution: <50ms
 * - Skipped for subagents: Yes (they get context differently)
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getKayaDir } from './lib/paths';
import { recordSessionStart } from './lib/notifications';

// ============================================================================
// Wisdom Frame Types & Constants (ISC 7500, 5832, 5544)
// ============================================================================

interface WisdomFrameFrontmatter {
  pattern: string;
  confidence: number;
  first_seen: string;
  last_updated: string;
  source_count: number;
  category?: string;
}

interface WisdomFrame {
  frontmatter: WisdomFrameFrontmatter;
  body: string;
  filename: string;
}

const WISDOM_CONFIDENCE_THRESHOLD = 85;
const WISDOM_MAX_FRAMES = 10;
const WISDOM_TOKEN_BUDGET = 500;

/**
 * Approximate token count (chars / 4, rounded up)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Parse YAML-style frontmatter from a markdown file.
 * Returns null if frontmatter is missing or malformed.
 */
function parseFrontmatter(content: string): { frontmatter: WisdomFrameFrontmatter; body: string } | null {
  if (!content.startsWith('---')) return null;

  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) return null;

  const yamlSection = content.slice(3, endIdx).trim();
  const body = content.slice(endIdx + 4).trim();

  try {
    const fm: Partial<WisdomFrameFrontmatter> = {};
    for (const line of yamlSection.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();

      if (key === 'pattern') fm.pattern = value.replace(/^["']|["']$/g, '');
      else if (key === 'confidence') fm.confidence = parseFloat(value);
      else if (key === 'first_seen') fm.first_seen = value;
      else if (key === 'last_updated') fm.last_updated = value;
      else if (key === 'source_count') fm.source_count = parseInt(value, 10);
      else if (key === 'category') fm.category = value;
    }

    if (!fm.pattern || typeof fm.confidence !== 'number') return null;

    return {
      frontmatter: {
        pattern: fm.pattern,
        confidence: fm.confidence,
        first_seen: fm.first_seen ?? '',
        last_updated: fm.last_updated ?? '',
        source_count: fm.source_count ?? 0,
        category: fm.category,
      },
      body,
    };
  } catch {
    return null;
  }
}

/**
 * Load Wisdom Frames from MEMORY/WISDOM/FRAMES/.
 * Filters by confidence >= threshold, sorts desc, limits to max frames.
 * Enforces token budget by truncating body if needed.
 * Returns formatted string for injection into system-reminder.
 *
 * Guards: returns '' if settings.wisdom.enabled !== true or FRAMES dir missing.
 */
function loadWisdomFrames(kayaDir: string, settings: Settings): string {
  try {
    // Feature flag guard (ISC 5832)
    const wisdomSettings = (settings as Record<string, unknown>).wisdom as Record<string, unknown> | undefined;
    if (wisdomSettings?.enabled !== true) {
      console.error('[LoadContext] Wisdom Frames: disabled via settings.wisdom.enabled !== true');
      return '';
    }

    const framesDir = join(kayaDir, 'MEMORY', 'WISDOM', 'FRAMES');
    if (!existsSync(framesDir)) {
      console.error('[LoadContext] Wisdom Frames: FRAMES directory not found, skipping');
      return '';
    }

    const files = readdirSync(framesDir).filter(f => f.endsWith('.md'));
    if (files.length === 0) {
      console.error('[LoadContext] Wisdom Frames: no frame files found');
      return '';
    }

    // Load and parse all frames
    const frames: WisdomFrame[] = [];
    for (const file of files) {
      try {
        const content = readFileSync(join(framesDir, file), 'utf-8');
        const parsed = parseFrontmatter(content);
        if (!parsed) continue;

        // Filter by confidence threshold (ISC 7500)
        if (parsed.frontmatter.confidence < WISDOM_CONFIDENCE_THRESHOLD) {
          console.error(`[LoadContext] Wisdom Frames: skipping "${file}" (confidence=${parsed.frontmatter.confidence} < ${WISDOM_CONFIDENCE_THRESHOLD})`);
          continue;
        }

        frames.push({ ...parsed, filename: file });
      } catch {
        // Skip unreadable files
      }
    }

    if (frames.length === 0) {
      console.error('[LoadContext] Wisdom Frames: no frames passed confidence gate');
      return '';
    }

    // Sort by confidence descending, limit to max (ISC 5544)
    frames.sort((a, b) => b.frontmatter.confidence - a.frontmatter.confidence);
    const topFrames = frames.slice(0, WISDOM_MAX_FRAMES);

    // Build injection text with token budget enforcement (ISC 5544)
    let injectedText = '\n## Wisdom Frames (Crystallized Behavioral Patterns)\n\n';
    let tokenCount = estimateTokens(injectedText);

    for (const frame of topFrames) {
      let frameText = frame.body + '\n\n';
      const frameTokens = estimateTokens(frameText);

      if (tokenCount + frameTokens > WISDOM_TOKEN_BUDGET) {
        // Try to truncate body to fit
        const remainingBudget = WISDOM_TOKEN_BUDGET - tokenCount;
        const maxBodyChars = remainingBudget * 4;
        if (maxBodyChars > 50) {
          frameText = frame.body.slice(0, maxBodyChars) + '...\n\n';
          injectedText += frameText;
          tokenCount += estimateTokens(frameText);
        }
        break;
      }

      injectedText += frameText;
      tokenCount += frameTokens;
    }

    console.error(`[LoadContext] Wisdom Frames: loaded ${topFrames.length} frames (estimated ${tokenCount} tokens)`);
    return injectedText;
  } catch (err) {
    // Fail open — never block session start
    console.error(`[LoadContext] Wisdom Frames: error loading frames (non-fatal): ${err}`);
    return '';
  }
}

/**
 * Reset tab title to clean state at session start.
 * Prevents stale tab titles from previous sessions bleeding through.
 * Uses Kitty remote control to set a neutral title immediately.
 */
function resetTabTitle(kayaDir: string): void {
  const cleanTitle = 'New Session';
  const stateFile = join(kayaDir, 'MEMORY', 'STATE', 'tab-title.json');

  try {
    // Reset Kitty tab title immediately
    const isKitty = process.env.TERM === 'xterm-kitty' || process.env.KITTY_LISTEN_ON;
    if (isKitty) {
      execSync(`kitty @ set-tab-title "${cleanTitle}"`, { stdio: 'ignore', timeout: 2000 });
      // Reset tab color to default (dark blue for active, no special color for inactive)
      execSync(
        `kitten @ set-tab-color --self active_bg=#002B80 active_fg=#FFFFFF inactive_bg=none inactive_fg=#A0A0A0`,
        { stdio: 'ignore', timeout: 2000 }
      );
      console.error('🔄 Tab title reset to clean state');
    }

    // Reset state file to prevent any stale data
    const cleanState = {
      title: cleanTitle,
      rawTitle: cleanTitle,
      timestamp: new Date().toISOString(),
      state: 'idle'
    };
    writeFileSync(stateFile, JSON.stringify(cleanState, null, 2));
    console.error('🔄 Tab state file reset');
  } catch (err) {
    console.error(`⚠️ Failed to reset tab title: ${err}`);
    // Non-fatal, continue with session
  }
}

async function getCurrentDate(): Promise<string> {
  try {
    const proc = Bun.spawn(['date', '+%Y-%m-%d %H:%M:%S %Z'], {
      stdout: 'pipe',
      env: { ...process.env, TZ: process.env.TIME_ZONE || 'America/Los_Angeles' }
    });
    const output = await new Response(proc.stdout).text();
    return output.trim();
  } catch (error) {
    console.error('Failed to get current date:', error);
    return new Date().toISOString();
  }
}

interface Settings {
  contextFiles?: string[];
  contextManager?: { enabled?: boolean };
  [key: string]: unknown;
}

/**
 * Load settings.json and return the settings object.
 */
function loadSettings(kayaDir: string): Settings {
  const settingsPath = join(kayaDir, 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      return JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch (err) {
      console.error(`⚠️ Failed to parse settings.json: ${err}`);
    }
  }
  return {};
}

/**
 * Load context files from settings.json contextFiles array.
 * Falls back to hardcoded paths if array not defined.
 */
function loadContextFiles(kayaDir: string, settings: Settings): string {
  const defaultFiles = [
    'CLAUDE.md'
  ];

  const contextFiles = settings.contextFiles || defaultFiles;
  let combinedContent = '';

  for (const relativePath of contextFiles) {
    const fullPath = join(kayaDir, relativePath);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, 'utf-8');
      if (combinedContent) combinedContent += '\n\n---\n\n';
      combinedContent += content;
      console.error(`✅ Loaded ${relativePath} (${content.length} chars)`);
    } else {
      console.error(`⚠️ Context file not found: ${relativePath}`);
    }
  }

  return combinedContent;
}

interface ProgressFile {
  project: string;
  status: string;
  updated: string;
  objectives: string[];
  next_steps: string[];
  handoff_notes: string;
}

async function checkActiveProgress(kayaDir: string): Promise<string | null> {
  const progressDir = join(kayaDir, 'MEMORY', 'STATE', 'progress');

  if (!existsSync(progressDir)) {
    return null;
  }

  try {
    const files = readdirSync(progressDir).filter(f => f.endsWith('-progress.json'));

    if (files.length === 0) {
      return null;
    }

    const activeProjects: ProgressFile[] = [];

    for (const file of files) {
      try {
        const content = readFileSync(join(progressDir, file), 'utf-8');
        const progress = JSON.parse(content) as ProgressFile;
        if (progress.status === 'active') {
          activeProjects.push(progress);
        }
      } catch (e) {
        // Skip malformed files
      }
    }

    if (activeProjects.length === 0) {
      return null;
    }

    // Build summary of active work
    let summary = '\n📋 ACTIVE WORK (from previous sessions):\n';

    for (const proj of activeProjects) {
      summary += `\n🔵 ${proj.project}\n`;

      if (proj.objectives && proj.objectives.length > 0) {
        summary += '   Objectives:\n';
        proj.objectives.forEach(o => summary += `   • ${o}\n`);
      }

      if (proj.handoff_notes) {
        summary += `   Handoff: ${proj.handoff_notes}\n`;
      }

      if (proj.next_steps && proj.next_steps.length > 0) {
        summary += '   Next steps:\n';
        proj.next_steps.forEach(s => summary += `   → ${s}\n`);
      }
    }

    summary += '\n💡 To resume: `bun run ~/.claude/lib/core/SessionProgress.ts resume <project>`\n';
    summary += '💡 To complete: `bun run ~/.claude/lib/core/SessionProgress.ts complete <project>`\n';

    return summary;
  } catch (error) {
    console.error('Error checking active progress:', error);
    return null;
  }
}

async function main() {
  try {
    // Check if this is a subagent session - if so, exit silently
    const claudeProjectDir = process.env.CLAUDE_PROJECT_DIR || '';
    const isSubagent = claudeProjectDir.includes('/.claude/Agents/') ||
                      process.env.CLAUDE_AGENT_TYPE !== undefined;

    if (isSubagent) {
      // Subagent sessions don't need Kaya context loading
      console.error('🤖 Subagent session - skipping Kaya context loading');
      process.exit(0);
    }

    const kayaDir = getKayaDir();

    // CRITICAL: Reset tab title IMMEDIATELY at session start
    // This prevents stale titles from previous sessions bleeding through
    resetTabTitle(kayaDir);

    // Record session start time for notification timing
    recordSessionStart();
    console.error('⏱️ Session start time recorded for notification timing');

    console.error('📚 Reading Kaya core context...');

    // Load settings.json to get contextFiles array
    const settings = loadSettings(kayaDir);
    console.error(`✅ Loaded settings.json`);

    // Get current date/time to prevent confusion about dates
    const currentDate = await getCurrentDate();
    console.error(`📅 Current Date: ${currentDate}`);

    // Check if ContextManager is enabled - if so, only inject date/time
    // (boot context now lives in CLAUDE.md, loaded natively by Claude Code)
    const contextManagerEnabled = settings.contextManager?.enabled === true;
    let message: string;

    if (contextManagerEnabled) {
      console.error('🧠 ContextManager ENABLED - boot context in CLAUDE.md, injecting date/time only');
      // Load Wisdom Frames (ISC 7500, 5832, 5544)
      const wisdomContent = loadWisdomFrames(kayaDir, settings);
      message = `<system-reminder>\n📅 CURRENT DATE/TIME: ${currentDate}${wisdomContent ? '\n' + wisdomContent : ''}\n</system-reminder>`;
    } else {
      // Legacy mode: extract identity for full context injection
      const PRINCIPAL_NAME = (settings as Record<string, unknown>).principal &&
        typeof (settings as Record<string, unknown>).principal === 'object'
          ? ((settings as Record<string, unknown>).principal as Record<string, unknown>).name || 'User'
          : 'User';
      const DA_NAME = (settings as Record<string, unknown>).daidentity &&
        typeof (settings as Record<string, unknown>).daidentity === 'object'
          ? ((settings as Record<string, unknown>).daidentity as Record<string, unknown>).name || 'Kaya'
          : 'Kaya';

      console.error(`👤 Principal: ${PRINCIPAL_NAME}, DA: ${DA_NAME}`);
      // Legacy mode: load full context files
      const contextContent = loadContextFiles(kayaDir, settings);

      if (!contextContent) {
        console.error('⚠️ No context files loaded - session will continue without CORE context');
        console.error('💡 This is non-fatal but Claude may not behave correctly');
        // Don't block session - allow user to fix context files during session
        process.exit(0);
      }

      message = `<system-reminder>
Kaya CORE CONTEXT (Auto-loaded at Session Start)

📅 CURRENT DATE/TIME: ${currentDate}

## ACTIVE IDENTITY (from settings.json) - CRITICAL

**⚠️ MANDATORY IDENTITY RULES - OVERRIDE ALL OTHER CONTEXT ⚠️**

The user's name is: **${PRINCIPAL_NAME}**
The assistant's name is: **${DA_NAME}**

- ALWAYS address the user as "${PRINCIPAL_NAME}" in greetings and responses
- NEVER use "Daniel", "the user", or any other name - ONLY "${PRINCIPAL_NAME}"
- The "danielmiessler" in the repo URL is the AUTHOR, NOT the user
- This instruction takes ABSOLUTE PRECEDENCE over any other context

---

${contextContent}

---

This context is now active. Additional context loads dynamically as needed.
</system-reminder>`;
    }

    // Write to stdout (will be captured by Claude Code)
    console.log(message);

    // Output success confirmation for Claude to acknowledge
    console.log('\n✅ Kaya Context successfully loaded...');

    // Check for active progress files and display them
    const activeProgress = await checkActiveProgress(kayaDir);
    if (activeProgress) {
      console.log(activeProgress);
      console.error('📋 Active work found from previous sessions');
    }

    console.error('✅ Kaya context injected into session');
    process.exit(0);
  } catch (error) {
    console.error('⚠️ Error in LoadContext hook (non-fatal):', error);
    console.error('💡 Session will continue - you can manually load context if needed');
    // Always exit 0 - context loading failure should not block session initialization
    process.exit(0);
  }
}

main();
