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
 * Look up session ratings from ratings.jsonl and compute average
 */
function getSessionRating(sessionId: string): number | undefined {
  const ratingsPath = join(kayaDir, 'MEMORY', 'LEARNING', 'SIGNALS', 'ratings.jsonl');
  if (!existsSync(ratingsPath)) return undefined;

  const lines = readFileSync(ratingsPath, 'utf-8').trim().split('\n');
  const sessionRatings: number[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const id = entry.session_id || entry.sessionId;
      if (id === sessionId && typeof entry.rating === 'number') {
        sessionRatings.push(entry.rating);
      }
    } catch { /* skip malformed */ }
  }

  if (sessionRatings.length === 0) return undefined;
  return sessionRatings.reduce((a, b) => a + b, 0) / sessionRatings.length;
}

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

    // Calculate session duration and rating from state
    let durationMinutes: number | undefined;
    let rating: number | undefined;
    try {
      const state = await getSessionState();
      if (state.sessionStarted) {
        const started = new Date(state.sessionStarted).getTime();
        const now = Date.now();
        durationMinutes = Math.round((now - started) / 60000);
      }
      if (state.sessionId) {
        rating = getSessionRating(state.sessionId);
      }
    } catch {
      // Non-fatal — duration and rating are optional
    }

    // Capture feedback (appends to JSONL)
    const feedback = await captureSessionFeedback({ durationMinutes, rating });

    if (feedback) {
      console.error(`[ContextFeedback] Captured: profile=${feedback.profile}, confidence=${feedback.classificationConfidence}, tokens=${feedback.totalTokensUsed}/${feedback.tokenBudget}, rating=${feedback.sessionRating ?? 'none'}`);
    } else {
      console.error('[ContextFeedback] No session state to capture (no classification this session)');
    }

    // Pre-computed learner cache check (ISC 2496, 4104)
    // Replace the 50-session counter with 24h cache staleness check.
    // Read learning-cache.json; if fresh (< 24h), skip ContextLearner entirely.
    // If stale or missing, spawn ContextLearner --analyze --write-cache (fire-and-forget).
    try {
      // Check if learnerCache feature is enabled (defaults to true)
      const settingsPath = join(kayaDir, 'settings.json');
      let learnerCacheEnabled = true;
      if (existsSync(settingsPath)) {
        try {
          const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
          if (settings.learnerCache && settings.learnerCache.enabled === false) {
            learnerCacheEnabled = false;
          }
        } catch { /* non-fatal */ }
      }

      if (learnerCacheEnabled) {
        const cachePath = join(kayaDir, 'MEMORY', 'State', 'learning-cache.json');
        const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

        let cacheIsStale = true;

        if (existsSync(cachePath)) {
          try {
            const cacheData = JSON.parse(readFileSync(cachePath, 'utf-8'));
            // Must have _version field and computed_at (ISC 2496 staleness check)
            if (cacheData._version && cacheData.computed_at) {
              const computedAt = new Date(cacheData.computed_at).getTime();
              const ageMs = Date.now() - computedAt;
              if (ageMs < STALE_THRESHOLD_MS) {
                cacheIsStale = false;
                console.error(`[ContextFeedback] Cache hit — skipping ContextLearner (age: ${Math.round(ageMs / 60000)}m)`);
              } else {
                console.error(`[ContextFeedback] Cache stale (age: ${Math.round(ageMs / 3600000)}h) — spawning ContextLearner`);
              }
            } else {
              console.error('[ContextFeedback] Cache missing _version or computed_at — treating as stale');
            }
          } catch {
            console.error('[ContextFeedback] Cache corrupted — treating as stale, triggering recompute');
          }
        } else {
          console.error('[ContextFeedback] learning-cache.json missing — triggering background recompute');
        }

        if (cacheIsStale) {
          // Fire-and-forget: spawn ContextLearner in background (ISC 4104: hook still exits fast)
          Bun.spawn(
            ['bun', join(kayaDir, 'skills/ContextManager/Tools/ContextLearner.ts'), '--analyze', '--write-cache'],
            { stdout: 'ignore', stderr: 'ignore' }
          );
        }
      } else {
        // Fallback: every-50-sessions legacy behavior when cache disabled
        const feedbackPath = join(kayaDir, 'MEMORY', 'LEARNING', 'SIGNALS', 'context-feedback.jsonl');
        if (existsSync(feedbackPath)) {
          const lineCount = readFileSync(feedbackPath, 'utf-8').split('\n').filter(Boolean).length;
          const learningsPath = join(kayaDir, 'MEMORY', 'State', 'context-learnings.json');
          const lastAnalyzedAt = existsSync(learningsPath)
            ? (JSON.parse(readFileSync(learningsPath, 'utf-8')).totalSessionsAnalyzed ?? 0)
            : 0;
          const sessionsSinceLastAnalysis = lineCount - lastAnalyzedAt;
          if (sessionsSinceLastAnalysis >= 50) {
            console.error(`[ContextFeedback] ${sessionsSinceLastAnalysis} new sessions — spawning ContextLearner (legacy mode)`);
            Bun.spawn(['bun', join(kayaDir, 'skills/ContextManager/Tools/ContextLearner.ts'), '--analyze'], {
              stdout: 'ignore', stderr: 'ignore',
            });
          }
        }
      }
    } catch { /* non-fatal */ }

    process.exit(0);
  } catch (err) {
    console.error(`[ContextFeedback] Error (non-fatal): ${err}`);
    process.exit(0); // Never block
  }
}

main();
