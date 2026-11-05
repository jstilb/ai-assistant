/**
 * ratings-lock.ts - Advisory file lock for ratings.jsonl coordination
 *
 * Provides mutual exclusion between ExplicitRatingRecord and ImplicitSentimentCapture
 * when writing to ratings.jsonl. Uses a .lock file as an advisory lock.
 */

import { kayaPath } from "./paths.ts";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";

const LOCK_TIMEOUT_MS = 2000;

/**
 * Acquire advisory lock on ratings.jsonl.
 * Returns a release function — always call it (in a finally block).
 */
export async function acquireRatingsLock(): Promise<() => void> {
  const lockFile = kayaPath("MEMORY", "LEARNING", "SIGNALS", "ratings.jsonl.lock");
  const start = Date.now();

  while (existsSync(lockFile)) {
    if (Date.now() - start > LOCK_TIMEOUT_MS) {
      console.error("[ratings-lock] Lock timeout — proceeding anyway");
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }

  try {
    writeFileSync(lockFile, process.pid.toString(), { flag: "wx" });
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
