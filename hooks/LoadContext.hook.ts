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
 * - Files: skills/CORE/SKILL.md, skills/CORE/SYSTEM/AISTEERINGRULES.md,
 *          skills/CORE/USER/AISTEERINGRULES.md, MEMORY/STATE/progress/*.json
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
import { join, basename } from 'path';
import { execSync } from 'child_process';
import { getKayaDir } from './lib/paths';
import { recordSessionStart } from './lib/notifications';

/**
 * Queue summary functionality (integrated from QueueSummary.hook.ts)
 * Embedded here because Claude Code drops output from later hooks in the array
 */
interface QueueItem {
  id: string;
  created: string;
  status: string;
  priority: 1 | 2 | 3;
  type: string;
  queue: string;
  payload: { title: string; description?: string };
}

function loadQueueItems(filePath: string): QueueItem[] {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    return content.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) as QueueItem; } catch { return null; }
    }).filter((item): item is QueueItem => item !== null);
  } catch { return []; }
}

function formatTimeSince(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

/**
 * Check if TOON queue encoding is enabled in settings.json
 */
function isToonQueuesEnabled(kayaDir: string): boolean {
  try {
    const settingsPath = join(kayaDir, 'settings.json');
    if (!existsSync(settingsPath)) return false;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return settings?.toon?.enableInQueues === true;
  } catch {
    return false;
  }
}

/**
 * Format queue items as TOON when they form uniform arrays (Phase 3c).
 *
 * Extracts a flat representation of each item suitable for tabular TOON encoding:
 *   id_short, title, status, priority, queue, created_ago
 *
 * Returns TOON-encoded string if items are present, empty string if empty.
 * This is a pure function -- the caller gates behind toon.enableInQueues.
 *
 * @param items - Array of QueueItem objects
 * @returns TOON-formatted string, or empty string for empty arrays
 */
export function formatQueueItemsAsToon(items: QueueItem[]): string {
  if (items.length === 0) return '';

  // Flatten items into a uniform structure for TOON
  const flatItems = items.map(item => ({
    id: item.id.slice(0, 8),
    title: item.payload.title,
    status: item.status,
    priority: item.priority,
    queue: item.queue,
    age: formatTimeSince(item.created),
  }));

  try {
    // Lazy import ToonHelper
    const kayaDir = getKayaDir();
    const { maybeEncode } = require(join(kayaDir, "skills/CORE/Tools/ToonHelper")) as typeof import("../skills/CORE/Tools/ToonHelper");
    const result = maybeEncode(flatItems);
    if (result.format === 'toon') {
      return `<toon-data format="queue-items">\n${result.data}\n</toon-data>`;
    }
  } catch {
    // Fall through to markdown format
  }

  // Fallback: markdown bullet list
  return flatItems.map(item =>
    `   - [${item.id}] ${item.title} (${item.status}, P${item.priority}, ${item.age})`
  ).join('\n');
}

function getQueueSummary(kayaDir: string): string | null {
  const queuesDir = join(kayaDir, 'MEMORY', 'QUEUES');
  if (!existsSync(queuesDir)) return null;

  const stats = { total: 0, pending: 0, awaitingApproval: 0, inProgress: 0, byQueue: {} as Record<string, number>, approvalItems: [] as QueueItem[], highPriority: [] as QueueItem[] };

  try {
    const files = readdirSync(queuesDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const queueName = basename(file, '.jsonl');
      const items = loadQueueItems(join(queuesDir, file));
      const activeItems = items.filter(i => ['pending', 'in_progress', 'awaiting_approval'].includes(i.status));
      if (activeItems.length === 0) continue;
      stats.byQueue[queueName] = activeItems.length;
      stats.total += activeItems.length;
      for (const item of activeItems) {
        if (item.status === 'pending') stats.pending++;
        else if (item.status === 'in_progress') stats.inProgress++;
        else if (item.status === 'awaiting_approval') { stats.awaitingApproval++; stats.approvalItems.push(item); }
        if (item.priority === 1 && item.status !== 'awaiting_approval') stats.highPriority.push(item);
      }
    }
  } catch { return null; }

  if (stats.total === 0) return null;

  const useToon = isToonQueuesEnabled(kayaDir);
  let output = '\n📋 QUEUE SUMMARY:\n';
  if (stats.awaitingApproval > 0) {
    output += `\n⚠️  AWAITING APPROVAL (${stats.awaitingApproval}):\n`;
    if (useToon) {
      output += formatQueueItemsAsToon(stats.approvalItems.slice(0, 5)) + '\n';
    } else {
      for (const item of stats.approvalItems.slice(0, 5)) {
        output += `   • [${item.id.slice(0, 8)}] ${item.payload.title} (${formatTimeSince(item.created)})\n`;
      }
    }
  }
  if (stats.highPriority.length > 0) {
    output += `\n🔴 HIGH PRIORITY (${stats.highPriority.length}):\n`;
    if (useToon) {
      output += formatQueueItemsAsToon(stats.highPriority.slice(0, 3)) + '\n';
    } else {
      for (const item of stats.highPriority.slice(0, 3)) {
        output += `   • [${item.queue}] ${item.payload.title}\n`;
      }
    }
  }
  output += `\n📊 BY QUEUE:\n`;
  for (const [queue, count] of Object.entries(stats.byQueue)) {
    output += `   ${queue === 'approvals' ? '⚠️ ' : '   '}${queue}: ${count}\n`;
  }
  output += `\n   Total: ${stats.total} items (${stats.pending} pending, ${stats.inProgress} in progress, ${stats.awaitingApproval} awaiting approval)\n`;
  output += '\n💡 Commands: /queue list, /queue approve <id>, /queue work\n';
  return output;
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
    'skills/CORE/SKILL.md',
    'skills/CORE/SYSTEM/AISTEERINGRULES.md',
    'skills/CORE/USER/AISTEERINGRULES.md'
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

    summary += '\n💡 To resume: `bun run ~/.claude/skills/CORE/Tools/SessionProgress.ts resume <project>`\n';
    summary += '💡 To complete: `bun run ~/.claude/skills/CORE/Tools/SessionProgress.ts complete <project>`\n';

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
      message = `<system-reminder>\n📅 CURRENT DATE/TIME: ${currentDate}\n</system-reminder>`;
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

    // Output queue summary (embedded here because separate hook output gets dropped)
    const queueSummary = getQueueSummary(kayaDir);
    if (queueSummary) {
      console.log(`<system-reminder>${queueSummary}</system-reminder>`);
      console.error('📋 Queue summary loaded');
    }

    // Auto-cleanup stale queue items (debounced, ~0ms if recent)
    try {
      const { QueueManager } = require(join(kayaDir, "skills/QueueRouter/Tools/QueueManager"));
      const qm = new QueueManager();
      const cleanupResult = await qm.maybeCleanup();
      if (cleanupResult && cleanupResult.archived > 0) {
        console.error(`🧹 Auto-cleanup: archived ${cleanupResult.archived} stale queue items`);
      }
    } catch {}

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
