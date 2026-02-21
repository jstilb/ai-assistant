#!/usr/bin/env bun
/**
 * ContextFeedback.hook.ts - Capture Context Effectiveness at SessionEnd
 *
 * PURPOSE:
 * Bridges ContextManager shadow/active mode to the feedback pipeline.
 * Calls captureSessionFeedback() to append classification data to
 * MEMORY/LEARNING/SIGNALS/context-feedback.jsonl before SessionSummary
 * clears session state.
 *
 * TRIGGER: SessionEnd (FIRST in the hook chain — before SessionSummary)
 *
 * INPUT:
 * - stdin: Hook input JSON (session_id, transcript_path)
 *
 * OUTPUT:
 * - stdout: None
 * - stderr: Status messages
 * - exit(0): Always (fail-open, non-blocking)
 *
 * FEATURE FLAG:
 * - contextManager.enabled: "shadow" or true → Capture feedback
 * - contextManager.enabled: false/missing    → Exit immediately
 *
 * INTER-HOOK RELATIONSHIPS:
 * - MUST RUN BEFORE: SessionSummary (captures before state is cleared)
 * - COORDINATES WITH: ContextRouter (reads state it wrote during session)
 * - NO DEPENDENCY ON: WorkValidator, WorkCompletionLearning
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getKayaDir } from './lib/paths';
import { captureSessionFeedback } from '../skills/ContextManager/Tools/FeedbackCollector';
import { getSessionState } from '../skills/ContextManager/Tools/ContextManagerState';

const kayaDir = getKayaDir();

/**
 * Check if ContextManager is enabled (shadow or full)
 */
function isContextManagerActive(): boolean {
  const settingsPath = join(kayaDir, 'settings.json');
  if (!existsSync(settingsPath)) return false;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const val = settings.contextManager?.enabled;
    return val === 'shadow' || val === true;
  } catch {
    return false;
  }
}

async function main() {
  try {
    // Read stdin (required for hook pattern)
    const input = await Bun.stdin.text();
    if (!input || input.trim() === '') {
      process.exit(0);
    }

    // Skip if ContextManager is disabled
    if (!isContextManagerActive()) {
      process.exit(0);
    }

    // Skip subagent sessions (same guard as ContextRouter)
    const claudeProjectDir = process.env.CLAUDE_PROJECT_DIR || '';
    const isSubagent = claudeProjectDir.includes('/.claude/Agents/') ||
                      process.env.CLAUDE_AGENT_TYPE !== undefined;

    if (isSubagent) {
      process.exit(0);
    }

    // Calculate session duration from state
    let durationMinutes: number | undefined;
    try {
      const state = await getSessionState();
      if (state.sessionStarted) {
        const started = new Date(state.sessionStarted).getTime();
        const now = Date.now();
        durationMinutes = Math.round((now - started) / 60000);
      }
    } catch {
      // Non-fatal — duration is optional
    }

    // Capture feedback (appends to JSONL)
    const feedback = await captureSessionFeedback({ durationMinutes });

    if (feedback) {
      console.error(`[ContextFeedback] Captured: profile=${feedback.profile}, confidence=${feedback.classificationConfidence}, tokens=${feedback.totalTokensUsed}/${feedback.tokenBudget}`);
    } else {
      console.error('[ContextFeedback] No session state to capture (no classification this session)');
    }

    process.exit(0);
  } catch (err) {
    console.error(`[ContextFeedback] Error (non-fatal): ${err}`);
    process.exit(0); // Never block
  }
}

main();
