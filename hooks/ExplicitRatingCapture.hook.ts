#!/usr/bin/env bun
/**
 * ExplicitRatingCapture.hook.ts - Capture Explicit User Ratings (UserPromptSubmit)
 *
 * PURPOSE:
 * Detects when the user explicitly rates a response with a number 1-10.
 * This is the primary feedback mechanism for the rating/sentiment system.
 * Low ratings trigger automatic learning capture for improvement analysis.
 *
 * TRIGGER: UserPromptSubmit
 *
 * INPUT:
 * - prompt: User's message text
 * - session_id: Current session identifier
 * - transcript_path: Path to conversation transcript
 *
 * OUTPUT:
 * - stdout: None (no context injection)
 * - exit(0): Normal completion
 *
 * SIDE EFFECTS:
 * - Writes to: MEMORY/LEARNING/SIGNALS/ratings.jsonl
 * - Writes to: MEMORY/LEARNING/<category>/<YYYY-MM>/*.md (for low ratings)
 * - Triggers: TrendingAnalysis.ts update (fire-and-forget)
 *
 * INTER-HOOK RELATIONSHIPS:
 * - DEPENDS ON: None
 * - COORDINATES WITH: SessionRatingCapture (shares ratings.jsonl; that hook
 *   infers a teardown rating only when no explicit one was captured).
 *   ImplicitSentimentCapture, the old coordination partner, was deleted
 *   2026-07-03 (de-registered April 2026).
 * - MUST RUN AFTER: None
 *
 * COORDINATION PROTOCOL:
 * Both ExplicitRatingCapture and ImplicitSentimentCapture write to ratings.jsonl.
 * ImplicitSentimentCapture checks isExplicitRating() first and defers if true.
 * This hook runs FIRST to capture explicit "8 - great work" style ratings.
 *
 * ERROR HANDLING:
 * - Invalid input: Exits gracefully
 * - Write failures: Logged to stderr, exits gracefully
 *
 * PERFORMANCE:
 * - Non-blocking: Yes
 * - Typical execution: <50ms
 * - No external API calls
 *
 * LOW-RATING LEARNING CATEGORY (S8, let-the-model-speak — REMOVED
 * getLearningCategory() regex classifier, 2026-07):
 * This hook writes category `UNCATEGORIZED` (from lib/core/LearningJudgment.ts,
 * the same shared literal hooks/WorkCompletionLearning.hook.ts uses — see
 * that file's "LEARNING CATEGORIES" docblock and docs/decisions/015), not
 * SYSTEM/ALGORITHM, and does NOT call an LLM to guess. Rationale: this is a
 * synchronous UserPromptSubmit hook with a documented <50ms budget and zero
 * external API calls today — adding a per-turn inference call here just to
 * assign a category would both blow that budget on every single low-rating
 * turn AND reintroduce exactly the kind of ungrounded per-turn guess this
 * slice eliminated (a model call standing in for the old regex, judging a
 * few hundred characters of context with none of the full-session evidence
 * hooks/SessionRatingCapture.hook.ts's one per-session call has). A later
 * synthesis pass over MEMORY/LEARNING/UNCATEGORIZED/ can re-categorize if
 * needed.
 *
 * RATING PATTERNS:
 * - "7" → rating 7, no comment
 * - "8 - good work" → rating 8, comment "good work"
 * - "6: needs improvement" → rating 6, comment "needs improvement"
 * - "9 excellent" → rating 9, comment "excellent"
 * - "10!" → rating 10, no comment
 *
 * NON-RATING PATTERNS (ignored):
 * - "3 items" → Not a rating (followed by unit)
 * - "5 things to fix" → Not a rating (sentence continuation)
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { createAppendLog } from '../lib/core/AppendLog.ts';
import { join } from 'path';
import { UNCATEGORIZED } from '../lib/core/LearningJudgment.ts';
import { getPrincipalName } from './lib/identity';
import { getISOTimestamp, getPSTComponents } from './lib/time';
import { captureFailure, captureFailureDump } from '../lib/core/FailureCapture';
import { readHookInput } from '../lib/hook-utils';
import { parseRating } from '../lib/core/RatingUtils';
import { acquireRatingsLock } from './lib/ratings-lock';
import { ExplicitHookRatingSchema } from '../lib/core/LearningEntrySchema';
import { getKayaHome } from '../lib/core/KayaHome.ts';

/**
 * Check if failure dumps are enabled in settings.json.
 * Defaults to true if setting is missing.
 */
function isFailureDumpsEnabled(): boolean {
  const baseDir = getKayaHome();
  const settingsPath = join(baseDir, 'settings.json');
  if (!existsSync(settingsPath)) return true;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // If failures key exists and enabled is explicitly false, disable
    if (settings.failures && settings.failures.enabled === false) return false;
    return true;
  } catch {
    return true;
  }
}

interface HookInput {
  session_id: string;
  prompt: string;
  transcript_path: string;
  hook_event_name: string;
}

interface RatingEntry {
  timestamp: string;
  rating: number;
  comment?: string;
  session_id: string;
}

// parseRating imported from lib/core/RatingUtils.ts

/**
 * Write rating to ratings.jsonl
 * NOTE: Ratings are now stored in LEARNING/SIGNALS/ (consolidated from separate SIGNALS/)
 *
 * Schema-parsed before append (construction-time guarantee, ISC S6b) — the
 * original `entry` object is what's actually serialized, so a successful
 * parse never changes what gets written.
 */
function writeRating(entry: RatingEntry): void {
  ExplicitHookRatingSchema.parse(entry);

  const baseDir = getKayaHome();
  const ratingsFile = join(baseDir, 'MEMORY', 'LEARNING', 'SIGNALS', 'ratings.jsonl');

  // S15: append-log seam (dir creation + rotation owned by AppendLog).
  createAppendLog(ratingsFile).append(entry);

  console.error(`[ExplicitRatingCapture] Wrote rating ${entry.rating} to ${ratingsFile}`);
}

/**
 * Extract last response summary from transcript for learning context
 */
function getLastResponseSummary(transcriptPath: string): string {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return '';

    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n');

    let lastAssistant = '';
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'assistant' && entry.message?.content) {
          const text = typeof entry.message.content === 'string'
            ? entry.message.content
            : Array.isArray(entry.message.content)
              ? entry.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ')
              : '';
          if (text) lastAssistant = text;
        }
      } catch (err) {
        // skip invalid lines
        console.error(`[ExplicitRatingCapture] malformed transcript line skipped while extracting last response: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const summaryMatch = lastAssistant.match(/SUMMARY:\s*([^\n]+)/i);
    return summaryMatch ? summaryMatch[1].trim() : lastAssistant.slice(0, 500);
  } catch {
    return '';
  }
}

/**
 * Capture low rating as learning opportunity
 */
function captureLowRatingLearning(rating: number, comment: string | undefined, responseContext: string): void {
  if (rating >= 6) return;

  const baseDir = getKayaHome();
  const { year, month, day, hours, minutes, seconds } = getPSTComponents();

  const yearMonth = `${year}-${month}`;
  // S8: deferred category, not a regex/LLM guess — see the "LOW-RATING
  // LEARNING CATEGORY" docblock above.
  const category = UNCATEGORIZED;
  const learningsDir = join(baseDir, 'MEMORY', 'LEARNING', category, yearMonth);

  if (!existsSync(learningsDir)) {
    mkdirSync(learningsDir, { recursive: true });
  }

  const filename = `${year}-${month}-${day}-${hours}${minutes}${seconds}_LEARNING_low-rating-${rating}.md`;
  const filepath = join(learningsDir, filename);

  const content = `---
capture_type: LEARNING
timestamp: ${year}-${month}-${day} ${hours}:${minutes}:${seconds} PST
rating: ${rating}
auto_captured: true
tags: [low-rating, improvement-opportunity]
category: ${category}
---

# Low Rating Captured: ${rating}/10

**Date:** ${year}-${month}-${day}
**Rating:** ${rating}/10
**Category:** ${category}
${comment ? `**Feedback:** ${comment}` : ''}

---

## Response Context

${responseContext || 'No response context available'}

---

## Improvement Notes

This response was rated ${rating}/10 by ${getPrincipalName()}. Use this as an improvement opportunity.

${comment ? `**${getPrincipalName()}'s feedback:** ${comment}` : ''}

---
`;

  writeFileSync(filepath, content, 'utf-8');
  console.error(`[ExplicitRatingCapture] Captured low rating learning to ${filepath}`);
}

async function main() {
  try {
    console.error('[ExplicitRatingCapture] Hook started');
    const data = await readHookInput<HookInput>();
    const prompt = data?.prompt || '';

    const result = parseRating(prompt);

    if (!result) {
      console.error('[ExplicitRatingCapture] Not a rating, exiting');
      process.exit(0);
    }

    console.error(`[ExplicitRatingCapture] Detected rating: ${result.rating}${result.comment ? ` - ${result.comment}` : ''}`);

    const entry: RatingEntry = {
      timestamp: getISOTimestamp(),
      rating: result.rating,
      session_id: data.session_id,
    };
    if (result.comment) {
      entry.comment = result.comment;
    }

    const releaseLock = await acquireRatingsLock();
    try {
      writeRating(entry);
    } finally {
      releaseLock();
    }

    // Update trending analysis cache (fire-and-forget, don't block)
    const baseDir = getKayaHome();
    const trendingScript = join(baseDir, 'tools', 'TrendingAnalysis.ts');
    if (existsSync(trendingScript)) {
      Bun.spawn(['bun', trendingScript, '--force'], {
        stdout: 'ignore',
        stderr: 'ignore'
      });
      console.error('[ExplicitRatingCapture] Triggered TrendingAnalysis update');
    }

    if (result.rating < 6) {
      const responseContext = getLastResponseSummary(data.transcript_path);
      captureLowRatingLearning(result.rating, result.comment, responseContext);

      // For ratings 1-3, also create full failure capture
      if (result.rating <= 3) {
        try {
          await captureFailure({
            transcriptPath: data.transcript_path,
            rating: result.rating,
            sentimentSummary: result.comment || `Explicit low rating: ${result.rating}/10`,
            detailedContext: responseContext,
            sessionId: data.session_id,
          });
          console.error(`[ExplicitRatingCapture] Created full failure capture for rating ${result.rating}`);
        } catch (err) {
          console.error(`[ExplicitRatingCapture] Error creating failure capture: ${err}`);
        }

        // Additionally create structured 3-file failure dump package (ISC 8120, 8740)
        // Only if failures.enabled !== false in settings
        if (isFailureDumpsEnabled()) {
          // Fire-and-forget: non-blocking, async (ISC 3634)
          captureFailureDump({
            sessionId: data.session_id,
            transcriptPath: data.transcript_path,
            rating: result.rating,
            comment: result.comment,
          }).then(packageDir => {
            console.error(`[ExplicitRatingCapture] Failure dump package created: ${packageDir}`);
          }).catch(err => {
            console.error(`[ExplicitRatingCapture] Failure dump error (non-fatal): ${err}`);
          });
        } else {
          console.error('[ExplicitRatingCapture] Failure dumps disabled via settings.failures.enabled=false');
        }
      }
      // Ratings 4-10: no failure dump created (ISC 9240)
    }

    console.error('[ExplicitRatingCapture] Done');
    process.exit(0);
  } catch (err) {
    console.error(`[ExplicitRatingCapture] Error: ${err}`);
    process.exit(0);
  }
}

if (import.meta.main) {
  main();
}
