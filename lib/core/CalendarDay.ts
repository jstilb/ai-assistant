/**
 * CalendarDay — pure YYYY-MM-DD calendar-day helpers.
 *
 * Day arithmetic is UTC-anchored (each day = its UTC midnight) so DST changes
 * never shift a count by an hour/day. todayISO() reads the LOCAL calendar day.
 *
 * Shared by Adventure's TripTracker and Cooking's FermentationTracker
 * (formerly two copies).
 */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Today's calendar day in the local timezone, YYYY-MM-DD. */
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Parse a YYYY-MM-DD string to UTC-midnight epoch ms (calendar-day anchor). */
export function dayToUtcMs(iso: string): number {
  const parts = iso.split("-").map(Number);
  const y = parts[0]!;
  const m = parts[1]!;
  const d = parts[2]!;
  return Date.UTC(y, m - 1, d);
}

/** Whole days from `a` to `b` (b − a); negative if b is before a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((dayToUtcMs(b) - dayToUtcMs(a)) / 86_400_000);
}

/** Add `n` days to a YYYY-MM-DD string, returning YYYY-MM-DD. */
export function addDays(iso: string, n: number): string {
  return new Date(dayToUtcMs(iso) + n * 86_400_000).toISOString().slice(0, 10);
}

/** True for a well-formed, real YYYY-MM-DD calendar day (rejects 2026-02-30). */
export function isValidDay(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  return new Date(dayToUtcMs(iso)).toISOString().slice(0, 10) === iso;
}
