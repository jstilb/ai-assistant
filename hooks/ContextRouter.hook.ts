#!/usr/bin/env bun
/**
 * ContextRouter.hook.ts - Dynamic Context Loading (UserPromptSubmit)
 *
 * PURPOSE:
 * The core orchestrator for ContextManager. Classifies user intent on first
 * message, selects an appropriate context profile, and injects budget-aware
 * context as a <system-reminder>. On subsequent messages, detects topic
 * changes and loads delta context.
 *
 * TRIGGER: UserPromptSubmit (FIRST in the hook chain)
 *
 * INPUT:
 * - stdin: JSON with session_id, prompt/user_prompt
 * - settings.json: contextManager.enabled flag
 *
 * OUTPUT:
 * - stdout: <system-reminder> with profile-selected context files
 * - stderr: Classification and loading diagnostics
 * - exit(0): Always (non-blocking)
 *
 * FEATURE FLAG:
 * - contextManager.enabled: true     → Dynamic profile loading active
 * - contextManager.enabled: "shadow" → Classification runs, logs to stderr, no stdout output
 * - contextManager.enabled: false    → Hook exits immediately (default)
 *
 * DESIGN:
 * - First message: Full classification → profile → budget-aware file loading
 * - Subsequent messages: Keyword-only topic-change detection → delta loading
 * - SessionStart fires BEFORE first message, so intent detection happens here
 *
 * INTER-HOOK RELATIONSHIPS:
 * - MUST RUN BEFORE: FormatEnforcer, AutoWorkCreation
 * - DEPENDS ON: LoadContext (boot context already loaded at SessionStart)
 * - COORDINATES WITH: AutoWorkCreation (shares classification state)
 *
 * ERROR HANDLING:
 * - All errors fail-open: Hook NEVER blocks user prompt processing
 * - Classification failure: Falls back to 'general' profile
 * - File loading failure: Skips failed files, loads what it can
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getKayaDir } from './lib/paths';
import { classifyIntent, detectTopicChange } from '../skills/ContextManager/Tools/IntentClassifier';
import { selectContext, type ContextSelection } from '../skills/ContextManager/Tools/ContextSelector';
import { checkFreshness } from '../skills/ContextManager/Tools/FreshnessChecker';
import {
  getSessionState,
  resetSessionState,
  recordLoadedFile,
  setProfile,
  type SessionState,
} from '../skills/ContextManager/Tools/ContextManagerState';

interface HookInput {
  session_id: string;
  prompt?: string;
  user_prompt?: string;
}

interface Settings {
  contextManager?: {
    enabled?: boolean | 'shadow';
  };
  [key: string]: unknown;
}

type ContextMode = 'enabled' | 'shadow' | 'disabled';

const kayaDir = getKayaDir();

/**
 * Read stdin with timeout (same pattern as AutoWorkCreation)
 */
async function readStdinWithTimeout(timeout: number = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => reject(new Error('Timeout')), timeout);
    process.stdin.on('data', (chunk) => { data += chunk.toString(); });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Check ContextManager mode
 */
function getMode(): ContextMode {
  const settingsPath = join(kayaDir, 'settings.json');
  if (!existsSync(settingsPath)) return 'disabled';

  try {
    const settings: Settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const val = settings.contextManager?.enabled;
    if (val === 'shadow') return 'shadow';
    if (val === true) return 'enabled';
    return 'disabled';
  } catch {
    return 'disabled';
  }
}

/**
 * Format selected context as system-reminder output
 */
function formatContextOutput(selection: ContextSelection, sessionState: SessionState): string {
  if (selection.files.length === 0) return '';

  let output = `<system-reminder>\n`;
  output += `## Dynamic Context (Profile: ${selection.profile}, ${selection.totalTokens}/${selection.tokenBudget} tokens)\n\n`;

  for (const file of selection.files) {
    // Check freshness
    const freshness = checkFreshness(file.absolutePath);
    const freshnessNote = freshness.category === 'outdated'
      ? ` ⚠️ OUTDATED (${Math.round(freshness.ageHours)}h old - consider running \`refresh\`)`
      : freshness.category === 'stale'
      ? ` ⚠️ Stale (${Math.round(freshness.ageHours)}h old)`
      : '';

    output += `### ${file.path}${file.compressed ? ' (compressed)' : ''}${freshnessNote}\n\n`;
    output += file.content;
    output += '\n\n---\n\n';
  }

  if (selection.skippedFiles.length > 0) {
    output += `_Skipped: ${selection.skippedFiles.map(s => `${s.path} (${s.reason})`).join(', ')}_\n\n`;
  }

  output += `_Context loaded via ContextManager. Profile: ${selection.profile}. Use \`bun skills/ContextManager/Tools/ContextLoadTool.ts load <profile>\` to load additional context._\n`;
  output += `</system-reminder>`;

  return output;
}

/**
 * Handle first message in session - full classification + loading
 */
async function handleFirstMessage(prompt: string, sessionId: string, mode: ContextMode): Promise<void> {
  const modeTag = mode === 'shadow' ? '[SHADOW] ' : '';
  console.error(`[ContextRouter] ${modeTag}First message - running full classification...`);

  // Reset session state for new session
  await resetSessionState(sessionId);

  // Classify intent
  const classification = await classifyIntent(prompt, false);
  console.error(`[ContextRouter] ${modeTag}Classified as: ${classification.profile} (${classification.stage}, confidence: ${classification.confidence.toFixed(2)})`);

  // Skip file loading for boot/conversational profiles
  if (classification.profile === 'boot' || classification.profile === 'conversational') {
    console.error(`[ContextRouter] ${modeTag}Conversational/boot profile - no additional context needed`);
    await setProfile(classification.profile, 200, {
      profile: classification.profile,
      confidence: classification.confidence,
      stage: classification.stage,
      reasoning: classification.reasoning,
      timestamp: classification.timestamp,
    });
    return;
  }

  // Select and load context
  const selection = selectContext(classification.profile);
  console.error(`[ContextRouter] ${modeTag}Selected ${selection.files.length} files, ${selection.totalTokens}/${selection.tokenBudget} tokens`);

  if (mode === 'shadow') {
    // Shadow mode: log what WOULD be loaded, but don't output to stdout
    for (const file of selection.files) {
      console.error(`[ContextRouter] [SHADOW] Would load: ${file.path} (${file.tokens}t, ${file.compressed ? 'compressed' : 'full'})`);
    }
    for (const skipped of selection.skippedFiles) {
      console.error(`[ContextRouter] [SHADOW] Would skip: ${skipped.path} (${skipped.reason})`);
    }
    // Still update state for tracking
    await setProfile(classification.profile, selection.tokenBudget, {
      profile: classification.profile,
      confidence: classification.confidence,
      stage: classification.stage,
      reasoning: classification.reasoning,
      timestamp: classification.timestamp,
    });
    return;
  }

  // Update state
  await setProfile(classification.profile, selection.tokenBudget, {
    profile: classification.profile,
    confidence: classification.confidence,
    stage: classification.stage,
    reasoning: classification.reasoning,
    timestamp: classification.timestamp,
  });

  // Record loaded files in state
  for (const file of selection.files) {
    await recordLoadedFile({
      path: file.path,
      tokens: file.tokens,
      compressed: file.compressed,
      loadedAt: new Date().toISOString(),
      tier: 'profile',
    });
  }

  // Output context to stdout
  const state = await getSessionState();
  const output = formatContextOutput(selection, state);
  if (output) {
    console.log(output);
  }
}

/**
 * Handle subsequent messages - lightweight topic change detection
 */
async function handleSubsequentMessage(prompt: string, currentState: SessionState): Promise<void> {
  const change = detectTopicChange(prompt, currentState.currentProfile);

  if (!change.changed) {
    console.error(`[ContextRouter] Continuing with profile: ${currentState.currentProfile}`);
    return;
  }

  console.error(`[ContextRouter] Topic change detected: ${currentState.currentProfile} → ${change.newProfile}`);

  // Load delta context for new profile
  const selection = selectContext(change.newProfile!);

  // Filter out already-loaded files
  const alreadyLoaded = new Set(currentState.loadedFiles.map(f => f.path));
  const newFiles = selection.files.filter(f => !alreadyLoaded.has(f.path));

  if (newFiles.length === 0) {
    console.error('[ContextRouter] No new files needed for topic change');
    return;
  }

  // Update state
  await setProfile(change.newProfile!, selection.tokenBudget, {
    profile: change.newProfile!,
    confidence: change.confidence!,
    stage: 'keyword',
    reasoning: 'Topic change detected mid-session',
    timestamp: new Date().toISOString(),
  });

  for (const file of newFiles) {
    await recordLoadedFile({
      path: file.path,
      tokens: file.tokens,
      compressed: file.compressed,
      loadedAt: new Date().toISOString(),
      tier: 'on-demand',
    });
  }

  // Output delta context
  const deltaSelection: ContextSelection = {
    ...selection,
    files: newFiles,
    totalTokens: newFiles.reduce((sum, f) => sum + f.tokens, 0),
  };

  const state = await getSessionState();
  const output = formatContextOutput(deltaSelection, state);
  if (output) {
    console.log(output);
  }

  console.error(`[ContextRouter] Delta loaded: ${newFiles.length} new files`);
}

async function main() {
  try {
    // Check if this is a subagent session
    const claudeProjectDir = process.env.CLAUDE_PROJECT_DIR || '';
    const isSubagent = claudeProjectDir.includes('/.claude/Agents/') ||
                      process.env.CLAUDE_AGENT_TYPE !== undefined;

    if (isSubagent) {
      process.exit(0);
    }

    // Check feature flag
    const mode = getMode();
    if (mode === 'disabled') {
      process.exit(0);
    }

    // Read stdin
    const input = await readStdinWithTimeout();
    const data: HookInput = JSON.parse(input);
    const prompt = data.prompt || data.user_prompt || '';
    const sessionId = data.session_id || 'unknown';

    if (!prompt || prompt.length < 2) {
      process.exit(0);
    }

    // Check if this is first message or subsequent
    const currentState = await getSessionState();
    const isFirstMessage = !currentState.sessionId || currentState.sessionId !== sessionId;

    if (isFirstMessage) {
      await handleFirstMessage(prompt, sessionId, mode);
    } else {
      if (mode === 'shadow') {
        // Shadow: log topic change detection but don't inject
        const change = detectTopicChange(prompt, currentState.currentProfile);
        if (change.changed) {
          console.error(`[ContextRouter] [SHADOW] Topic change detected: ${currentState.currentProfile} → ${change.newProfile}`);
        }
      } else {
        await handleSubsequentMessage(prompt, currentState);
      }
    }

    process.exit(0);
  } catch (err) {
    console.error(`[ContextRouter] Error (non-fatal): ${err}`);
    process.exit(0); // Never block
  }
}

main();
