/**
 * CronMatch.ts — the ONE cron-expression matcher shared by run-cron-job.ts
 * and job-reconciler.ts.
 *
 * `matchesField`, `matchesCronExact`, `matchesCron`, and `findMatchedSlot`
 * were originally local functions in bin/run-cron-job.ts (they defensively
 * re-validate a launchd fire against the job's cron expression before
 * running it). This module moves them here VERBATIM (same local-time
 * semantics, same slack behavior) so bin/job-reconciler.ts's S2 due-slot
 * policy can share the exact same matcher instead of writing a second one.
 *
 * That "instead of" is load-bearing history, not style preference: B2
 * (commit 296e458c4) deleted an EARLIER reconciler-local cron-slot walker
 * (also confusingly named `mostRecentDueSlot`) precisely because it matched
 * in UTC (`getUTCMinutes`/`getUTCHours`/...) while this module's
 * `findMatchedSlot` matches in LOCAL time (`getMinutes`/`getHours`/...). The
 * two clocks never converged — the reconciler could conclude a slot was
 * "due" hours away from when run-cron-job.ts itself would ever agree the
 * same slot was due, so the reconciler looped forever re-deciding "run" for
 * jobs run-cron-job.ts considered on-schedule (or vice versa, near a DST
 * boundary). B2's fix was to delete the second implementation outright
 * rather than reconcile the two clocks. S2 reintroduces a "when is this job
 * next/last due" need (see bin/job-reconciler.ts's module doc), so this
 * time the fix is structural: ONE matcher, shared, imported by both call
 * sites, so a future edit to matching semantics can't silently diverge
 * again.
 *
 * Every function below is pure — zero I/O, zero wall-clock reads (all time
 * comes from the `now` parameter) — and matches in the JS `Date` object's
 * LOCAL time zone by design (the same zone bun/launchd resolves `Date`
 * field getters against on this machine), not UTC.
 */

/**
 * Does a single cron field expression match a numeric value? Supports `*`,
 * step values (e.g. `*` followed by `/n`), comma lists (`1,3,5`), ranges
 * (`1-5`), and bare exact values.
 */
export function matchesField(expr: string, value: number): boolean {
  if (expr === '*') return true;
  if (expr.startsWith('*/')) {
    const step = parseInt(expr.slice(2), 10);
    return Number.isFinite(step) && step > 0 && value % step === 0;
  }
  if (expr.includes(',')) {
    return expr.split(',').map(s => parseInt(s, 10)).includes(value);
  }
  if (expr.includes('-')) {
    const [lo, hi] = expr.split('-').map(s => parseInt(s, 10));
    return value >= lo! && value <= hi!;
  }
  return parseInt(expr, 10) === value;
}

/** Does the 5-field cron expression match `now` EXACTLY (to the minute), in local time? */
export function matchesCronExact(expr: string, now: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [m, h, dom, mo, dow] = parts;
  return (
    matchesField(m!, now.getMinutes()) &&
    matchesField(h!, now.getHours()) &&
    matchesField(dom!, now.getDate()) &&
    matchesField(mo!, now.getMonth() + 1) &&
    matchesField(dow!, now.getDay())
  );
}

/**
 * Match a cron expression against `now` with up to `slackMinutes` of lateness.
 * launchd can fire several minutes late after wake-from-sleep — strict
 * minute-equality rejected those legitimate fires (May 7, 8, 9, 10, 13).
 * Walk backwards minute-by-minute up to slackMinutes; if any matches, accept.
 * Still catches wrong-day fires (the original "first Friday" guard intent).
 */
export function matchesCron(expr: string, now: Date, slackMinutes: number = 30): boolean {
  return findMatchedSlot(expr, now, slackMinutes) !== null;
}

/**
 * Same walk-backwards logic as matchesCron, but returns the actual matched
 * slot Date (minute-truncated) instead of a boolean. Used to derive a stable
 * RunLedger.computeSlotKey() for idempotency — the slot a launchd fire
 * "satisfies" is the minute it matched against, not the (possibly late)
 * wall-clock time the wrapper actually ran at.
 */
export function findMatchedSlot(expr: string, now: Date, slackMinutes: number = 30): Date | null {
  for (let offset = 0; offset <= slackMinutes; offset++) {
    const t = new Date(now.getTime() - offset * 60_000);
    t.setSeconds(0, 0);
    if (matchesCronExact(expr, t)) return t;
  }
  return null;
}

/**
 * Walk backward minute-by-minute from `now` (minute-truncated) and return
 * the most recent Date at-or-before `now` that matches the 5-field cron
 * expression, or null if nothing matches within `lookbackDays` (default 45)
 * or the expression is malformed (wrong field count).
 *
 * Unlike `findMatchedSlot` (bounded to ~30 minutes of launchd-lateness
 * slack, answering "did a slot fire recently enough that THIS invocation
 * satisfies it?"), `mostRecentDueSlot` answers a different question at a
 * much wider lookback: "as of `now`, which calendar slot is the job's
 * schedule most recently due for?" — used by bin/job-reconciler.ts to know
 * which dated artifact (today's vs. yesterday's `{date}`-templated path)
 * SHOULD exist yet, independent of whether any invocation has actually run.
 *
 * Local-time by design, matching `findMatchedSlot` — see module doc for why
 * a second, UTC-matching implementation of this exact idea was deleted in
 * B2 and must not be reintroduced.
 *
 * The 5-field split is hoisted out of the loop (cheap for `findMatchedSlot`'s
 * ~30-iteration slack window, but `lookbackDays` here can mean tens of
 * thousands of iterations, so re-splitting the expression string on every
 * single minute would be wasteful).
 */
export function mostRecentDueSlot(expr: string, now: Date, lookbackDays: number = 45): Date | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mo, dow] = parts as [string, string, string, string, string];

  const truncatedNow = new Date(now.getTime());
  truncatedNow.setSeconds(0, 0);

  const lookbackMinutes = lookbackDays * 24 * 60;
  for (let offset = 0; offset <= lookbackMinutes; offset++) {
    const t = new Date(truncatedNow.getTime() - offset * 60_000);
    if (
      matchesField(m, t.getMinutes()) &&
      matchesField(h, t.getHours()) &&
      matchesField(dom, t.getDate()) &&
      matchesField(mo, t.getMonth() + 1) &&
      matchesField(dow, t.getDay())
    ) {
      return t;
    }
  }
  return null;
}
