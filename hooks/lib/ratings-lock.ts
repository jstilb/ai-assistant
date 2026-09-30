/**
 * ratings-lock.ts - Advisory file lock for ratings.jsonl coordination
 *
 * Provides mutual exclusion between ExplicitRatingCapture and ImplicitSentimentCapture
 * when writing to ratings.jsonl. Uses a .lock file as an advisory lock.
 */

import { kayaPath } from './paths';
import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'fs';

const LOCK_TIMEOUT_MS = 2000;

/**
 * Acquire advisory lock on ratings.jsonl.
 * Returns a release function — always call it (in a finally block).
 */
export async function acquireRatingsLock(): Promise<() => void> {
  const lockFile = kayaPath('MEMORY', 'LEARNING', 'SIGNALS', 'ratings.jsonl.lock');
  const start = Date.now();

  while (existsSync(lockFile)) {
    if (Date.now() - start > LOCK_TIMEOUT_MS) {
      console.error('[ratings-lock] Lock timeout — proceeding anyway');
      break;
    }
    await new Promise(r => setTimeout(r, 10));
  }

  try {
    writeFileSync(lockFile, process.pid.toString(), { flag: 'wx' });
  } catch {
    // intentionally silent: another process winning the create-lock race is
    // the expected, designed outcome under normal concurrent use (advisory,
    // not mandatory) — breadcrumbing every contended acquire would be noise
  }

  return () => {
    try {
      unlinkSync(lockFile);
    } catch {
      // intentionally silent: idempotent release — the lock already being
      // gone (another process released it, or it was never created) is the
      // normal case, not a failure worth surfacing
    }
  };
}

/**
 * Check if a rating for the given session_id already exists in ratings.jsonl.
 * Used by ImplicitSentimentCapture to skip if ExplicitRatingCapture already wrote.
 */
export function sessionHasRating(sessionId: string): boolean {
  try {
    const ratingsPath = kayaPath('MEMORY', 'LEARNING', 'SIGNALS', 'ratings.jsonl');
    if (!existsSync(ratingsPath)) return false;
    const content = readFileSync(ratingsPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean).slice(-20);
    return lines.some(line => {
      try {
        const entry = JSON.parse(line);
        return entry.session_id === sessionId;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
