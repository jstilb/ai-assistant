#!/usr/bin/env bun
/**
 * LoadContext.hook.ts - Session-start date/time stamp (SessionStart)
 *
 * PURPOSE:
 * Emits the current date/time as a <system-reminder> so the session never
 * guesses the date, plus a one-line "context loaded" banner. Boot context
 * (identity, rules) lives in CLAUDE.md and is loaded
 * natively by Claude Code; this hook does NOT read SKILL.md, steering rules,
 * or CLAUDE.md. (The per-prompt ContextManager injection was removed.)
 *
 * TRIGGER: SessionStart (skipped for subagent sessions)
 *
 * INPUT:
 * - Environment: KAYA_DIR, TIME_ZONE, CLAUDE_PROJECT_DIR / CLAUDE_AGENT_TYPE
 *   (subagent detection)
 * - Files: MEMORY/State/progress/*-progress.json (optional — written by
 *   lib/core/SessionProgress.ts; the directory does not exist until a
 *   progress file is first saved, so this block is normally silent)
 *
 * OUTPUT:
 * - stdout: <system-reminder> with the current date/time
 * - stdout: "✅ Kaya Context successfully loaded..." banner line
 * - stdout: "ACTIVE WORK" summary only if a progress file has status "active"
 * - stderr: Status messages and errors
 * - exit(0): Always — every error path fails open so the session still starts
 *
 * ERROR HANDLING:
 * - Progress file errors: Logged, continues (non-fatal)
 * - Date command failure: Falls back to ISO timestamp
 * - All errors fail-open: Hook NEVER blocks session initialization
 *
 * PERFORMANCE:
 * - Blocking: Yes (SessionStart)
 * - Typical execution: <50ms
 * - Skipped for subagents: Yes
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { getKayaDir } from './lib/paths';
import { toToon } from '../lib/core/ToonHelper';

/**
 * Format queue items as TOON (Token-Oriented Object Notation) for token-efficient
 * queue summary injection. Returns empty string for empty arrays.
 *
 * @param items - Array of queue item objects to encode
 * @returns TOON-formatted string, or "" if items is empty
 */
export function formatQueueItemsAsToon(items: unknown[]): string {
  if (items.length === 0) return '';
  return toToon(items);
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

interface ProgressFile {
  project: string;
  status: string;
  updated: string;
  objectives: string[];
  next_steps: string[];
  handoff_notes: string;
}

async function checkActiveProgress(kayaDir: string): Promise<string | null> {
  const progressDir = join(kayaDir, 'MEMORY', 'State', 'progress');

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
        console.error(`[LoadContext] malformed progress file skipped (${file}): ${e instanceof Error ? e.message : String(e)}`);
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

    // Get current date/time to prevent confusion about dates
    const currentDate = await getCurrentDate();
    console.error(`📅 Current Date: ${currentDate}`);

    // Boot context (identity, rules) lives in CLAUDE.md and is
    // loaded natively by Claude Code on every session. ContextManager (per-prompt
    // injection) was removed, so this hook only injects the current date/time.
    const message = `<system-reminder>\n📅 CURRENT DATE/TIME: ${currentDate}\n</system-reminder>`;

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

if (import.meta.main) {
  main();
}
