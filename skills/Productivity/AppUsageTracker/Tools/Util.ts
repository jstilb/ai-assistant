/**
 * Util.ts — small, pure helpers shared by AppUsageTracker tools.
 *
 * The date helpers explicitly anchor on CONFIG.localTimezone via
 * Intl.DateTimeFormat. The earlier per-file copies relied on
 * `new Date().getFullYear()/getMonth()/getDate()` which reads the process's
 * local timezone — fine in an interactive shell, but launchd cron jobs that
 * inherit a minimal env (no `TZ`) can compute the wrong calendar date.
 */

import { CONFIG } from "../Config.ts";

const DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: CONFIG.localTimezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Return today's local date as `YYYY-MM-DD`, computed in CONFIG.localTimezone.
 * Stable regardless of the process `TZ` env var.
 */
export function todayLocal(): string {
  return DATE_FMT.format(new Date());
}

/**
 * Return yesterday's local date as `YYYY-MM-DD`.
 */
export function yesterdayLocal(): string {
  return shiftDate(todayLocal(), -1);
}

/**
 * Shift a `YYYY-MM-DD` date by N days (positive or negative). Operates on
 * the calendar date string — no timezone shenanigans, just integer math.
 */
export function shiftDate(date: string, days: number): string {
  // Anchor at noon UTC so DST transitions (which occur at 2am) can't drag
  // the date across a boundary when we add/subtract days.
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return DATE_FMT.format(d);
}

/**
 * Inclusive list of `YYYY-MM-DD` dates from `start` to `end`.
 */
export function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    cur = shiftDate(cur, 1);
  }
  return out;
}
